// Thin wrapper around the REST API (server/index.js)

async function request(url, { method = 'GET', body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText || 'request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => request('/api/meta'),
  listProjects: () => request('/api/projects'),
  createProject: (payload) => request('/api/projects', { method: 'POST', body: payload }),
  getProject: (id) => request(`/api/projects/${enc(id)}`),
  saveProject: (id, project) => request(`/api/projects/${enc(id)}`, { method: 'PUT', body: project }),
  deleteProject: (id) => request(`/api/projects/${enc(id)}`, { method: 'DELETE' }),

  addBoard: (id, payload) => request(`/api/projects/${enc(id)}/boards`, { method: 'POST', body: payload }),
  duplicateBoard: (id, uid) => request(`/api/projects/${enc(id)}/boards/${enc(uid)}/duplicate`, { method: 'POST', body: {} }),
  deleteBoard: (id, uid) => request(`/api/projects/${enc(id)}/boards/${enc(uid)}`, { method: 'DELETE' }),
  reorderBoards: (id, order) => request(`/api/projects/${enc(id)}/boards/reorder`, { method: 'POST', body: { order } }),
  saveBoardImage: (id, uid, payload) => request(`/api/projects/${enc(id)}/boards/${enc(uid)}/image`, { method: 'POST', body: payload }),
  uploadBoardReference: async (id, uid, file) => {
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    const mime = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext]) || 'image/jpeg';
    const res = await fetch(`/api/projects/${enc(id)}/boards/${enc(uid)}/reference`, { method: 'POST', headers: { 'content-type': mime }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data.board;
  },

  parseScript: (payload) => request('/api/script/parse', { method: 'POST', body: payload }),
  importScript: (id, payload) => request(`/api/projects/${enc(id)}/script`, { method: 'POST', body: payload }),

  linkPreview: (url) => request('/api/link-preview', { method: 'POST', body: { url } }),

  // video analysis import (shots / transcript JSON, PySceneDetect CSV, SRT/VTT)
  previewAnalysis: (payload) => request('/api/import/analysis/preview', { method: 'POST', body: payload }),
  importAnalysis: (id, payload) => request(`/api/projects/${enc(id)}/import/analysis`, { method: 'POST', body: payload }),

  // whiteboard + uploaded assets
  getWhiteboard: (id) => request(`/api/projects/${enc(id)}/whiteboard`),
  saveWhiteboard: (id, whiteboard) => request(`/api/projects/${enc(id)}/whiteboard`, { method: 'PUT', body: { whiteboard } }),
  addBoardsToWhiteboard: (id, payload) => request(`/api/projects/${enc(id)}/whiteboard/boards`, { method: 'POST', body: payload || {} }),
  listAssets: (id) => request(`/api/projects/${enc(id)}/assets`),
  /** Upload a File/Blob as raw bytes (no base64 overhead). */
  uploadAsset: async (id, file, name) => {
    const res = await fetch(`/api/projects/${enc(id)}/assets?name=${enc(name || file.name || 'upload')}&mime=${enc(file.type || '')}`, {
      method: 'POST',
      headers: { 'content-type': file.type && /^(image|video|audio)\//.test(file.type) ? file.type : 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data.asset;
  },
  importAssetFromUrl: (id, url) => request(`/api/projects/${enc(id)}/assets/from-url`, { method: 'POST', body: { url } }),
  deleteAsset: (id, name) => request(`/api/projects/${enc(id)}/assets/${enc(name)}`, { method: 'DELETE' }),

  // video → scene storyboard (v0.3): the server only acquires the file, the browser does the analysis
  videoCapabilities: () => request('/api/video/capabilities'),
  fetchVideo: (id, payload) => request(`/api/projects/${enc(id)}/video/fetch`, { method: 'POST', body: payload }),
  videoJob: (jobId) => request(`/api/video/jobs/${enc(jobId)}`),
  deleteVideoJob: (jobId) => request(`/api/video/jobs/${enc(jobId)}`, { method: 'DELETE' }),
  describeScenes: (payload) => request('/api/ai/describe-scenes', { method: 'POST', body: payload }),
  importScenes: (id, payload) => request(`/api/projects/${enc(id)}/import/scenes`, { method: 'POST', body: payload }),

  aiStatus: () => request('/api/ai/status'),
  aiPrompt: (payload) => request('/api/ai/prompt', { method: 'POST', body: payload }),
  aiEnhance: (payload) => request('/api/ai/enhance', { method: 'POST', body: payload }),
  aiVideo: (payload) => request('/api/ai/video', { method: 'POST', body: payload }),
  aiVideoPoll: (payload) => request('/api/ai/video/poll', { method: 'POST', body: payload }),

  imageUrl: (id, filename, v) => `/projects/${enc(id)}/images/${enc(filename)}${v ? `?v=${v}` : ''}`,
  exportUrl: (id, format) => `/api/projects/${enc(id)}/export/${format}`,
};
