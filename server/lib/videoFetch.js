'use strict';

/**
 * Video acquisition for "영상 → 장면 스토리보드".
 *
 * The browser does the actual scene detection (it can decode video natively),
 * but it can only read pixels from same-origin media.  So this module brings
 * a video *to the server* first:
 *
 *   - direct media URLs (…/clip.mp4)        → streamed download (fetch)
 *   - YouTube / Vimeo / any yt-dlp site      → yt-dlp subprocess (optional
 *                                              dependency, never bundled)
 *
 * Files land in a cache directory (VIDEO_CACHE_DIR, default <tmp>/storyboarder-next/video-cache)
 * served at /cache/video/<job>/<file>.  They are NOT part of a project unless
 * the user later asks to keep the video as a project asset.  Each download is a
 * job (202 + polling) because big files take a while and proxies time out.
 *
 * Nothing here is required for the rest of the app: without yt-dlp the route
 * explains how to install it and the UI still accepts local files.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseYouTube, parseVimeo, isPrivateHost } = require('./linkPreview');
const analysisImport = require('./analysisImport');

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);
const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // cache entries live 6 h
const MAX_CONCURRENT = 2;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ urls */

/** @returns {{kind:'youtube'|'vimeo'|'direct'|'page', url:URL, id?:string, start?:number}} */
function classifyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new HttpError(400, 'invalid url');
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'only http(s) urls are supported');
  if (isPrivateHost(url.hostname) && process.env.VIDEO_FETCH_ALLOW_PRIVATE !== '1') throw new HttpError(400, 'private hosts are not allowed');
  const yt = parseYouTube(url);
  if (yt) return { kind: 'youtube', url, id: yt.id, start: yt.start };
  const vm = parseVimeo(url);
  if (vm) return { kind: 'vimeo', url, id: vm.id };
  const ext = url.pathname.split('.').pop().toLowerCase();
  if (url.pathname.includes('.') && VIDEO_EXT.has(ext)) return { kind: 'direct', url, ext };
  return { kind: 'page', url };
}

/* --------------------------------------------------------------- binaries */

