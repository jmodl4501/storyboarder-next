'use strict';

/**
 * OpenAI-compatible chat completion provider used to *polish* prompts.
 * Works with OpenAI, OpenRouter, Groq, Ollama (`http://localhost:11434/v1`),
 * LM Studio and anything else that speaks the /v1/chat/completions protocol.
 *
 * Env:
 *   AI_TEXT_BASE_URL  (default https://api.openai.com/v1)
 *   AI_TEXT_API_KEY   (optional for local servers)
 *   AI_TEXT_MODEL     (default gpt-4o-mini)
 *   AI_VISION_MODEL   (optional; model used to *look at* video frames — defaults to AI_TEXT_MODEL.
 *                      e.g. gpt-4o-mini, qwen2.5vl / llama3.2-vision on Ollama)
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

function config() {
  const baseUrl = (process.env.AI_TEXT_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const apiKey = process.env.AI_TEXT_API_KEY || '';
  const model = process.env.AI_TEXT_MODEL || 'gpt-4o-mini';
  const visionModel = process.env.AI_VISION_MODEL || model;
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(baseUrl);
  return { baseUrl, apiKey, model, visionModel, configured: !!apiKey || (isLocal && !!process.env.AI_TEXT_BASE_URL) };
}

function isConfigured() {
  return config().configured;
}

function publicStatus() {
  const c = config();
  return { configured: c.configured, model: c.configured ? c.model : null, visionModel: c.configured ? c.visionModel : null, baseUrl: c.configured ? c.baseUrl : null };
}

const SYSTEM_PROMPT = `You are a storyboard-to-AI-video prompt engineer.
You receive structured data about one storyboard panel (shot type, camera move, action, dialogue, notes, duration, aspect ratio, global visual style) plus draft prompts.
Return STRICT JSON with keys "imagePrompt", "videoPrompt", "negativePrompt".
Rules:
- Write prompts in natural English (translate Korean faithfully, keep proper nouns).
- imagePrompt: one key frame. Lead with subject + action, then shot type/framing, then lighting/style, then technical quality words. 40-90 words.
- videoPrompt: assume the image is the FIRST FRAME (image-to-video). Describe only the motion: camera move, subject motion, pacing for the given duration. Preserve composition. 30-70 words. No new objects that are not in the frame.
- negativePrompt: short comma separated list.
- Never include on-screen text, subtitles, captions or watermarks.
- Do not add markdown, comments or any text outside the JSON object.`;

function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('model did not return JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * @param {object} input { board, project, draft: {imagePrompt, videoPrompt, negativePrompt}, instructions? }
 * @param {object} opts  { fetchImpl?, timeoutMs? }
 */
