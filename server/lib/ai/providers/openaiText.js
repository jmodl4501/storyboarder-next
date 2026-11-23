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
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

function config() {
  const baseUrl = (process.env.AI_TEXT_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const apiKey = process.env.AI_TEXT_API_KEY || '';
  const model = process.env.AI_TEXT_MODEL || 'gpt-4o-mini';
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(baseUrl);
  return { baseUrl, apiKey, model, configured: !!apiKey || (isLocal && !!process.env.AI_TEXT_BASE_URL) };
}

function isConfigured() {
  return config().configured;
}

function publicStatus() {
  const c = config();
  return { configured: c.configured, model: c.configured ? c.model : null, baseUrl: c.configured ? c.baseUrl : null };
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

module.exports = { isConfigured, publicStatus, enhancePrompt, extractJson, SYSTEM_PROMPT };
