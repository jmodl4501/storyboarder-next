'use strict';

/**
 * Reference link preview.
 *
 * Planning a video means collecting *references* – not copies – of other
 * videos.  We only keep the URL + a little metadata + a thumbnail URL, never the
 * media itself, so a project stays small enough to live in a git repository.
 *
 *  - YouTube: id + thumbnail are derived from the URL (works offline), title /
 *    author are fetched through oEmbed when the network is available.
 *  - Vimeo: oEmbed.
 *  - Anything else: Open Graph / Twitter card meta tags.
 */

const net = require('net');

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseTimeParam(t) {
  if (!t) return 0;
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(s);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

function parseYouTube(url) {
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else {
    const m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (m) id = m[1];
  }
  if (!id || !YT_ID_RE.test(id)) return null;
  const start = parseTimeParam(url.searchParams.get('t') || url.searchParams.get('start'));
  return { id, start };
}

function parseVimeo(url) {
  if (!/(^|\.)vimeo\.com$/i.test(url.hostname)) return null;
  const m = /\/(?:video\/)?(\d{6,12})(?:$|[/?#])/.exec(url.pathname);
  return m ? { id: m[1] } : null;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Extract Open Graph / Twitter / title tags with regular expressions (no HTML parser needed). */
function parseMeta(html) {
  const metas = {};
  const tagRe = /<meta\s+[^>]*?>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (key && content && !(key[1].toLowerCase() in metas)) metas[key[1].toLowerCase()] = decodeEntities(content[1]);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    title: metas['og:title'] || metas['twitter:title'] || (title ? decodeEntities(title[1]).trim() : ''),
    description: metas['og:description'] || metas['twitter:description'] || metas['description'] || '',
    thumbnail: metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || metas['twitter:image:src'] || '',
    siteName: metas['og:site_name'] || '',
    video: metas['og:video'] || metas['og:video:url'] || '',
    type: metas['og:type'] || '',
  };
}

async function fetchWithLimit(url, { fetchImpl = fetch, timeoutMs = 7000, maxBytes = 512 * 1024, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; StoryboarderNext/0.1; +https://github.com/)',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'ko,en;q=0.8',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      return text.slice(0, maxBytes);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  const text = await fetchWithLimit(url, { ...opts, headers: { accept: 'application/json' } });
  return JSON.parse(text);
}

/**
 * @param {string} rawUrl
 * @param {object} opts { offline?: boolean, fetchImpl?: Function, timeoutMs?: number }
 */
async function preview(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw Object.assign(new Error('invalid url'), { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('only http(s) urls are supported'), { status: 400 });
  if (isPrivateHost(url.hostname)) throw Object.assign(new Error('private hosts are not allowed'), { status: 400 });

  const offline = !!opts.offline || process.env.LINK_PREVIEW_OFFLINE === '1';
  const base = { url: url.toString(), provider: 'web', title: '', description: '', thumbnail: '', author: '', siteName: '', duration: null, embedUrl: '', startSeconds: 0, fetchedAt: Date.now() };

  const yt = parseYouTube(url);
  if (yt) {
    const out = {
      ...base,
      provider: 'youtube',
      id: yt.id,
      url: `https://www.youtube.com/watch?v=${yt.id}${yt.start ? `&t=${yt.start}s` : ''}`,
      thumbnail: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
      embedUrl: `https://www.youtube.com/embed/${yt.id}${yt.start ? `?start=${yt.start}` : ''}`,
      startSeconds: yt.start,
      siteName: 'YouTube',
    };
    if (!offline) {
      try {
        const data = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt.id}`)}&format=json`, opts);
        out.title = data.title || '';
        out.author = data.author_name || '';
        if (data.thumbnail_url) out.thumbnail = data.thumbnail_url;
      } catch (err) {
        out.warning = `oEmbed unavailable: ${err.message}`;
      }
    }
    return out;
  }

  const vm = parseVimeo(url);
  if (vm) {
    const out = { ...base, provider: 'vimeo', id: vm.id, url: `https://vimeo.com/${vm.id}`, embedUrl: `https://player.vimeo.com/video/${vm.id}`, siteName: 'Vimeo' };
    if (!offline) {
      try {
        const data = await fetchJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(out.url)}`, opts);
        out.title = data.title || '';
        out.author = data.author_name || '';
        out.thumbnail = data.thumbnail_url || '';
        out.duration = data.duration || null;
        out.description = data.description || '';
      } catch (err) {
        out.warning = `oEmbed unavailable: ${err.message}`;
      }
    }
    return out;
  }

  if (offline) return { ...base, warning: 'offline mode: metadata not fetched' };
  try {
    const html = await fetchWithLimit(url.toString(), opts);
    const meta = parseMeta(html);
    return { ...base, ...meta, thumbnail: absolutize(meta.thumbnail, url), provider: meta.video ? 'video' : 'web' };
  } catch (err) {
    return { ...base, warning: `metadata unavailable: ${err.message}` };
  }
}

function absolutize(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return '';
  }
}

module.exports = { preview, parseYouTube, parseVimeo, parseTimeParam, isPrivateHost, parseMeta, decodeEntities };
