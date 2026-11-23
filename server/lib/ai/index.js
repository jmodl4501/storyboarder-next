'use strict';

/**
 * AI provider registry.  Everything here is optional: the editor is fully
 * usable offline, the prompt builder never touches the network, and each
 * provider reports `configured: false` until the matching env vars are set.
 */

const text = require('./providers/openaiText');
const higgsfield = require('./providers/higgsfield');
const { buildPrompt } = require('../promptBuilder');
const boards = require('../boards');

function status() {
  return {
    text: text.publicStatus(),
    video: higgsfield.publicStatus(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  };
}

/** Public URL of a board image (needed by remote video APIs). */
function publicImageUrl(projectId, board, { publicBaseUrl } = {}) {
  const base = publicBaseUrl || process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/images/${boards.boardImageFilename(board)}?v=${board.lastEdited}`;
}

function draftFor(board, project, opts = {}) {
  const built = buildPrompt(board, project, opts);
  const ext = board.ext || {};
  return {
    ...built,
    draft: {
      imagePrompt: ext.prompt || built.imagePrompt,
      videoPrompt: ext.videoPrompt || built.videoPrompt,
      negativePrompt: ext.negativePrompt || built.negativePrompt,
    },
  };
}

async function enhance({ board, project, instructions }, opts = {}) {
  const d = draftFor(board, project);
  return text.enhancePrompt({ board, project, draft: d.draft, instructions }, opts);
}

/** Vision model looks at scene key frames → Korean captions + stick-figure layouts. */
async function describeScenes(input, opts = {}) {
  return text.describeScenes(input, opts);
}

async function submitVideo({ projectId, board, project, endpoint, imageUrl, prompt, extra }, opts = {}) {
  const url = imageUrl || publicImageUrl(projectId, board);
  const d = draftFor(board, project);
  const input = higgsfield.buildInput({
    prompt: prompt || d.draft.videoPrompt,
    imageUrl: url,
    durationSeconds: d.params.durationSeconds,
    extra,
  });
  const result = await higgsfield.submit({ endpoint, input }, opts);
  return {
    job: {
      id: result.request_id || null,
      provider: 'higgsfield',
      endpoint: endpoint || higgsfield.publicStatus().endpoint,
      status: result.status || 'queued',
      statusUrl: result.status_url || null,
      cancelUrl: result.cancel_url || null,
      prompt: input.prompt,
      imageUrl: url,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      videoUrl: null,
    },
    raw: result,
  };
}

async function pollVideo(job, opts = {}) {
  if (!job || !job.statusUrl) {
    const err = new Error('job has no status url');
    err.status = 400;
    throw err;
  }
  const data = await higgsfield.getStatus(job.statusUrl, opts);
  const next = { ...job, status: data.status || job.status, updatedAt: Date.now() };
  if (data.video && data.video.url) next.videoUrl = data.video.url;
  if (data.error) next.error = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  return { job: next, raw: data };
}

module.exports = { status, publicImageUrl, draftFor, enhance, describeScenes, submitVideo, pollVideo, providers: { text, higgsfield } };
