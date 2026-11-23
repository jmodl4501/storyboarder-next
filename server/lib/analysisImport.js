'use strict';

/**
 * Video-analysis import — turns the output of an analysis pipeline
 * (PySceneDetect / Scene Scribe / Whisper / a VLM …) into storyboard boards.
 *
 * Accepted inputs (auto-detected):
 *   1. Analysis JSON  — see docs/ANALYSIS_IMPORT.md.  Shape (all keys optional,
 *      snake_case or camelCase):
 *        { video_id, title, source: {url, path}, metadata: {fps, width, height, duration},
 *          shots: [{ id, start_frame, end_frame, start_time, end_time, fps, description,
 *                    visual_description, objects, actions, camera: {shot_type, movement},
 *                    mood, tags, audio_events, transcript_ids, thumbnail }],
 *          transcript: [{ segment_id, start_time, end_time, speaker, text }] }
 *   2. A bare JSON array of shots.
 *   3. PySceneDetect `list-scenes` CSV  (Scene Number,Start Frame,Start Timecode,…).
 *   4. SRT / WebVTT subtitles  (transcript only → one board per cue).
 *
 * Output of parse(): { format, meta, shots, transcript, warnings }
 * toBoards(parsed, opts) → board records compatible with boards.createBoard().
 *
 * Pure functions, no I/O.
 */

const { parseYouTube } = require('./linkPreview');

const SHOT_TYPE_ALIASES = {
  EWS: ['ews', 'extremewide', 'extremewideshot', 'extremelongshot', 'els', 'establishing', 'establishingshot', 'xws', '익스트림와이드', '설정샷', '익스트림롱샷'],
  WS: ['ws', 'wide', 'wideshot', 'long', 'longshot', 'ls', 'verywide', 'vws', '와이드', '와이드샷', '롱샷'],
  FS: ['fs', 'full', 'fullshot', 'fullbody', '풀샷', '전신'],
  MS: ['ms', 'medium', 'mediumshot', 'mid', 'midshot', 'waist', 'waistshot', '미디엄', '미디엄샷', '웨이스트샷'],
  MCU: ['mcu', 'mediumcloseup', 'mediumclose', 'bust', 'bustshot', 'chest', '바스트샷', '미디엄클로즈업'],
  CU: ['cu', 'close', 'closeup', 'closeshot', 'headshot', 'face', '클로즈업', '클로즈'],
  ECU: ['ecu', 'xcu', 'bcu', 'extremecloseup', 'bigcloseup', 'extremeclose', 'macro', '익스트림클로즈업', '빅클로즈업'],
  OTS: ['ots', 'overtheshoulder', 'overshoulder', 'shoulder', '오버더숄더', '어깨너머'],
  POV: ['pov', 'pointofview', 'firstperson', 'subjective', '시점샷', '주관적시점', '1인칭'],
  TWO: ['two', 'twoshot', '2shot', '2s', 'ts', '투샷'],
  INSERT: ['insert', 'insertshot', 'detail', 'detailshot', 'cutaway', 'cutin', 'product', '인서트', '디테일', '컷어웨이'],
  LOW: ['low', 'lowangle', 'worm', 'wormseye', 'wormseyeview', '로우앵글', '앙각'],
  HIGH: ['high', 'highangle', '하이앵글', '부감샷'],
  BIRD: ['bird', 'birdseye', 'birdseyeview', 'aerial', 'drone', 'topdown', 'overhead', 'top', 'satellite', '조감', '항공', '드론', '탑다운', '부감'],
  DUTCH: ['dutch', 'dutchangle', 'canted', 'cantedangle', 'tilted', 'oblique', '더치', '더치앵글', '사각'],
};

