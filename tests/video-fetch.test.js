'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const videoFetch = require('../server/lib/videoFetch');
const sceneImport = require('../server/lib/sceneImport');
const text = require('../server/lib/ai/providers/openaiText');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJob(id, timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    const j = videoFetch.getJob(id);
    if (j.status !== 'running') return j;
    if (Date.now() - t0 > timeout) throw new Error(`job ${id} still running: ${JSON.stringify(j)}`);
    await sleep(30);
  }
}

test('classifyUrl: youtube / vimeo / direct / page, rejects private + non-http', () => {
  assert.equal(videoFetch.classifyUrl('https://youtu.be/aqz-KE-bpKQ?t=30').kind, 'youtube');
  assert.equal(videoFetch.classifyUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ').id, 'aqz-KE-bpKQ');
  assert.equal(videoFetch.classifyUrl('https://vimeo.com/123456789').kind, 'vimeo');
  assert.equal(videoFetch.classifyUrl('https://cdn.example.com/a/clip.MP4?x=1').kind, 'direct');
  assert.equal(videoFetch.classifyUrl('https://cdn.example.com/a/clip.MP4?x=1').ext, 'mp4');
  assert.equal(videoFetch.classifyUrl('https://example.com/some/page').kind, 'page');
  assert.throws(() => videoFetch.classifyUrl('ftp://x/y.mp4'), /http/);
  assert.throws(() => videoFetch.classifyUrl('http://127.0.0.1/x.mp4'), /private/);
  assert.throws(() => videoFetch.classifyUrl('not a url'), /invalid/);
});

test('formatSelector / pickSubtitleLangs / parseProgressLine / dedupeAutoCaptions', () => {
  assert.match(videoFetch.formatSelector('720', true), /avc1/);
  assert.match(videoFetch.formatSelector('480', false), /^b\[height<=480\]\[ext=mp4\]/);
  assert.deepEqual(videoFetch.pickSubtitleLangs({ subtitles: { en: [], ko: [] }, automatic_captions: { ko: [] } }), { langs: ['ko', 'en'], auto: false });
  assert.deepEqual(videoFetch.pickSubtitleLangs({ subtitles: {}, automatic_captions: { 'en-orig': [], en: [], 'ko-KR': [] } }), { langs: ['ko-KR', 'en'], auto: true });
  assert.deepEqual(videoFetch.pickSubtitleLangs({}), { langs: [], auto: false });
  const p = videoFetch.parseProgressLine('[download]  42.3% of ~  120.50MiB at    2.10MiB/s ETA 00:33');
  assert.equal(p.percent, 42.3);
  assert.equal(p.size, '120.50MiB');
  assert.equal(p.eta, '00:33');
  assert.equal(videoFetch.parseProgressLine('[Merger] Merging formats'), null);
  const deduped = videoFetch.dedupeAutoCaptions([
    { start: 0, end: 1, text: '안녕하세요' },
    { start: 1, end: 2, text: '안녕하세요 반갑습니다' },
    { start: 2, end: 3, text: '반갑습니다' },
    { start: 3, end: 4, text: '오늘은' },
  ]);
  assert.deepEqual(deduped.map((d) => d.text), ['안녕하세요 반갑습니다', '오늘은']);
  assert.equal(deduped[0].end, 3);
});

test('startFetch: direct url streams to the cache with a size cap', async () => {
  process.env.VIDEO_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-vc-'));
  const bytes = Buffer.alloc(5000, 7);
  const fetchImpl = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
  const job = await videoFetch.startFetch({ projectId: 'p', url: 'https://cdn.example.com/clip.mp4' }, { fetchImpl });
  assert.equal(job.status, 'running');
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.result.size, 5000);
  assert.equal(done.result.mime, 'video/mp4');
  assert.match(done.result.url, new RegExp(`^/cache/video/${job.id}/video.mp4$`));
  assert.ok(fs.existsSync(done.result.file));
  const jf = videoFetch.jobFile(job.id);
  assert.equal(jf.size, 5000);
  // size cap
  const old = process.env.VIDEO_MAX_MB;
  process.env.VIDEO_MAX_MB = '0.001'; // → clamps to 1 MB in maxVideoBytes
  const big = Buffer.alloc(2 * 1024 * 1024);
  const fetchBig = async () => new Response(big, { status: 200, headers: { 'content-type': 'video/mp4' } });
  const j2 = await waitJob((await videoFetch.startFetch({ projectId: 'p', url: 'https://cdn.example.com/big.mp4' }, { fetchImpl: fetchBig })).id);
  assert.equal(j2.status, 'error');
  assert.match(j2.error, /too large/);
  process.env.VIDEO_MAX_MB = old || '';
  // not a video
  const fetchHtml = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const j3 = await waitJob((await videoFetch.startFetch({ projectId: 'p', url: 'https://cdn.example.com/x.mp4' }, { fetchImpl: fetchHtml })).id);
  assert.equal(j3.status, 'error');
  assert.match(j3.error, /not a video/);
  assert.equal(await videoFetch.removeJob(job.id), true);
  assert.equal(videoFetch.getJob(job.id), null);
});