const binCache = new Map();

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a binary from an env override, then PATH (+ a few usual user dirs). */
function findBinary(envName, names) {
  const key = `${envName}:${names.join(',')}`;
  const cached = binCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  let value = null;
  const explicit = process.env[envName];
  if (explicit && isExecutable(explicit)) value = explicit;
  if (!value) {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    dirs.push(path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    outer: for (const dir of dirs) {
      for (const name of names) {
        for (const ext of exts) {
          const candidate = path.join(dir, name + ext);
          if (isExecutable(candidate)) {
            value = candidate;
            break outer;
          }
        }
      }
    }
  }
  binCache.set(key, { at: Date.now(), value });
  return value;
}

function run(bin, args, { timeoutMs = 60000, onLine, cwd, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    if (onSpawn) onSpawn(proc);
    let out = '';
    let errOut = '';
    let buf = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new HttpError(504, `${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (onLine) {
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        for (const l of lines) onLine(l);
      }
    });
    proc.stderr.on('data', (d) => {
      errOut += d.toString();
      if (errOut.length > 20000) errOut = errOut.slice(-20000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new HttpError(501, `${path.basename(bin)} could not be started (${err.message})`) : err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && buf) onLine(buf);
      resolve({ code, out, err: errOut });
    });
  });
}

let capCache = null;
async function capabilities({ force = false } = {}) {
  if (capCache && !force && Date.now() - capCache.at < 60000) return capCache.value;
  const ytdlp = findBinary('YTDLP_PATH', ['yt-dlp', 'yt-dlp_x86', 'youtube-dl']);
  const ffmpeg = findBinary('FFMPEG_PATH', ['ffmpeg']);
  const value = { ytdlp: { available: !!ytdlp, path: ytdlp, version: null }, ffmpeg: { available: !!ffmpeg, path: ffmpeg }, maxMb: maxVideoBytes() / 1024 / 1024 };
  if (ytdlp) {
    try {
      const r = await run(ytdlp, ['--version'], { timeoutMs: 8000 });
      value.ytdlp.version = r.out.trim().split('\n')[0] || null;
    } catch {
      /* ignore */
    }
  }
  capCache = { at: Date.now(), value };
  return value;
}

function maxVideoBytes() {
  const mb = Number(process.env.VIDEO_MAX_MB) || 1024;
  return Math.max(1, mb) * 1024 * 1024;
}

function cacheRoot() {
  return process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'storyboarder-next', 'video-cache');
}

/* ------------------------------------------------------------------- jobs */

const jobs = new Map();
let running = 0;

function newJobId() {
  return `vj${crypto.randomBytes(6).toString('hex')}`;
}

function publicJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    url: job.url,
    kind: job.kind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    info: job.info || null,
    result: job.status === 'done' ? job.result : null,
    error: job.error || null,
  };
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

/** Internal: where the finished file lives on disk (used when the user keeps the video). */
function jobFile(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'done' || !job.result) return null;
  return { file: job.result.file, name: job.result.name, mime: job.result.mime, size: job.result.size, info: job.result.info };
}

function gcJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS && job.status !== 'running') {
      jobs.delete(id);
      fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.proc && job.status === 'running') {
    try {
      job.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  jobs.delete(id);
  await fsp.rm(job.dir, { recursive: true, force: true });
  return true;
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

/**
 * Start a download job. Resolves immediately with the public job view; the
 * work continues in the background.  `opts.fetchImpl` / `opts.ytdlpPath` exist
 * for tests.
 */
async function startFetch({ projectId, url: rawUrl, quality = '720' }, opts = {}) {
  const cls = classifyUrl(rawUrl);
  gcJobs();
  if (running >= MAX_CONCURRENT) throw new HttpError(429, 'too many downloads running, try again in a moment');
  const id = newJobId();
  const dir = path.join(cacheRoot(), id);
  await fsp.mkdir(dir, { recursive: true });
  const job = {
    id,
    projectId,
    url: cls.url.toString(),
    kind: cls.kind,
    dir,
    status: 'running',
    stage: 'starting',
    progress: 0,
    message: '',
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    proc: null,
  };
  jobs.set(id, job);
  running++;
  (async () => {
    try {
      const result = cls.kind === 'direct'
        ? await downloadDirect(job, cls, opts)
        : await downloadWithYtDlp(job, cls, { quality, ...opts });
      update(job, { status: 'done', stage: 'done', progress: 100, result, message: '' });
    } catch (err) {
      update(job, { status: 'error', stage: 'error', error: err.message, errorStatus: err.status || 500 });
      // keep the directory for debugging only briefly
    } finally {
      running--;
      job.proc = null;
    }
  })();
  return publicJob(job);
}

/* --------------------------------------------------------- direct download */

async function downloadDirect(job, cls, { fetchImpl = fetch, timeoutMs = 20 * 60 * 1000 } = {}) {
  update(job, { stage: 'downloading', message: '파일 내려받는 중' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const limit = maxVideoBytes();
  try {
    const r = await fetchImpl(cls.url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; StoryboarderNext/1.0)', accept: 'video/*,*/*;q=0.5' } });
    if (!r.ok) throw new HttpError(502, `download failed: HTTP ${r.status}`);
    const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || VIDEO_MIME[cls.ext] || 'video/mp4';
    if (!/^video\//.test(mime) && !/^application\/octet-stream$/.test(mime)) throw new HttpError(415, `not a video (${mime})`);
    const total = Number(r.headers.get('content-length') || 0);
    if (total > limit) throw new HttpError(413, `remote file too large (${Math.round(total / 1024 / 1024)} MB > ${Math.round(limit / 1024 / 1024)} MB)`);
    const name = `video.${cls.ext}`;
    const file = path.join(job.dir, name);
    let received = 0;
    const ws = fs.createWriteStream(file);
    try {
      for await (const chunk of r.body) {
        received += chunk.length;
        if (received > limit) throw new HttpError(413, 'remote file too large');
        if (!ws.write(chunk)) await new Promise((res) => ws.once('drain', res));
        if (total) update(job, { progress: Math.min(99, Math.round((received / total) * 100)) });
      }
    } finally {
      await new Promise((res) => ws.end(res));
    }
    const finalMime = /^video\//.test(mime) ? mime : VIDEO_MIME[cls.ext] || 'video/mp4';
    return finishResult(job, { file, name, mime: finalMime, size: received, info: { title: decodeURIComponent(cls.url.pathname.split('/').pop() || 'video'), webpage_url: cls.url.toString() }, transcript: [], subtitlesLang: null });
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- yt-dlp */

function formatSelector(quality, hasFfmpeg) {
  const h = Number(quality) || 720;
  if (hasFfmpeg) {
    // h264 mp4 first (plays everywhere), then anything up to the requested height
    return `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  }
  // without ffmpeg nothing can be merged → progressive streams only
  return `b[height<=${h}][ext=mp4]/b[ext=mp4]/b[height<=${h}]/b`;
}

function pickSubtitleLangs(info, preferred = ['ko', 'en']) {
  const manual = Object.keys(info.subtitles || {});
  const auto = Object.keys(info.automatic_captions || {});
  const pick = (pool) => {
    const out = [];
    for (const p of preferred) {
      const hit = pool.find((l) => l === p) || pool.find((l) => l.startsWith(`${p}-`) || l.startsWith(`${p}_`));
      if (hit) out.push(hit);
    }
    return out;
  };
  const m = pick(manual);
  if (m.length) return { langs: m, auto: false };
  const a = pick(auto.filter((l) => !/orig$/.test(l)));
  if (a.length) return { langs: a, auto: true };
  return { langs: [], auto: false };
}

function parseProgressLine(line) {
  const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:.*?at\s+([\d.]+\w+\/s))?(?:.*?ETA\s+([\d:]+))?/.exec(line);
  if (!m) return null;
  return { percent: Number(m[1]), size: m[2] || null, speed: m[3] || null, eta: m[4] || null };
}

async function downloadWithYtDlp(job, cls, { quality = '720', ytdlpPath, ffmpegPath, timeoutMs = 30 * 60 * 1000 } = {}) {
  const caps = await capabilities();
  const ytdlp = ytdlpPath ? (isExecutable(ytdlpPath) ? ytdlpPath : null) : caps.ytdlp.path;
  const ffmpeg = ffmpegPath === null ? null : ffmpegPath || caps.ffmpeg.path;
  if (!ytdlp) {
    throw new HttpError(501, 'yt-dlp is not installed — YouTube/Vimeo 등 페이지 주소를 내려받으려면 서버에 yt-dlp 가 필요합니다 (pip install yt-dlp 또는 YTDLP_PATH 설정). 직접 파일을 드롭하거나 .mp4 주소를 쓰면 yt-dlp 없이도 됩니다.', { hint: 'install-ytdlp' });
  }
  const url = cls.url.toString();
  const common = ['--no-playlist', '--no-warnings', '--no-colors', '--no-call-home', '--no-cache-dir', '--socket-timeout', '30'];
  if (ffmpeg) common.push('--ffmpeg-location', ffmpeg);
  // 1) metadata
  update(job, { stage: 'metadata', message: '영상 정보 읽는 중' });
  const meta = await run(ytdlp, [...common, '-J', url], { timeoutMs: 90000, cwd: job.dir, onSpawn: (p) => { job.proc = p; } });
  if (meta.code !== 0) throw new HttpError(502, `yt-dlp: ${lastLine(meta.err) || 'could not read video info'}`);
  let info;
  try {
    info = JSON.parse(meta.out);
  } catch {
    throw new HttpError(502, 'yt-dlp returned unreadable metadata');
  }
  if (info._type === 'playlist' && Array.isArray(info.entries) && info.entries.length) info = info.entries[0];
  const limit = maxVideoBytes();
  const subs = pickSubtitleLangs(info);
  // 2) download
  update(job, { stage: 'downloading', message: `내려받는 중 — ${info.title || info.id || ''}`.trim(), info: publicInfo(info) });
  const args = [
    ...common,
    '--newline', '--progress',
    '-f', formatSelector(quality, !!ffmpeg),
    '--max-filesize', `${Math.floor(limit / 1024 / 1024)}m`,
    '-o', path.join(job.dir, 'video.%(ext)s'),
  ];
  if (ffmpeg) args.push('--merge-output-format', 'mp4');
  if (subs.langs.length) {
    args.push(subs.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', subs.langs.join(','), '--sub-format', 'vtt/best');
    if (ffmpeg) args.push('--convert-subs', 'vtt'); // conversion needs ffmpeg
  }
  args.push(url);
  const dl = await run(ytdlp, args, {
    timeoutMs,
    cwd: job.dir,
    onSpawn: (p) => { job.proc = p; },
    onLine: (line) => {
      const p = parseProgressLine(line);
      if (p) update(job, { progress: Math.min(99, Math.round(p.percent)), message: `내려받는 중 ${p.percent.toFixed(0)}%${p.size ? ` / ${p.size}` : ''}${p.speed ? ` · ${p.speed}` : ''}${p.eta ? ` · 남은 시간 ${p.eta}` : ''}` });
      else if (/^\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8|SubtitlesConvertor)\]/.test(line)) update(job, { stage: 'processing', message: line.slice(0, 120) });
    },
  });
  job.proc = null;
  const files = await fsp.readdir(job.dir);
  const videoName = files.find((f) => /^video\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(f));
  if (dl.code !== 0 || !videoName) {
    const tail = lastLine(dl.err) || lastLine(dl.out);
    if (/larger than max-filesize/i.test(dl.out + dl.err)) throw new HttpError(413, `영상이 너무 큽니다 (한도 ${Math.floor(limit / 1024 / 1024)} MB, VIDEO_MAX_MB 로 조정)`);
    throw new HttpError(502, `yt-dlp download failed: ${tail || `exit ${dl.code}`}`);
  }
  const file = path.join(job.dir, videoName);
  const size = (await fsp.stat(file)).size;
  const ext = videoName.split('.').pop().toLowerCase();
  // subtitles → transcript segments (first preferred language that exists)
  let transcript = [];
  let subtitlesLang = null;
  for (const lang of subs.langs) {
    const sub = files.find((f) => f === `video.${lang}.vtt`) || files.find((f) => f.startsWith(`video.${lang}`) && /\.(vtt|srt)$/.test(f));
    if (!sub) continue;
    try {
      const text = await fsp.readFile(path.join(job.dir, sub), 'utf8');
      const parsed = analysisImport.parse(text);
      transcript = dedupeAutoCaptions(parsed.transcript || []);
      subtitlesLang = lang;
      if (transcript.length) break;
    } catch {
      /* ignore bad subtitle files */
    }
  }
  return finishResult(job, { file, name: videoName, mime: VIDEO_MIME[ext] || 'video/mp4', size, info: publicInfo(info), transcript, subtitlesLang, subtitlesAuto: subs.auto });
}