const MOVE_ALIASES = {
  static: ['static', 'locked', 'lockedoff', 'fixed', 'still', 'none', 'tripod', 'stationary', 'nomovement', 'hold', '고정', '픽스', '정지'],
  'pan-left': ['panleft', 'panl', 'leftpan', '팬레프트', '좌로팬'],
  'pan-right': ['panright', 'panr', 'rightpan', 'pan', 'panning', '팬', '팬라이트', '우로팬'],
  'tilt-up': ['tiltup', 'uptilt', 'tilt', 'tilting', '틸트업', '틸트'],
  'tilt-down': ['tiltdown', 'downtilt', '틸트다운'],
  'dolly-in': ['dollyin', 'pushin', 'push', 'dolly', 'movein', 'approach', 'forward', '달리인', '푸시인', '달리'],
  'dolly-out': ['dollyout', 'pullout', 'pullback', 'moveout', 'retreat', 'backward', 'reverse', '달리아웃', '풀아웃', '풀백'],
  'truck-left': ['truckleft', 'trackleft', 'lateralleft', 'slideleft', 'crableft', '트럭레프트'],
  'truck-right': ['truckright', 'trackright', 'lateralright', 'slideright', 'crabright', 'truck', 'lateral', 'slide', 'crab', '트럭', '트럭라이트', '횡이동'],
  'crane-up': ['craneup', 'crane', 'boomup', 'boom', 'jib', 'jibup', 'pedestalup', 'rise', 'rising', 'ascend', 'ascending', 'flyover', '크레인', '크레인업', '붐업', '상승'],
  'crane-down': ['cranedown', 'boomdown', 'jibdown', 'pedestaldown', 'descend', 'descending', 'lower', '크레인다운', '붐다운', '하강'],
  handheld: ['handheld', 'hand', 'shaky', 'shake', 'documentary', 'runandgun', '핸드헬드', '핸디', '흔들림'],
  'zoom-in': ['zoomin', 'zoom', 'zooming', 'crashzoom', '줌인', '줌'],
  'zoom-out': ['zoomout', '줌아웃'],
  orbit: ['orbit', 'orbital', 'arc', 'arcshot', 'circle', 'circling', 'around', '360', '오빗', '아크', '원형이동', '회전'],
  'rack-focus': ['rackfocus', 'focuspull', 'pullfocus', 'focusshift', 'refocus', '랙포커스', '포커스이동'],
  follow: ['follow', 'following', 'tracking', 'trackingshot', 'track', 'steadicam', 'gimbal', 'chase', 'followshot', '팔로우', '트래킹', '추적', '스테디캠', '짐벌'],
  'whip-pan': ['whippan', 'whip', 'swishpan', 'swish', 'fastpan', '휩팬', '스위시팬'],
};

function buildLookup(table) {
  const map = new Map();
  for (const [canon, aliases] of Object.entries(table)) {
    map.set(normKey(canon), canon);
    for (const a of aliases) map.set(normKey(a), canon);
  }
  return map;
}
const normKey = (s) => String(s || '').toLowerCase().replace(/[\s_\-./()]+/g, '');
const SHOT_LOOKUP = buildLookup(SHOT_TYPE_ALIASES);
const MOVE_LOOKUP = buildLookup(MOVE_ALIASES);

/** Exact key → token → long-substring lookup (short aliases only match as whole tokens). */
function lookup(table, v) {
  const k = normKey(v);
  if (table.has(k)) return table.get(k);
  const tokens = String(v).toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
  let best = '';
  let bestLen = 0;
  for (const t of tokens) {
    if (table.has(t) && t.length > bestLen) {
      best = table.get(t);
      bestLen = t.length;
    }
  }
  if (best) return best;
  for (const [alias, canon] of table) {
    if (alias.length > bestLen && alias.length >= 5 && k.includes(alias)) {
      best = canon;
      bestLen = alias.length;
    }
  }
  return best;
}

function mapShotType(v) {
  if (!v) return '';
  return lookup(SHOT_LOOKUP, v);
}

function mapCameraMove(v) {
  if (!v) return '';
  const k = normKey(v);
  let best = lookup(MOVE_LOOKUP, v);
  // direction refinement: "pan to the left" etc.
  if (best && /left|좌|왼/.test(k)) best = best.replace(/-right$/, '-left');
  if (best && /right|우|오른/.test(k)) best = best.replace(/-left$/, '-right');
  if (best && /down|아래|하강/.test(k)) best = best.replace(/-up$/, '-down');
  if (best && /\bout\b|아웃/.test(String(v).toLowerCase())) best = best.replace(/-in$/, '-out');
  return best;
}

/* ---------------------------------------------------------------- helpers */

const first = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

