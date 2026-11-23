'use strict';

/**
 * Deterministic prompt builder.
 *
 * The storyboard already contains the *structure* of a shot (type, camera
 * move, action, dialogue, duration, aspect ratio, visual style).  Instead of
 * asking a video model to guess all of that, we assemble a compact, explicit
 * prompt from the board data.  No network, no tokens – an LLM can optionally
 * polish the result later (see ai/providers/openaiText.js).
 */

const SHOT_TYPE_PHRASES = {
  EWS: 'extreme wide shot',
  WS: 'wide shot',
  FS: 'full shot',
  MS: 'medium shot',
  MCU: 'medium close-up',
  CU: 'close-up',
  ECU: 'extreme close-up',
  OTS: 'over-the-shoulder shot',
  POV: 'point-of-view shot',
  TWO: 'two shot',
  INSERT: 'insert shot (detail)',
  LOW: 'low angle shot',
  HIGH: 'high angle shot',
  BIRD: "bird's-eye view",
  DUTCH: 'dutch angle shot',
};

const CAMERA_MOVE_PHRASES = {
  static: 'static locked-off camera',
  'pan-left': 'slow pan to the left',
  'pan-right': 'slow pan to the right',
  'tilt-up': 'slow tilt up',
  'tilt-down': 'slow tilt down',
  'dolly-in': 'slow dolly in, pushing toward the subject',
  'dolly-out': 'slow dolly out, pulling away from the subject',
  'truck-left': 'lateral tracking shot moving left',
  'truck-right': 'lateral tracking shot moving right',
  'crane-up': 'crane shot rising upward',
  'crane-down': 'crane shot descending',
  handheld: 'handheld camera with subtle natural shake',
  'zoom-in': 'slow zoom in',
  'zoom-out': 'slow zoom out',
  orbit: 'camera orbiting around the subject',
  'rack-focus': 'rack focus shifting between foreground and background',
  follow: 'tracking shot following the subject',
  'whip-pan': 'fast whip pan',
};

const SHOT_TYPE_LABELS_KO = {
  EWS: '익스트림 와이드', WS: '와이드(풀 배경)', FS: '풀샷', MS: '미디엄샷', MCU: '미디엄 클로즈업', CU: '클로즈업',
  ECU: '익스트림 클로즈업', OTS: '오버 더 숄더', POV: '시점샷(POV)', TWO: '투샷', INSERT: '인서트', LOW: '로우앵글',
  HIGH: '하이앵글', BIRD: '버즈아이', DUTCH: '더치앵글',
};

const CAMERA_MOVE_LABELS_KO = {
  static: '고정', 'pan-left': '팬 좌', 'pan-right': '팬 우', 'tilt-up': '틸트 업', 'tilt-down': '틸트 다운',
  'dolly-in': '달리 인', 'dolly-out': '달리 아웃', 'truck-left': '트럭 좌', 'truck-right': '트럭 우',
  'crane-up': '크레인 업', 'crane-down': '크레인 다운', handheld: '핸드헬드', 'zoom-in': '줌 인', 'zoom-out': '줌 아웃',
  orbit: '오빗(회전)', 'rack-focus': '랙 포커스', follow: '팔로우', 'whip-pan': '휩 팬',
};

const DEFAULT_NEGATIVE = 'text, watermark, logo, subtitles, extra fingers, deformed hands, distorted face, blurry, low quality, flicker, jitter, duplicate frame';

const ASPECT_LABELS = [
  [16 / 9, '16:9'], [2.39, '2.39:1'], [2.35, '2.35:1'], [1.85, '1.85:1'], [4 / 3, '4:3'], [1, '1:1'],
  [9 / 16, '9:16'], [0.8, '4:5'], [1.5, '3:2'], [2, '2:1'], [2 / 3, '2:3'],
];