test('startFetch: youtube via a fake yt-dlp (metadata, progress, subtitles → transcript)', async () => {
  process.env.VIDEO_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-vc-'));
  const fake = path.join(process.env.VIDEO_CACHE_DIR, 'fake-ytdlp.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2025.01.01'); process.exit(0); }
if (args.includes('-J')) {
  console.log(JSON.stringify({ id: 'aqz-KE-bpKQ', title: 'Fake Bunny', duration: 10, fps: 24, width: 1280, height: 720, webpage_url: args[args.length - 1], extractor_key: 'Youtube',
    subtitles: {}, automatic_captions: { en: [{ ext: 'vtt' }], ko: [{ ext: 'vtt' }] }, chapters: [{ title: 'Intro', start_time: 0, end_time: 5 }] }));
  process.exit(0);
}
const o = args[args.indexOf('-o') + 1];
const dir = path.dirname(o);
console.log('[download]  10.0% of 1.00MiB at 1.00MiB/s ETA 00:01');
console.log('[download] 100.0% of 1.00MiB at 1.00MiB/s ETA 00:00');
fs.writeFileSync(path.join(dir, 'video.mp4'), Buffer.alloc(1234, 1));
if (args.includes('--sub-langs')) fs.writeFileSync(path.join(dir, 'video.ko.vtt'), 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\n<v 나레이터>안녕하세요\\n\\n00:00:02.000 --> 00:00:04.000\\n안녕하세요 반갑습니다\\n');
process.exit(0);
`);
  fs.chmodSync(fake, 0o755);
  // the fake needs node in front on systems without shebang support → wrap in a shell script
  const wrapper = path.join(process.env.VIDEO_CACHE_DIR, 'yt-dlp');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const job = await videoFetch.startFetch({ projectId: 'p', url: 'https://youtu.be/aqz-KE-bpKQ' }, { ytdlpPath: wrapper, ffmpegPath: null });
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.kind, 'youtube');
  assert.equal(done.result.info.title, 'Fake Bunny');
  assert.equal(done.result.info.chapters[0].title, 'Intro');
  assert.equal(done.result.size, 1234);
  assert.equal(done.result.subtitlesLang, 'ko');
  assert.equal(done.result.subtitlesAuto, true);
  assert.equal(done.result.transcript.length, 1); // cumulative auto-caption deduped
  assert.equal(done.result.transcript[0].speaker, '나레이터');
  assert.match(done.result.transcript[0].text, /반갑습니다/);
});

test('startFetch without yt-dlp → 501 style error with a hint', async () => {
  process.env.VIDEO_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-vc-'));
  const job = await videoFetch.startFetch({ projectId: 'p', url: 'https://vimeo.com/123456789' }, { ytdlpPath: path.join(process.env.VIDEO_CACHE_DIR, 'nope') });
  const done = await waitJob(job.id);
  assert.equal(done.status, 'error');
  assert.match(done.error, /yt-dlp/);
});

test('sceneImport.toBoards: scenes → boards with source, links, dialogue, notes', () => {
  const { boards, summary } = sceneImport.toBoards({
    scenes: [
      { index: 0, start: 0, end: 2.5, action: '밝은 야외, 걷는 사람', shotType: 'WS', cameraMove: 'static', tags: ['야외'], mood: '밝음', descriptionBy: 'ai', frame: { start: 0, end: 60 } },
      { index: 1, start: 2.5, end: 5, action: '', description: '어두운 실내', dialogue: '', transcript: [{ speaker: 'A', text: '여기야' }], descriptionBy: 'heuristic', shotType: 'bogus', cameraMove: 'pan-right' },
      { index: 2, start: 5, end: 4 }, // invalid → dropped
      null,
    ],
    source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', videoId: 'aqz-KE-bpKQ', title: 'Bunny', fps: 24 },
  }, { defaultBoardTiming: 2000 });
  assert.equal(boards.length, 2);
  assert.equal(summary.scenes, 2);
  assert.equal(summary.withAi, 1);
  assert.equal(boards[0].duration, 2500);
  assert.equal(boards[0].ext.shotType, 'WS');
  assert.deepEqual(boards[0].ext.tags, ['야외', '밝음']);
  assert.match(boards[0].notes, /\[S001\] 00:00.0–00:02.5 · f0–60/);
  assert.match(boards[0].notes, /설명: AI/);
  assert.equal(boards[0].ext.links[0].url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal(boards[1].ext.links[0].url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=2s');
  assert.equal(boards[1].action, '어두운 실내');
  assert.equal(boards[1].dialogue, 'A: 여기야');
  assert.equal(boards[1].ext.shotType, '');
  assert.equal(boards[1].ext.cameraMove, 'pan-right');
  assert.equal(boards[1].ext.source.sceneId, 'S002');
  assert.equal(boards[1].ext.source.fps, 24);
  assert.match(boards[1].notes, /자동 추정/);
});

test('describeScenes: builds a multimodal request and normalises the answer', async () => {
  const oldEnv = { ...process.env };
  process.env.AI_TEXT_API_KEY = 'test';
  process.env.AI_VISION_MODEL = 'fake-vision';
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    const answer = { scenes: [
      { i: 3, action: '남자가 옥상에서 도시를 본다', description: '해질녘', shotType: 'ws', cameraMove: 'Static', mood: '쓸쓸함', tags: ['옥상', '노을'], figures: [{ x: 0.3, y: 0.4, h: 0.5, pose: 'stand', facing: 'right', label: '남자' }], shapes: [{ type: 'rect', x: 0, y: 0.6, w: 1, h: 0.4, label: '난간' }], horizon: 0.55 },
      { i: 4, action: '검은 화면', shotType: 'nope', figures: 'x' },
    ] };
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(answer) + '\n```' } }], usage: { total_tokens: 10 } }), { status: 200 });
  };
  try {
    const r = await text.describeScenes({ title: 'T', scenes: [
      { index: 3, time: 10, duration: 4, image: 'data:image/jpeg;base64,AAAA', transcript: '안녕', hints: { cameraMove: 'pan-right' } },
      { index: 4, time: 14, duration: 1 },
      { index: 5, time: 15, duration: 1 },
    ] }, { fetchImpl });
    assert.equal(sent.body.model, 'fake-vision');
    assert.equal(sent.body.messages[1].content.filter((c) => c.type === 'image_url').length, 1);
    assert.match(sent.body.messages[1].content[1].text, /Subtitles: 안녕/);
    assert.match(sent.body.messages[1].content[1].text, /cameraMove=pan-right/);
    assert.equal(r.scenes.length, 3);
    assert.equal(r.scenes[0].shotType, 'WS');
    assert.equal(r.scenes[0].cameraMove, 'static');
    assert.equal(r.scenes[0].figures[0].facing, 'right');
    assert.equal(r.scenes[0].shapes[0].label, '난간');
    assert.equal(r.scenes[0].horizon, 0.55);
    assert.equal(r.scenes[1].action, '검은 화면');
    assert.equal(r.scenes[1].shotType, '');
    assert.deepEqual(r.scenes[1].figures, []);
    assert.equal(r.scenes[2].missing, true);
    assert.equal(r.model, 'fake-vision');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
    Object.assign(process.env, oldEnv);
  }
});