/** Seconds from a number, "12.5", "12.5s", "MM:SS", "HH:MM:SS(.mmm|,mmm)", "HH:MM:SS:FF" (needs fps). */
function parseTime(v, fps) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?\s*(s|sec|secs|초)?$/i.test(s)) return parseFloat(s);
  if (/^\d+(\.\d+)?\s*ms$/i.test(s)) return parseFloat(s) / 1000;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?(?::(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  let frac = 0;
  if (m[4] !== undefined) frac = Number(`0.${m[4].padEnd(3, '0')}`);
  if (m[5] !== undefined) frac = fps ? Number(m[5]) / fps : 0; // HH:MM:SS:FF
  return h * 3600 + min * 60 + sec + frac;
}

const toList = (v) => {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? x.name || x.label || x.text || JSON.stringify(x) : String(x))).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;|/]\s*|\n/).map((s) => s.trim()).filter(Boolean);
  return [String(v)];
};

function tc(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const body = `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
  return h ? `${h}:${body}` : body;
}

/* ------------------------------------------------------------ detection */

function detectFormat(text) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (/^WEBVTT/i.test(t)) return 'vtt';
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(t)) return 'srt';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (/Scene Number\s*,\s*Start Frame/i.test(t)) return 'scenedetect-csv';
  if (/^[^\n]*,[^\n]*\n/.test(t) && /start/i.test(t.split('\n')[0])) return 'csv';
  return 'unknown';
}

/* --------------------------------------------------------------- parsers */

function parseSceneDetectCsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /Scene Number/i.test(l) && /Start Frame/i.test(l));
  if (headerIdx < 0) throw new Error('scenedetect csv: header row not found');
  const header = lines[headerIdx].split(',').map((h) => h.trim().toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const iNum = col(/scene number/);
  const iSF = col(/start frame/);
  const iST = col(/start time \(seconds\)/);
  const iSTC = col(/start timecode/);
  const iEF = col(/end frame/);
  const iET = col(/end time \(seconds\)/);
  const iETC = col(/end timecode/);
  const shots = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const n = cells[iNum];
    if (!/^\d+$/.test(String(n || '').trim())) continue;
    const startFrame = Number(cells[iSF]);
    const endFrame = Number(cells[iEF]);
    const startTime = iST >= 0 ? Number(cells[iST]) : parseTime(cells[iSTC]);
    const endTime = iET >= 0 ? Number(cells[iET]) : parseTime(cells[iETC]);
    shots.push({
      id: `SH${String(n).padStart(3, '0')}`,
      startFrame: Number.isFinite(startFrame) ? startFrame - 1 : null, // PySceneDetect numbers frames from 1
      endFrame: Number.isFinite(endFrame) ? endFrame : null,
      startTime,
      endTime,
    });
  }
  // infer fps from the first row
  let fps = null;
  const s0 = shots.find((s) => s.endFrame != null && s.endTime);
  if (s0) fps = Math.round(((s0.endFrame - (s0.startFrame || 0)) / (s0.endTime - (s0.startTime || 0))) * 1000) / 1000;
  return { format: 'scenedetect-csv', meta: { fps }, shots, transcript: [], warnings: [] };
}

function parseSubtitles(text, format) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split(/-->/).map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTime(a.replace(',', '.'));
    const end = parseTime(b.replace(',', '.'));
    if (start == null || end == null) continue;
    let rawBody = lines.slice(ti + 1).join('\n');
    let speaker = '';
    const voice = /^\s*<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(rawBody); // WebVTT <v Speaker>
    if (voice) {
      speaker = voice[1].trim();
      rawBody = rawBody.slice(voice[0].length);
    }
    const body = rawBody.replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    let t = body;
    const sp = speaker ? null : /^\s*(?:\[([^\]]{1,30})\]|([A-Z][A-Z0-9_ ]{1,20}|[가-힣]{1,6}|SPEAKER[_ ]?\d+)\s*:)\s*/.exec(body);
    if (sp) {
      speaker = (sp[1] || sp[2] || '').trim();
      t = body.slice(sp[0].length);
    }
    cues.push({ id: `ASR_${String(cues.length + 1).padStart(3, '0')}`, start, end, speaker, text: t });
  }
  return { format, meta: {}, shots: [], transcript: cues, warnings: cues.length ? [] : ['no cues found'] };
}

function normalizeTranscript(list) {
  const out = [];
  for (const [i, seg] of (Array.isArray(list) ? list : []).entries()) {
    if (!seg || typeof seg !== 'object') continue;
    const text = first(seg, ['text', 'transcript', 'content', 'sentence']);
    if (!text) continue;
    const start = parseTime(first(seg, ['start_time', 'startTime', 'start', 'start_sec', 'from', 'begin']));
    const end = parseTime(first(seg, ['end_time', 'endTime', 'end', 'end_sec', 'to', 'finish']));
    out.push({
      id: String(first(seg, ['segment_id', 'segmentId', 'id']) || `ASR_${String(i + 1).padStart(3, '0')}`),
      start,
      end,
      speaker: String(first(seg, ['speaker', 'speaker_id', 'speakerId', 'who']) || ''),
      text: String(text).trim(),
      words: Array.isArray(seg.words) ? seg.words.length : 0,
    });
  }
  return out;
}

function normalizeShot(raw, i, fps) {
  if (!raw || typeof raw !== 'object') return null;
  const cam = raw.camera && typeof raw.camera === 'object' ? raw.camera : {};
  const shotFps = Number(first(raw, ['fps', 'frame_rate', 'frameRate'])) || fps || null;
  let startFrame = first(raw, ['start_frame', 'startFrame', 'in_frame', 'inFrame', 'frame_in', 'first_frame']);
  let endFrame = first(raw, ['end_frame', 'endFrame', 'out_frame', 'outFrame', 'frame_out', 'last_frame']);
  let startTime = parseTime(first(raw, ['start_time', 'startTime', 'start_sec', 'start_seconds', 'start_timecode', 'startTimecode', 'in', 'start', 'tc_in']), shotFps);
  let endTime = parseTime(first(raw, ['end_time', 'endTime', 'end_sec', 'end_seconds', 'end_timecode', 'endTimecode', 'out', 'end', 'tc_out']), shotFps);
  if (raw.start && typeof raw.start === 'object') {
    startFrame = startFrame ?? raw.start.frame;
    startTime = startTime ?? parseTime(raw.start.time ?? raw.start.seconds, shotFps);
  }
  if (raw.end && typeof raw.end === 'object') {
    endFrame = endFrame ?? raw.end.frame;
    endTime = endTime ?? parseTime(raw.end.time ?? raw.end.seconds, shotFps);
  }
  startFrame = startFrame != null && startFrame !== '' ? Number(startFrame) : null;
  endFrame = endFrame != null && endFrame !== '' ? Number(endFrame) : null;
  const duration = parseTime(first(raw, ['duration', 'duration_sec', 'length', 'length_seconds']), shotFps);
  if (startTime == null && startFrame != null && shotFps) startTime = startFrame / shotFps;
  if (endTime == null && endFrame != null && shotFps) endTime = endFrame / shotFps;
  if (endTime == null && startTime != null && duration != null) endTime = startTime + duration;
  if (startFrame == null && startTime != null && shotFps) startFrame = Math.round(startTime * shotFps);
  if (endFrame == null && endTime != null && shotFps) endFrame = Math.round(endTime * shotFps);

  const description = String(first(raw, ['description', 'desc', 'caption', 'summary', 'content', 'scene_description', 'title']) || '').trim();
  const visual = String(first(raw, ['visual_description', 'visualDescription', 'visual', 'vlm_description']) || '').trim();
  const shotTypeRaw = first(cam, ['shot_type', 'shotType', 'type', 'size', 'framing']) ?? first(raw, ['shot_type', 'shotType', 'camera_shot', 'shot_size', 'framing']);
  const moveRaw = first(cam, ['movement', 'move', 'motion', 'camera_movement']) ?? first(raw, ['camera_movement', 'cameraMove', 'camera_move', 'movement', 'motion']);
  return {
    id: String(first(raw, ['id', 'shot_id', 'shotId', 'scene_id', 'sceneId', 'number', 'index']) ?? `SH${String(i + 1).padStart(3, '0')}`),
    startFrame: Number.isFinite(startFrame) ? startFrame : null,
    endFrame: Number.isFinite(endFrame) ? endFrame : null,
    startTime,
    endTime,
    fps: shotFps,
    description,
    visual,
    objects: toList(first(raw, ['objects', 'entities', 'subjects'])),
    actions: toList(first(raw, ['actions', 'activities', 'events'])),
    tags: toList(first(raw, ['tags', 'keywords', 'labels'])),
    audioEvents: toList(first(raw, ['audio_events', 'audioEvents', 'audio', 'sound'])),
    transcriptIds: toList(first(raw, ['transcript_ids', 'transcriptIds', 'asr_ids'])),
    transcriptText: typeof raw.transcript === 'string' ? raw.transcript : typeof raw.speech === 'string' ? raw.speech : typeof raw.dialogue === 'string' ? raw.dialogue : '',
    mood: String(first(raw, ['mood', 'emotion', 'tone', 'atmosphere']) || ''),
    shotTypeRaw: shotTypeRaw ? String(shotTypeRaw) : '',
    moveRaw: moveRaw ? String(moveRaw) : '',
    shotType: mapShotType(shotTypeRaw),
    cameraMove: mapCameraMove(moveRaw),
    thumbnail: String(first(raw, ['thumbnail', 'thumb', 'image', 'keyframe', 'representative_frame', 'poster']) || ''),
    thumbnails: toList(first(raw, ['thumbnails', 'keyframes', 'frames'])),
    location: String(first(raw, ['location', 'place', 'setting']) || ''),
    timeOfDay: String(first(raw, ['time_of_day', 'timeOfDay', 'daytime']) || ''),
  };
}

function parseJson(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    throw Object.assign(new Error(`JSON parse error: ${err.message}`), { status: 400 });
  }
  const warnings = [];
  let root = data;
  if (Array.isArray(data)) {
    const looksLikeTranscript = data.length && data.every((x) => x && typeof x === 'object' && (x.text || x.transcript || x.sentence) && !x.description && !x.visual_description && !x.camera);
    root = looksLikeTranscript ? { transcript: data } : { shots: data };
  }
  if (!root || typeof root !== 'object') throw Object.assign(new Error('analysis JSON must be an object or an array of shots'), { status: 400 });
  // some tools wrap everything: { result: {...} } / { video: {...}, analysis: {...} }
  const SHOT_KEYS = ['shots', 'scenes', 'cuts', 'segments_visual', 'clips'];
  const TEXT_KEYS = ['transcript', 'transcripts', 'asr', 'speech', 'subtitles', 'captions', 'segments'];
  const hasContent = (o) => !!o && typeof o === 'object' && (SHOT_KEYS.some((k) => Array.isArray(o[k])) || TEXT_KEYS.some((k) => o[k]));
  if (!hasContent(root)) {
    for (const key of ['result', 'results', 'data', 'analysis', 'video', 'output', 'payload', 'response']) {
      if (hasContent(root[key])) {
        root = { ...root, ...root[key] };
        break;
      }
    }
  }
  const metaObj = root.metadata || root.meta || root.video || root.info || {};
  const fps = Number(first(root, ['fps', 'frame_rate', 'frameRate'])) || Number(first(metaObj, ['fps', 'frame_rate', 'frameRate', 'avg_frame_rate'])) || null;
  const source = root.source && typeof root.source === 'object' ? root.source : {};
  const meta = {
    videoId: String(first(root, ['video_id', 'videoId', 'id', 'source_id', 'sourceId']) || first(metaObj, ['video_id', 'id']) || ''),
    title: String(first(root, ['title', 'name']) || first(metaObj, ['title', 'name']) || ''),
    fps,
    width: Number(first(metaObj, ['width', 'w'])) || Number(first(root, ['width'])) || null,
    height: Number(first(metaObj, ['height', 'h'])) || Number(first(root, ['height'])) || null,
    duration: parseTime(first(metaObj, ['duration', 'duration_sec', 'length']) ?? first(root, ['duration', 'duration_sec'])),
    sourceUrl: String(first(source, ['url', 'href']) || first(root, ['url', 'source_url', 'sourceUrl', 'video_url', 'videoUrl']) || first(metaObj, ['url']) || ''),
    sourcePath: String(first(source, ['path', 'file', 'filename']) || first(root, ['path', 'file', 'filename', 'source_path']) || first(metaObj, ['path', 'file', 'filename']) || ''),
    hash: String(first(source, ['hash', 'sha1', 'sha256', 'md5']) || first(root, ['hash']) || ''),
  };
  const rawShots = first(root, ['shots', 'scenes', 'cuts', 'segments_visual', 'clips']) || [];
  if (!Array.isArray(rawShots)) throw Object.assign(new Error('"shots" must be an array'), { status: 400 });
  const shots = rawShots.map((s, i) => normalizeShot(s, i, fps)).filter(Boolean);
  // transcript may live in several places
  let rawTranscript = first(root, ['transcript', 'transcripts', 'asr', 'speech', 'subtitles', 'captions']);
  if (!rawTranscript && root.audio && typeof root.audio === 'object') rawTranscript = first(root.audio, ['transcript', 'segments', 'asr']);
  if (!rawTranscript && Array.isArray(root.segments) && root.segments.some((s) => s && (s.text || s.transcript))) rawTranscript = root.segments;
  if (rawTranscript && typeof rawTranscript === 'object' && !Array.isArray(rawTranscript) && Array.isArray(rawTranscript.segments)) rawTranscript = rawTranscript.segments;
  const transcript = normalizeTranscript(rawTranscript);
  if (!shots.length && !transcript.length) warnings.push('no shots or transcript found');
  if (shots.some((s) => s.startTime == null)) warnings.push('some shots have no start time (need start_time or start_frame + fps)');
  return { format: 'json', meta, shots, transcript, warnings };
}

/** Parse any supported text. */
function parse(input) {
  if (input && typeof input === 'object') return parseJson(input);
  const text = String(input || '');
  const format = detectFormat(text);
  switch (format) {
    case 'json': return parseJson(text);
    case 'scenedetect-csv': return parseSceneDetectCsv(text);
    case 'srt':
    case 'vtt': return parseSubtitles(text, format);
    case 'empty': throw Object.assign(new Error('empty input'), { status: 400 });
    default: throw Object.assign(new Error('unrecognized format: expected analysis JSON, PySceneDetect CSV, SRT or WebVTT'), { status: 400 });
  }
}

/* ------------------------------------------------------------- boards */

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function transcriptForShot(shot, transcript) {
  if (!transcript.length) return [];
  const byId = shot.transcriptIds.length ? transcript.filter((t) => shot.transcriptIds.includes(t.id)) : [];
  if (byId.length) return byId;
  if (shot.startTime == null || shot.endTime == null) return [];
  return transcript.filter((t) => {
    if (t.start == null || t.end == null) return false;
    const ov = overlap(shot.startTime, shot.endTime, t.start, t.end);
    const dur = Math.max(0.01, t.end - t.start);
    return ov >= Math.min(0.5, dur * 0.5);
  });
}

function buildLink(meta, startSeconds, label) {
  const url = meta.sourceUrl;
  if (!/^https?:\/\//i.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const yt = parseYouTube(u);
  const start = Math.max(0, Math.floor(startSeconds || 0));
  if (yt) {
    return {
      url: `https://www.youtube.com/watch?v=${yt.id}${start ? `&t=${start}s` : ''}`,
      provider: 'youtube',
      id: yt.id,
      title: meta.title || meta.videoId || 'YouTube',
      thumbnail: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
      embedUrl: `https://www.youtube.com/embed/${yt.id}${start ? `?start=${start}` : ''}`,
      startSeconds: start,
      siteName: 'YouTube',
      note: label,
    };
  }
  return { url, provider: 'web', title: meta.title || meta.videoId || url, startSeconds: start, note: label };
}

