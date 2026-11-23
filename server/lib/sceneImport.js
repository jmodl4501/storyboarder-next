'use strict';

/**
 * "영상 → 장면 스토리보드": turns the scene list produced by the browser-side
 * analyser (public/js/sceneDetect.js) into board records.  Images (captured
 * frames / sketches) are uploaded by the client afterwards through the normal
 * board-image endpoint; this module only deals with text + metadata so that the
 * boards are created atomically in one project write.
 *
 * Input scene (all optional except start/end):
 *   { index, start, end, action, description, dialogue, notes, shotType, cameraMove,
 *     mood, tags[], descriptionBy: 'ai'|'heuristic'|'manual', metrics: {...}, transcript: [{speaker,text}] }
 *
 * Source:
 *   { kind: 'youtube'|'vimeo'|'direct'|'page'|'file', url, videoId, title, fps, width, height, duration, fileName }
 */

const { buildLink, tc } = require('./analysisImport');
const { SHOT_TYPES, CAMERA_MOVES } = require('./boards');

const MAX_SCENES = 500;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max = 4000) => (v == null ? '' : String(v).slice(0, max));

function normalizeScene(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const start = num(raw.start ?? raw.startTime);
  const end = num(raw.end ?? raw.endTime);
  if (start == null || end == null || end <= start) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => str(t, 40).trim()).filter(Boolean) : [];
  const transcript = Array.isArray(raw.transcript) ? raw.transcript.map((t) => (typeof t === 'string' ? { text: t } : t)).filter((t) => t && t.text) : [];
  return {
    index: Number.isFinite(Number(raw.index)) ? Number(raw.index) : i,
    start,
    end,
    action: str(raw.action, 2000).trim(),
    description: str(raw.description, 4000).trim(),
    dialogue: str(raw.dialogue, 4000).trim(),
    notes: str(raw.notes, 4000).trim(),
    shotType: SHOT_TYPES.includes(raw.shotType) ? raw.shotType : '',
    cameraMove: CAMERA_MOVES.includes(raw.cameraMove) ? raw.cameraMove : '',
    mood: str(raw.mood, 80).trim(),
    tags: [...new Set(tags)].slice(0, 20),
    descriptionBy: ['ai', 'heuristic', 'manual'].includes(raw.descriptionBy) ? raw.descriptionBy : '',
    transcript: transcript.map((t) => ({ speaker: str(t.speaker, 60), text: str(t.text, 1000) })),
    metrics: raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : null,
    cutScore: num(raw.cutScore),
    frame: raw.frame && typeof raw.frame === 'object' ? { start: num(raw.frame.start), end: num(raw.frame.end) } : null,
  };
}

function normalizeSource(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    kind: ['youtube', 'vimeo', 'direct', 'page', 'file'].includes(s.kind) ? s.kind : 'file',
    url: str(s.url, 2000),
    videoId: str(s.videoId || s.id, 120),
    title: str(s.title, 300).trim(),
    uploader: str(s.uploader, 200),
    fps: num(s.fps),
    width: num(s.width),
    height: num(s.height),
    duration: num(s.duration),
    fileName: str(s.fileName, 300),
    asset: str(s.asset, 2000),
  };
}

/** @returns {{boards: object[], summary: object}} */
function toBoards(input, { defaultBoardTiming = 2000 } = {}) {
  const scenes = (Array.isArray(input.scenes) ? input.scenes : []).map(normalizeScene).filter(Boolean).slice(0, MAX_SCENES);
  const source = normalizeSource(input.source);
  const meta = { sourceUrl: source.url, title: source.title, videoId: source.videoId };
  const boards = scenes.map((s) => {
    const durationMs = Math.max(100, Math.round((s.end - s.start) * 1000)) || defaultBoardTiming;
    const label = `S${String(s.index + 1).padStart(3, '0')}`;
    const noteParts = [`[${label}] ${tc(s.start)}–${tc(s.end)}`];
    if (s.frame && s.frame.start != null && s.frame.end != null) noteParts[0] += ` · f${s.frame.start}–${s.frame.end}`;
    if (s.notes) noteParts.push(s.notes);
    if (s.mood) noteParts.push(`분위기: ${s.mood}`);
    if (s.description && s.description !== s.action) noteParts.push(s.description);
    if (s.descriptionBy === 'heuristic') noteParts.push('(설명: 자동 추정 — 색/밝기/움직임 기반)');
    else if (s.descriptionBy === 'ai') noteParts.push('(설명: AI)');
    const dialogue = s.dialogue || s.transcript.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join('\n');
    const link = buildLink(meta, s.start, `${label} ${tc(s.start)}–${tc(s.end)}`);
    const tags = [...new Set([...s.tags, ...(s.mood ? [s.mood] : [])])].slice(0, 20);
    return {
      newShot: true,
      action: s.action || s.description || `장면 ${s.index + 1}`,
      dialogue,
      notes: noteParts.join(' · '),
      duration: durationMs,
      ext: {
        shotType: s.shotType,
        cameraMove: s.cameraMove,
        tags,
        links: link ? [link] : [],
        source: {
          kind: source.kind,
          videoId: source.videoId || '',
          sceneId: label,
          startTime: s.start,
          endTime: s.end,
          startFrame: s.frame ? s.frame.start : null,
          endFrame: s.frame ? s.frame.end : null,
          fps: source.fps,
          file: source.fileName || '',
          url: source.url || '',
          asset: source.asset || '',
          descriptionBy: s.descriptionBy || '',
          cutScore: s.cutScore,
          metrics: s.metrics ? compactMetrics(s.metrics) : undefined,
        },
      },
    };
  });
  const summary = {
    scenes: scenes.length,
    boards: boards.length,
    withDialogue: boards.filter((b) => b.dialogue).length,
    withAi: scenes.filter((s) => s.descriptionBy === 'ai').length,
    totalMs: boards.reduce((a, b) => a + b.duration, 0),
    sourceUrl: source.url,
    title: source.title,
    videoId: source.videoId,
    kind: source.kind,
    truncated: (Array.isArray(input.scenes) ? input.scenes.length : 0) > MAX_SCENES,
  };
  return { boards, summary, source };
}

function compactMetrics(m) {
  const out = {};
  for (const k of ['brightness', 'saturation', 'warmth', 'motion', 'panX', 'panY', 'hue', 'edgeDensity']) {
    if (Number.isFinite(Number(m[k]))) out[k] = Math.round(Number(m[k]) * 1000) / 1000;
  }
  return out;
}

module.exports = { toBoards, normalizeScene, normalizeSource, MAX_SCENES };
