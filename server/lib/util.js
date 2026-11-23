'use strict';

/**
 * Small, dependency-free helpers shared by the server modules.
 */

/** Same style of uid as the original Storyboarder (base36, upper-case). */
function uidGen(chars = 5) {
  return ('00000' + ((Math.random() * Math.pow(36, chars)) << 0).toString(36))
    .slice(-chars)
    .toUpperCase();
}

/** Turn a user supplied project name into a safe folder name. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeProjectId(name) {
  let id = String(name || '')
    .normalize('NFC')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '') // Windows: no trailing dots/spaces in folder names
    .slice(0, 64)
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(id)) id = `${id}-project`;
  return id;
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));

function mimeFromName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * File name for an uploaded asset: ASCII-safe (so URLs/GitHub/Windows all agree),
 * keeps a recognisable stem and a sensible extension.
 */
function safeAssetName(originalName, mime = '') {
  let base = String(originalName || 'file').normalize('NFC').split(/[\\/]/).pop();
  let ext = '';
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  if (m) {
    ext = m[1].toLowerCase();
    base = base.slice(0, -m[0].length);
  }
  if ((!ext || !MIME_BY_EXT[ext]) && EXT_BY_MIME[mime]) ext = EXT_BY_MIME[mime];
  if (!ext) ext = 'bin';
  let stem = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
  if (!stem) stem = 'file';
  return `${stem}.${ext}`;
}

/** Only allow plain file names (no path separators, no traversal). */
function isSafeFilename(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name) &&
    !name.includes('..')
  );
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 00:00:00:00 (HH:MM:SS:FF) */
function msToTimecode(ms, fps = 24) {
  const totalFrames = Math.round((Math.max(0, ms) / 1000) * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** 1:04.5 style clock for UI labels */
function msToClock(ms) {
  const totalSeconds = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function hasHangul(text) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(String(text || ''));
}

/**
 * Rough duration estimate for a piece of script text.
 * - Korean: ~5.5 syllables / second
 * - Other languages: ~2.5 words / second
 * Dialogue gets a small pause added, action boards are shorter than reading time.
 */
function estimateDurationMs(text, kind = 'dialogue') {
  const t = String(text || '').trim();
  if (!t) return null;
  let seconds;
  if (hasHangul(t)) {
    const syllables = (t.match(/[\uAC00-\uD7A3]/g) || []).length + (t.match(/[A-Za-z0-9]+/g) || []).length * 2;
    seconds = syllables / 5.5;
  } else {
    const words = t.split(/\s+/).filter(Boolean).length;
    seconds = words / 2.5;
  }
  if (kind === 'dialogue') seconds += 0.6;
  else seconds = seconds * 0.6 + 0.8;
  const ms = Math.round((seconds * 1000) / 100) * 100;
  return clamp(ms, 1000, 15000);
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  uidGen,
  safeProjectId,
  isSafeFilename,
  safeAssetName,
  mimeFromName,
  clamp,
  pad,
  msToTimecode,
  msToClock,
  hasHangul,
  estimateDurationMs,
  nowIso,
  escapeHtml,
};