/**
 * @returns {{boards: object[], summary: object}}
 */
const SHOT_DEFAULTS = { id: '', description: '', visual: '', shotType: '', shotTypeRaw: '', cameraMove: '', moveRaw: '', mood: '', location: '', timeOfDay: '', thumbnail: '', thumbnails: [], transcriptText: '', objects: [], actions: [], tags: [], transcriptIds: [], audioEvents: [] };

function toBoards(parsed, { defaultBoardTiming = 2000, maxBoards = 500 } = {}) {
  const meta = (parsed && parsed.meta) || {};
  const transcript = (parsed && Array.isArray(parsed.transcript)) ? parsed.transcript : [];
  const shots = ((parsed && Array.isArray(parsed.shots)) ? parsed.shots : []).map((s) => ({ ...SHOT_DEFAULTS, ...s }));
  const boards = [];
  const label = (s) => `${s.id} ${tc(s.startTime)}–${tc(s.endTime)}`;
  if (shots.length) {
    for (const s of shots.slice(0, maxBoards)) {
      const lines = transcriptForShot(s, transcript).map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text));
      if (!lines.length && s.transcriptText) lines.push(s.transcriptText);
      const noteParts = [`[${s.id}] ${tc(s.startTime)}–${tc(s.endTime)}${s.startFrame != null && s.endFrame != null ? ` · f${s.startFrame}–${s.endFrame}` : ''}`];
      if (s.location || s.timeOfDay) noteParts.push(`장소: ${[s.location, s.timeOfDay].filter(Boolean).join(' / ')}`);
      if (s.moveRaw && !s.cameraMove) noteParts.push(`카메라: ${s.moveRaw}`);
      if (s.shotTypeRaw && !s.shotType) noteParts.push(`샷: ${s.shotTypeRaw}`);
      if (s.objects.length) noteParts.push(`객체: ${s.objects.join(', ')}`);
      if (s.actions.length) noteParts.push(`행동: ${s.actions.join(', ')}`);
      if (s.mood) noteParts.push(`분위기: ${s.mood}`);
      if (s.audioEvents.length) noteParts.push(`오디오: ${s.audioEvents.join(', ')}`);
      const durationMs = s.startTime != null && s.endTime != null && s.endTime > s.startTime ? Math.max(100, Math.round((s.endTime - s.startTime) * 1000)) : defaultBoardTiming;
      const link = buildLink(meta, s.startTime, label(s));
      boards.push({
        newShot: true,
        action: s.visual || s.description || (s.objects.length ? s.objects.join(', ') : `Shot ${s.id}`),
        dialogue: lines.join('\n'),
        notes: noteParts.join(' · '),
        duration: durationMs,
        ext: {
          shotType: s.shotType,
          cameraMove: s.cameraMove,
          tags: [...new Set([...s.tags, ...(s.mood ? [s.mood] : [])])].slice(0, 20),
          links: link ? [link] : [],
          source: {
            videoId: meta.videoId || '',
            shotId: s.id,
            startFrame: s.startFrame,
            endFrame: s.endFrame,
            startTime: s.startTime,
            endTime: s.endTime,
            fps: s.fps || meta.fps || null,
            file: meta.sourcePath || '',
            url: meta.sourceUrl || '',
            thumbnail: s.thumbnail || (s.thumbnails && s.thumbnails[0]) || '',
          },
        },
      });
    }
  } else {
    // transcript only: one board per cue
    for (const t of transcript.slice(0, maxBoards)) {
      const link = buildLink(meta, t.start, `${t.id} ${tc(t.start)}–${tc(t.end)}`);
      boards.push({
        newShot: false,
        action: '',
        dialogue: t.speaker ? `${t.speaker}: ${t.text}` : t.text,
        notes: `[${t.id}] ${tc(t.start)}–${tc(t.end)}`,
        duration: t.start != null && t.end != null && t.end > t.start ? Math.max(100, Math.round((t.end - t.start) * 1000)) : defaultBoardTiming,
        ext: {
          shotType: 'MCU',
          cameraMove: 'static',
          links: link ? [link] : [],
          source: { videoId: meta.videoId || '', segmentId: t.id, startTime: t.start, endTime: t.end, file: meta.sourcePath || '', url: meta.sourceUrl || '' },
        },
      });
    }
    if (boards.length) boards[0].newShot = true;
  }
  const totalMs = boards.reduce((a, b) => a + (b.duration || 0), 0);
  const summary = {
    format: parsed.format,
    videoId: meta.videoId || '',
    title: meta.title || '',
    fps: meta.fps || (shots[0] && shots[0].fps) || null,
    shots: shots.length,
    transcriptSegments: transcript.length,
    boards: boards.length,
    withDialogue: boards.filter((b) => b.dialogue).length,
    withShotType: boards.filter((b) => b.ext.shotType).length,
    withCameraMove: boards.filter((b) => b.ext.cameraMove).length,
    withThumbnail: boards.filter((b) => b.ext.source && b.ext.source.thumbnail).length,
    totalMs,
    sourceUrl: meta.sourceUrl || '',
    sourcePath: meta.sourcePath || '',
    truncated: shots.length > maxBoards || (!shots.length && transcript.length > maxBoards),
  };
  return { boards, summary };
}

module.exports = { parse, toBoards, detectFormat, parseTime, mapShotType, mapCameraMove, tc };