/** YouTube auto captions repeat the growing line in overlapping cues — keep the longest unique text per start time. */
function dedupeAutoCaptions(segments) {
  const out = [];
  let prevText = '';
  for (const s of segments) {
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (prevText && (prevText.endsWith(text) || text.startsWith(prevText))) {
      // cumulative duplicate → extend the previous cue instead of adding a new one
      const last = out[out.length - 1];
      if (last) {
        last.end = Math.max(last.end ?? 0, s.end ?? 0);
        if (text.length > last.text.length) last.text = text;
        prevText = last.text;
        continue;
      }
    }
    out.push({ ...s, text });
    prevText = text;
  }
  return out;
}

function publicInfo(info) {
  if (!info) return {};
  return {
    id: info.id || null,
    title: info.title || '',
    uploader: info.uploader || info.channel || '',
    duration: Number(info.duration) || null,
    fps: Number(info.fps) || null,
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    webpage_url: info.webpage_url || info.original_url || '',
    thumbnail: info.thumbnail || '',
    extractor: info.extractor_key || info.extractor || '',
    chapters: Array.isArray(info.chapters) ? info.chapters.map((c) => ({ title: c.title || '', start: Number(c.start_time) || 0, end: Number(c.end_time) || 0 })) : [],
    description: String(info.description || '').slice(0, 2000),
  };
}

function lastLine(s) {
  const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].replace(/^ERROR:\s*/i, '').slice(0, 300) : '';
}

function finishResult(job, { file, name, mime, size, info, transcript, subtitlesLang, subtitlesAuto }) {
  return {
    file,
    name,
    mime,
    size,
    url: `/cache/video/${job.id}/${encodeURIComponent(name)}`,
    info: info || {},
    transcript: transcript || [],
    subtitlesLang: subtitlesLang || null,
    subtitlesAuto: !!subtitlesAuto,
    kind: job.kind,
    sourceUrl: job.url,
  };
}

module.exports = {
  classifyUrl,
  capabilities,
  startFetch,
  getJob,
  jobFile,
  removeJob,
  cacheRoot,
  maxVideoBytes,
  formatSelector,
  pickSubtitleLangs,
  parseProgressLine,
  dedupeAutoCaptions,
  findBinary,
  VIDEO_EXT,
  VIDEO_MIME,
  HttpError,
};