async function enhancePrompt(input, opts = {}) {
  const c = config();
  if (!c.configured) {
    const err = new Error('text AI provider is not configured (set AI_TEXT_API_KEY / AI_TEXT_BASE_URL)');
    err.status = 503;
    throw err;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const { board, project, draft, instructions } = input;
  const userPayload = {
    shot: board.shot,
    shotType: board.ext && board.ext.shotType,
    cameraMove: board.ext && board.ext.cameraMove,
    action: board.action,
    dialogue: board.dialogue,
    notes: board.notes,
    durationSeconds: (board.duration != null ? board.duration : project.defaultBoardTiming) / 1000,
    aspectRatio: project.aspectRatio,
    style: project.ext && project.ext.style,
    references: ((board.ext && board.ext.links) || []).map((l) => ({ title: l.title, url: l.url, note: l.note })),
    draft,
    extraInstructions: instructions || '',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  try {
    const res = await fetchImpl(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({
        model: c.model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(userPayload, null, 2) },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`text provider error ${res.status}: ${text.slice(0, 300)}`);
      err.status = 502;
      throw err;
    }
    const data = JSON.parse(text);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = extractJson(content);
    return {
      imagePrompt: String(parsed.imagePrompt || draft.imagePrompt || ''),
      videoPrompt: String(parsed.videoPrompt || draft.videoPrompt || ''),
      negativePrompt: String(parsed.negativePrompt || draft.negativePrompt || ''),
      model: c.model,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ scenes */

const SHOT_CODES = 'EWS WS FS MS MCU CU ECU OTS POV TWO INSERT LOW HIGH BIRD DUTCH';
const MOVE_CODES = 'static pan-left pan-right tilt-up tilt-down dolly-in dolly-out truck-left truck-right crane-up crane-down handheld zoom-in zoom-out orbit rack-focus follow whip-pan';

const SCENE_SYSTEM_PROMPT = `You are a film storyboard artist's assistant. You receive key frames of consecutive scenes (shots) from one video, each with its time range and any subtitles spoken during it.
For EVERY frame return one JSON object. Respond with STRICT JSON: {"scenes":[...]} and nothing else.
Each scene object:
- "i": the scene index given to you (integer)
- "action": one Korean sentence (≤ 60자) saying what happens / what we see — subject first, then setting. This is the storyboard panel caption.
- "description": 1–2 Korean sentences with more detail: who/what, where, lighting, notable props, text on screen if any.
- "shotType": one of ${SHOT_CODES} (framing of the main subject; INSERT for objects/details, EWS for establishing landscapes)
- "cameraMove": your best guess from a single frame, one of ${MOVE_CODES} (use "static" unless motion blur / framing strongly suggests movement; use the hint if provided)
- "mood": 1–3 Korean words
- "tags": up to 5 short Korean keywords (objects, place, time of day)
- "figures": people/animals as stick-figure placements, array (may be empty) of {"x":0-1,"y":0-1,"h":0-1,"pose":"stand|walk|run|sit|lie|arms-up|point|crouch|wave","facing":"left|right|front|back","label":"짧은 이름"} where x,y is the HEAD centre in normalized frame coordinates and h is the full body height relative to frame height (0.2 = small figure, 0.9 = close-up). For close-ups of a face use pose "stand" with h ≥ 1.2 and y near 0.5.
- "shapes": up to 6 simple shapes for key objects/architecture: {"type":"rect|ellipse|line","x":0-1,"y":0-1,"w":0-1,"h":0-1,"label":"짧은 이름"} (top-left anchored; for "line" x,y→x+w,y+h)
- "horizon": 0-1 vertical position of the horizon/ground line, or null for indoor close-ups
Be concrete and honest; if the frame is black/blank say so in Korean ("검은 화면"). Never invent people who are not visible.`;

/**
 * Describe scene key frames with a vision-capable chat model.
 * @param {object} input { scenes: [{ index, time, duration, image(dataUrl), transcript, hints:{cameraMove, brightness…} }], style?, language? }
 * @param {object} opts  { fetchImpl?, timeoutMs? }
 */
async function describeScenes(input, opts = {}) {
  const c = config();
  if (!c.configured) {
    const err = new Error('text AI provider is not configured (set AI_TEXT_API_KEY / AI_TEXT_BASE_URL)');
    err.status = 503;
    throw err;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  if (!scenes.length) return { scenes: [], model: c.visionModel, usage: null };
  const content = [];
  const header = [
    `Video: ${input.title || '(untitled)'}${input.context ? ` — ${input.context}` : ''}.`,
    `Project style (for tone only): ${input.style || 'n/a'}.`,
    `There are ${scenes.length} frames below, in order. Return exactly ${scenes.length} scene objects.`,
  ].join(' ');
  content.push({ type: 'text', text: header });
  for (const s of scenes) {
    const lines = [`Scene i=${s.index}: ${fmt(s.time)}–${fmt((s.time || 0) + (s.duration || 0))} (${(s.duration || 0).toFixed(1)}s)`];
    if (s.transcript) lines.push(`Subtitles: ${String(s.transcript).slice(0, 400)}`);
    if (s.hints && typeof s.hints === 'object') {
      const h = s.hints;
      const parts = [];
      if (h.cameraMove) parts.push(`motion analysis suggests cameraMove=${h.cameraMove}`);
      if (h.brightness != null) parts.push(`brightness=${h.brightness}`);
      if (h.chapter) parts.push(`chapter="${h.chapter}"`);
      if (parts.length) lines.push(`Hints: ${parts.join(', ')}`);
    }
    content.push({ type: 'text', text: lines.join('\n') });
    if (s.image) content.push({ type: 'image_url', image_url: { url: String(s.image), detail: 'low' } });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120000);
  try {
    const res = await fetchImpl(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({
        model: c.visionModel,
        temperature: 0.3,
        max_tokens: Math.min(16000, 400 * scenes.length + 400),
        messages: [
          { role: 'system', content: SCENE_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`vision provider error ${res.status}: ${text.slice(0, 300)}`);
      err.status = 502;
      throw err;
    }
    const data = JSON.parse(text);
    const msg = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = extractJson(typeof msg === 'string' ? msg : JSON.stringify(msg));
    const list = Array.isArray(parsed.scenes) ? parsed.scenes : Array.isArray(parsed) ? parsed : [];
    const byIndex = new Map();
    list.forEach((o, k) => {
      if (!o || typeof o !== 'object') return;
      const idx = Number.isFinite(Number(o.i)) ? Number(o.i) : (scenes[k] ? scenes[k].index : k);
      byIndex.set(idx, normalizeSceneDescription(o));
    });
    return {
      scenes: scenes.map((s) => ({ index: s.index, ...(byIndex.get(s.index) || { action: '', description: '', missing: true }) })),
      model: c.visionModel,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function fmt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const clamp01 = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.min(1.5, Math.max(-0.5, Number(v))) : d);

function normalizeSceneDescription(o) {
  const shot = String(o.shotType || '').toUpperCase().trim();
  const move = String(o.cameraMove || '').toLowerCase().trim();
  const figures = (Array.isArray(o.figures) ? o.figures : []).slice(0, 12).map((f) => ({
    x: clamp01(f.x, 0.5),
    y: clamp01(f.y, 0.3),
    h: Math.min(2, Math.max(0.05, Number(f.h) || 0.5)),
    pose: String(f.pose || 'stand').toLowerCase(),
    facing: String(f.facing || 'front').toLowerCase(),
    label: String(f.label || '').slice(0, 30),
  }));
  const shapes = (Array.isArray(o.shapes) ? o.shapes : []).slice(0, 8).map((sh) => ({
    type: ['rect', 'ellipse', 'line'].includes(sh.type) ? sh.type : 'rect',
    x: clamp01(sh.x, 0.1),
    y: clamp01(sh.y, 0.1),
    w: clamp01(sh.w, 0.2),
    h: clamp01(sh.h, 0.2),
    label: String(sh.label || '').slice(0, 30),
  }));
  return {
    action: String(o.action || '').trim().slice(0, 300),
    description: String(o.description || '').trim().slice(0, 1000),
    shotType: SHOT_CODES.split(' ').includes(shot) ? shot : '',
    cameraMove: MOVE_CODES.split(' ').includes(move) ? move : '',
    mood: String(o.mood || '').trim().slice(0, 60),
    tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 8),
    figures,
    shapes,
    horizon: o.horizon == null ? null : clamp01(o.horizon, null),
  };
}

module.exports = { isConfigured, publicStatus, enhancePrompt, describeScenes, extractJson, SYSTEM_PROMPT, SCENE_SYSTEM_PROMPT, normalizeSceneDescription };