function aspectRatioLabel(ar) {
  const n = Number(ar) || 16 / 9;
  let best = null;
  for (const [value, label] of ASPECT_LABELS) {
    const diff = Math.abs(value - n);
    if (diff < 0.02 && (!best || diff < best.diff)) best = { diff, label };
  }
  return best ? best.label : `${n.toFixed(2)}:1`;
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function sentence(s) {
  const t = clean(s);
  if (!t) return '';
  return /[.!?。！？]$/.test(t) ? t : `${t}.`;
}

/** "민지: 오늘 뭐 먹을까?" -> { character: '민지', line: '오늘 뭐 먹을까?' } */
function splitDialogue(dialogue) {
  const lines = String(dialogue || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => {
    const m = /^([^:：]{1,24})\s*[:：]\s*(.+)$/.exec(l);
    return m ? { character: m[1].trim(), line: m[2].trim() } : { character: '', line: l };
  });
}

/**
 * @param {object} board
 * @param {object} project
 * @param {object} opts { imageUrl?: string, style?: string, language?: 'en'|'ko' }
 */
function buildPrompt(board, project, opts = {}) {
  const ext = board.ext || {};
  const style = clean(opts.style || (project.ext && project.ext.style) || '');
  const shotType = ext.shotType || '';
  const cameraMove = ext.cameraMove || '';
  const shotPhrase = SHOT_TYPE_PHRASES[shotType] || '';
  const cameraPhrase = CAMERA_MOVE_PHRASES[cameraMove] || '';
  const durationMs = board.duration != null ? Number(board.duration) : Number(project.defaultBoardTiming) || 2000;
  const durationSeconds = Math.max(1, Math.round((durationMs / 1000) * 10) / 10);
  const aspect = aspectRatioLabel(project.aspectRatio);
  const dialogue = splitDialogue(board.dialogue);
  const action = clean(board.action);

  // ---- image prompt (text-to-image / image-to-image for the key frame)
  const imageParts = [];
  const heading = parseSceneHeading(action);
  if (heading) {
    const where = [heading.location, heading.time].filter(Boolean).join(', ');
    imageParts.push(sentence(`Establishing ${shotPhrase || 'wide shot'} of ${where || heading.raw}${heading.interior === true ? ' (interior)' : heading.interior === false ? ' (exterior)' : ''}`));
  } else if (shotPhrase) imageParts.push(sentence(`${capitalize(shotPhrase)}${action ? ` of ${lowerFirst(action)}` : ''}`));
  else if (action) imageParts.push(sentence(action));
  if (dialogue.length) {
    const who = [...new Set(dialogue.map((d) => d.character).filter(Boolean))];
    if (who.length) imageParts.push(sentence(`${who.join(' and ')} ${who.length > 1 ? 'are' : 'is'} speaking, expressive face, natural gesture`));
    else imageParts.push('A character is speaking, expressive face.');
  }
  if (style) imageParts.push(sentence(`Style: ${style}`));
  imageParts.push(`Aspect ratio ${aspect}, cinematic composition, coherent character design, clean frame, no text.`);
  const imagePrompt = imageParts.join(' ');

  // ---- video prompt (image-to-video; the board image is the first frame)
  const videoParts = [];
  videoParts.push(sentence(cameraPhrase ? capitalize(cameraPhrase) : 'Camera mostly static with subtle natural motion'));
  if (heading) videoParts.push(sentence(`Establishing view of ${[heading.location, heading.time].filter(Boolean).join(', ') || heading.raw}, ambient movement only (light, wind, people in the distance)`));
  else if (action) videoParts.push(sentence(action));
  if (dialogue.length) videoParts.push(sentence(`${dialogue[0].character || 'The character'} speaks naturally (lip movement, no on-screen text)`));
  videoParts.push(`Keep the composition, characters and lighting of the reference frame; ${durationSeconds}s; smooth motion; ${aspect}.`);
  if (style) videoParts.push(sentence(style));
  const videoPrompt = videoParts.join(' ');

  const negativePrompt = clean(ext.negativePrompt) || DEFAULT_NEGATIVE;

  const payloads = {
    higgsfield: {
      prompt: videoPrompt.slice(0, 2500),
      image_url: opts.imageUrl || null,
      duration: Math.min(15, Math.max(3, Math.round(durationSeconds))),
    },
    generic: {
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
      negative_prompt: negativePrompt,
      first_frame: opts.imageUrl || board.url || null,
      duration_seconds: durationSeconds,
      aspect_ratio: aspect,
      fps: project.fps || 24,
    },
  };

  return {
    imagePrompt,
    videoPrompt,
    negativePrompt,
    params: {
      shotType,
      shotPhrase,
      cameraMove,
      cameraPhrase,
      durationSeconds,
      durationMs,
      aspectRatio: aspect,
      fps: project.fps || 24,
      style,
    },
    payloads,
  };
}

/**
 * "S#1. 옥상 - 해질녘" / "INT. KITCHEN - NIGHT" -> { location, time, interior }
 * Returns null when the text does not look like a scene heading.
 */
function parseSceneHeading(text) {
  const t = clean(text);
  if (!t || t.length > 80) return null;
  const m = /^(?:(?:S\s*#?\s*\d+|씬\s*#?\s*\d+|장면\s*\d+|#\s*\d+)[.:)\s-]*)?(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E\.?|실내|실외)?\s*(.*)$/i.exec(t);
  if (!m) return null;
  const hasPrefix = /^(?:S\s*#?\s*\d+|씬\s*#?\s*\d+|장면\s*\d+|#\s*\d+)/i.test(t);
  if (!hasPrefix && !m[1]) return null;
  const rest = (m[2] || '').replace(/^[.:\s-]+/, '');
  if (!rest) return null;
  const parts = rest.split(/\s+[-–—]\s+|\s*[,，]\s*|\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  const location = parts[0] || '';
  const time = parts.slice(1).join(', ');
  const kind = (m[1] || '').toUpperCase();
  const interior = kind.startsWith('INT') || kind === '실내' ? true : kind.startsWith('EXT') || kind === '실외' ? false : null;
  return { raw: rest, location, time, interior };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function lowerFirst(s) {
  // Only lower-case a leading ASCII capital that is not an acronym
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

module.exports = {
  buildPrompt,
  aspectRatioLabel,
  splitDialogue,
  parseSceneHeading,
  SHOT_TYPE_PHRASES,
  CAMERA_MOVE_PHRASES,
  SHOT_TYPE_LABELS_KO,
  CAMERA_MOVE_LABELS_KO,
  DEFAULT_NEGATIVE,
};
