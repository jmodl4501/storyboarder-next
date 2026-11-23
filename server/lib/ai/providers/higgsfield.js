'use strict';

/**
 * Higgsfield API adapter (image-to-video).
 *
 * Reference: https://docs.higgsfield.ai  (endpoint catalog, auth, polling)
 *
 *   POST https://api.higgsfield.ai/<endpoint-id>
 *   Authorization: Key <HF_API_KEY_ID>:<HF_API_KEY_SECRET>
 *   Idempotency-Key: <uuid>
 *   { "prompt": "...", "image_url": "https://public/first-frame.png", "duration": 5 }
 *
 *   -> { status: "queued", request_id, status_url, cancel_url }
 *   poll status_url until status === "completed" -> { video: { url } }
 *
 * `image_url` must be a public URL, which is why PUBLIC_BASE_URL exists (see
 * docs/AI_INTEGRATION.md for tunnelling options).  Only the resulting video URL
 * is stored in the project – the video file itself is never downloaded unless
 * the user chooses to.
 */

const crypto = require('crypto');

const BASE_URL = 'https://api.higgsfield.ai';
const DEFAULT_ENDPOINT = 'kling-video/v3.0/std/image-to-video';

function config() {
  return {
    keyId: process.env.HF_API_KEY_ID || '',
    secret: process.env.HF_API_KEY_SECRET || '',
    endpoint: process.env.HF_ENDPOINT || DEFAULT_ENDPOINT,
    baseUrl: (process.env.HF_BASE_URL || BASE_URL).replace(/\/$/, ''),
  };
}

function isConfigured() {
  const c = config();
  return !!(c.keyId && c.secret);
}

function publicStatus() {
  const c = config();
  return { configured: isConfigured(), endpoint: c.endpoint, baseUrl: c.baseUrl, provider: 'higgsfield' };
}

function headers() {
  const c = config();
  return {
    authorization: `Key ${c.keyId}:${c.secret}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

function notConfigured() {
  const err = new Error('Higgsfield is not configured (set HF_API_KEY_ID and HF_API_KEY_SECRET)');
  err.status = 503;
  return err;
}

/** Build the request body from board data; `extra` lets the UI pass model specific fields. */
function buildInput({ prompt, imageUrl, durationSeconds, extra = {} }) {
  if (!imageUrl) {
    const err = new Error('image_url is required: set PUBLIC_BASE_URL (public tunnel) or pass imageUrl explicitly');
    err.status = 400;
    throw err;
  }
  const body = {
    prompt: String(prompt || '').slice(0, 2500),
    image_url: imageUrl,
    ...extra,
  };
  if (durationSeconds != null && body.duration == null) {
    body.duration = Math.min(15, Math.max(3, Math.round(Number(durationSeconds) || 5)));
  }
  return body;
}

async function request(url, init, fetchImpl, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, headers: { ...headers(), ...(init.headers || {}) } });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Higgsfield ${res.status}: ${text.slice(0, 300)}`);
      err.status = 502;
      err.details = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit a generation job.
 * @returns {Promise<{status, request_id, status_url, cancel_url}>}
 */
async function submit({ endpoint, input }, opts = {}) {
  if (!isConfigured()) throw notConfigured();
  const c = config();
  const ep = String(endpoint || c.endpoint).replace(/^\/+/, '');
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(ep)) {
    const err = new Error('invalid endpoint id');
    err.status = 400;
    throw err;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  return request(
    `${c.baseUrl}/${ep}`,
    {
      method: 'POST',
      headers: { 'idempotency-key': opts.idempotencyKey || crypto.randomUUID() },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

/** Poll a status URL returned by submit(). Only api.higgsfield.ai hosts are allowed. */
async function getStatus(statusUrl, opts = {}) {
  if (!isConfigured()) throw notConfigured();
  const c = config();
  let u;
  try {
    u = new URL(statusUrl);
  } catch {
    const err = new Error('invalid status url');
    err.status = 400;
    throw err;
  }
  const allowedHost = new URL(c.baseUrl).hostname;
  if (u.hostname !== allowedHost) {
    const err = new Error('status url host not allowed');
    err.status = 400;
    throw err;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  return request(u.toString(), { method: 'GET' }, fetchImpl);
}

module.exports = { isConfigured, publicStatus, buildInput, submit, getStatus, DEFAULT_ENDPOINT, BASE_URL };
