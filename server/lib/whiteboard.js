'use strict';

/**
 * Whiteboard model — an infinite canvas of reference material that lives in
 * `project.ext.whiteboard` (the original Storyboarder ignores `ext`).
 *
 *   {
 *     version: 1,
 *     viewport: { x, y, zoom },                  // last camera position (client convenience)
 *     nodes: [ { id, type, x, y, w, h, z, ...typeSpecific } ],
 *     edges: [ { id, from, to, label, color } ]  // connectors between nodes
 *   }
 *
 * Node types
 *   image  { src, alt, note }                           src = /projects/<id>/assets/<file> or external URL
 *   video  { src, name, poster }                        uploaded video file (<video>)
 *   embed  { provider, url, embedUrl, title, author, thumbnail, startSeconds, note }   YouTube / Vimeo
 *   link   { url, title, description, thumbnail, siteName, note }
 *   note   { text, color }                              sticky note
 *   text   { text, size }                               plain text label / heading
 *   frame  { title, color }                             visual grouping region
 *   board  { uid }                                      card linking to a storyboard board
 *   file   { src, name, mime, size }                    other uploaded documents
 *
 * Everything here is pure data manipulation; no I/O.
 */

const crypto = require('crypto');

/** 6 url-safe base36 chars. */
function rand6() {
  return crypto.randomBytes(4).readUInt32BE(0).toString(36).padStart(7, '0').slice(-6);
}

const VERSION = 1;
const NODE_TYPES = ['image', 'video', 'embed', 'link', 'note', 'text', 'frame', 'board', 'file'];
const MAX_NODES = 5000;
const MAX_EDGES = 5000;
const MAX_TEXT = 20000;
const COORD_LIMIT = 1e7;

const DEFAULT_SIZE = {
  image: [320, 200],
  video: [400, 260],
  embed: [400, 260],
  link: [300, 120],
  note: [220, 160],
  text: [280, 48],
  frame: [800, 600],
  board: [220, 164],
  file: [240, 72],
};

const NOTE_COLORS = ['#FFE08A', '#FFB4A2', '#BDE0FE', '#CDEAC0', '#E4C1F9', '#F1F1F1'];
const FRAME_COLORS = ['#7C9CFF', '#FF7A4A', '#3DDC84', '#FFC857', '#C77DFF', '#9AA0A6'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const str = (v, max = MAX_TEXT) => (v == null ? '' : String(v).slice(0, max));

function newId(existing = new Set()) {
  let id;
  do id = `n${rand6()}`;
  while (existing.has(id));
  existing.add(id);
  return id;
}

function defaultWhiteboard() {
  return { version: VERSION, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
}

/** Validate / coerce a node coming from the client. Returns null when unusable. */
function normalizeNode(raw, ids) {
  if (!raw || typeof raw !== 'object') return null;
  const type = NODE_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  const [dw, dh] = DEFAULT_SIZE[type];
  let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(raw.id) ? raw.id : null;
  if (!id || ids.has(id)) id = newId(ids);
  else ids.add(id);
  const node = {
    id,
    type,
    x: clamp(num(raw.x), -COORD_LIMIT, COORD_LIMIT),
    y: clamp(num(raw.y), -COORD_LIMIT, COORD_LIMIT),
    w: clamp(num(raw.w, dw), 16, 20000),
    h: clamp(num(raw.h, dh), 16, 20000),
    z: clamp(Math.round(num(raw.z)), -1e6, 1e6),
    createdAt: num(raw.createdAt, Date.now()),
  };
  if (raw.locked) node.locked = true;
  if (raw.note != null && raw.note !== '') node.note = str(raw.note, 2000);
  if (Array.isArray(raw.tags) && raw.tags.length) node.tags = raw.tags.slice(0, 50).map((t) => str(t, 60));
  switch (type) {
    case 'image':
      node.src = str(raw.src, 4000);
      if (raw.alt) node.alt = str(raw.alt, 500);
      if (raw.natural && Array.isArray(raw.natural)) node.natural = [num(raw.natural[0]), num(raw.natural[1])];
      if (raw.sourceUrl) node.sourceUrl = str(raw.sourceUrl, 4000);
      break;
    case 'video':
      node.src = str(raw.src, 4000);
      if (raw.name) node.name = str(raw.name, 300);
      if (raw.poster) node.poster = str(raw.poster, 4000);
      break;
    case 'embed':
      node.provider = str(raw.provider || 'web', 20);
      node.url = str(raw.url, 4000);
      node.embedUrl = str(raw.embedUrl, 4000);
      node.title = str(raw.title, 500);
      if (raw.author) node.author = str(raw.author, 200);
      if (raw.thumbnail) node.thumbnail = str(raw.thumbnail, 4000);
      node.startSeconds = Math.max(0, Math.round(num(raw.startSeconds)));
      if (raw.videoId) node.videoId = str(raw.videoId, 64);
      break;
    case 'link':
      node.url = str(raw.url, 4000);
      node.title = str(raw.title, 500);
      if (raw.description) node.description = str(raw.description, 1000);
      if (raw.thumbnail) node.thumbnail = str(raw.thumbnail, 4000);
      if (raw.siteName) node.siteName = str(raw.siteName, 200);
      break;
    case 'note':
      node.text = str(raw.text);
      node.color = /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : NOTE_COLORS[0];
      break;
    case 'text':
      node.text = str(raw.text, 5000);
      node.size = clamp(Math.round(num(raw.size, 20)), 10, 200);
      if (raw.color && /^#[0-9a-fA-F]{6}$/.test(raw.color)) node.color = raw.color;
      break;
    case 'frame':
      node.title = str(raw.title, 200);
      node.color = /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : FRAME_COLORS[0];
      break;
    case 'board':
      node.uid = str(raw.uid, 12);
      break;
    case 'file':
      node.src = str(raw.src, 4000);
      node.name = str(raw.name, 300);
      if (raw.mime) node.mime = str(raw.mime, 100);
      if (raw.size != null) node.size = Math.max(0, Math.round(num(raw.size)));
      break;
    default:
      break;
  }
  return node;
}

function normalizeEdge(raw, nodeIds, edgeIds) {
  if (!raw || typeof raw !== 'object') return null;
  if (!nodeIds.has(raw.from) || !nodeIds.has(raw.to) || raw.from === raw.to) return null;
  let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(raw.id) ? raw.id : null;
  if (!id || edgeIds.has(id)) id = `e${rand6()}`;
  edgeIds.add(id);
  const edge = { id, from: raw.from, to: raw.to };
  if (raw.label) edge.label = str(raw.label, 300);
  if (raw.color && /^#[0-9a-fA-F]{6}$/.test(raw.color)) edge.color = raw.color;
  if (raw.style === 'line' || raw.style === 'dashed') edge.style = raw.style;
  return edge;
}

/**
 * Coerce whatever the client sent into a valid whiteboard.
 * Drops nodes of unknown type, edges whose endpoints are missing, etc.
 */
function normalizeWhiteboard(raw) {
  const wb = defaultWhiteboard();
  if (!raw || typeof raw !== 'object') return wb;
  if (raw.viewport && typeof raw.viewport === 'object') {
    wb.viewport = {
      x: clamp(num(raw.viewport.x), -COORD_LIMIT, COORD_LIMIT),
      y: clamp(num(raw.viewport.y), -COORD_LIMIT, COORD_LIMIT),
      zoom: clamp(num(raw.viewport.zoom, 1), 0.02, 8),
    };
  }
  const ids = new Set();
  for (const n of (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, MAX_NODES)) {
    const node = normalizeNode(n, ids);
    if (node) wb.nodes.push(node);
  }
  const edgeIds = new Set();
  for (const e of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES)) {
    const edge = normalizeEdge(e, ids, edgeIds);
    if (edge) wb.edges.push(edge);
  }
  return wb;
}

/** Asset file names (under projects/<id>/assets/) referenced by the whiteboard. */
function referencedAssets(wb, projectId) {
  const prefix = `/projects/${encodeURIComponent(projectId)}/assets/`;
  const altPrefix = `/projects/${projectId}/assets/`;
  const out = new Set();
  for (const n of (wb && wb.nodes) || []) {
    for (const key of ['src', 'poster', 'thumbnail']) {
      const v = n[key];
      if (typeof v !== 'string') continue;
      const p = v.startsWith(prefix) ? prefix : v.startsWith(altPrefix) ? altPrefix : null;
      if (p) out.add(decodeURIComponent(v.slice(p.length).split('?')[0]));
    }
  }
  return [...out];
}

/** Bounding box of a node list. */
function bounds(nodes) {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    x1 = Math.min(x1, n.x);
    y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + n.w);
    y2 = Math.max(y2, n.y + n.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** A free spot below everything that exists (new groups never overlap old content). */
function nextFreeOrigin(wb, gap = 120) {
  const b = bounds(wb.nodes);
  return wb.nodes.length ? { x: b.x, y: b.y + b.h + gap } : { x: 0, y: 0 };
}

/**
 * Add a frame containing one "board" card per uid, laid out in a grid.
 * Mutates and returns wb. Used by the analysis importer and "보드 → 화이트보드".
 */
function addBoardCards(wb, { title, uids, aspectRatio = 16 / 9, cols = 5, cardW = 220, gap = 20, origin, color, notes = {} }) {
  const ids = new Set(wb.nodes.map((n) => n.id));
  const cardH = Math.round(cardW / aspectRatio) + 40;
  const o = origin || nextFreeOrigin(wb);
  cols = Math.max(1, Math.min(12, Math.round(Number(cols) || 5)));
  const rows = Math.ceil(uids.length / cols) || 1;
  const pad = 24;
  const headH = 44;
  const hasNotes = uids.some((u) => notes && notes[u]);
  const rowGap = hasNotes ? gap + 64 : gap; // room for the note badge under each card
  let z = wb.nodes.reduce((m, n) => Math.max(m, n.z), 0);
  const frame = {
    id: newId(ids),
    type: 'frame',
    title: title || '',
    color: color || FRAME_COLORS[(wb.nodes.filter((n) => n.type === 'frame').length) % FRAME_COLORS.length],
    x: o.x,
    y: o.y,
    w: pad * 2 + Math.min(cols, uids.length || 1) * (cardW + gap) - gap,
    h: headH + pad * 2 + rows * (cardH + rowGap) - gap,
    z: ++z,
    createdAt: Date.now(),
  };
  wb.nodes.push(frame);
  const cards = [];
  uids.forEach((uid, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const card = {
      id: newId(ids),
      type: 'board',
      uid,
      x: o.x + pad + col * (cardW + gap),
      y: o.y + headH + pad + row * (cardH + rowGap),
      w: cardW,
      h: cardH,
      z: ++z,
      createdAt: Date.now(),
    };
    if (notes[uid]) card.note = String(notes[uid]).slice(0, 2000);
    wb.nodes.push(card);
    cards.push(card);
  });
  return { frame, cards };
}

/** Markdown list of everything on the whiteboard (for exports / sharing). */
function toMarkdown(wb, { title = '', boardsByUid = new Map() } = {}) {
  const out = [`# 레퍼런스 보드${title ? ` — ${title}` : ''}`, ''];
  const nodes = [...((wb && wb.nodes) || [])].sort((a, b) => a.y - b.y || a.x - b.x);
  const frames = nodes.filter((n) => n.type === 'frame');
  const inFrame = (n) => frames.find((f) => f !== n && n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h);
  const groups = new Map();
  for (const n of nodes) {
    if (n.type === 'frame') continue;
    const f = inFrame(n);
    const key = f ? f.id : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const line = (n) => {
    const note = n.note ? ` — ${n.note}` : '';
    switch (n.type) {
      case 'image': return `- 🖼 ![${n.alt || 'image'}](${n.src})${n.sourceUrl ? ` ([원본](${n.sourceUrl}))` : ''}${note}`;
      case 'video': return `- 🎞 [${n.name || 'video'}](${n.src})${note}`;
      case 'embed': return `- ▶ [${n.title || n.url}](${n.url})${n.startSeconds ? ` (${Math.floor(n.startSeconds / 60)}:${String(n.startSeconds % 60).padStart(2, '0')}~)` : ''}${n.author ? ` · ${n.author}` : ''}${note}`;
      case 'link': return `- 🔗 [${n.title || n.url}](${n.url})${n.siteName ? ` · ${n.siteName}` : ''}${note}`;
      case 'note': return `- 📝 ${String(n.text || '').replace(/\n+/g, ' / ')}`;
      case 'text': return `- ${n.text}`;
      case 'board': {
        const b = typeof boardsByUid.get === 'function' ? boardsByUid.get(n.uid) : boardsByUid[n.uid];
        return `- 🎬 보드 ${b ? b.shot : n.uid}${b && b.action ? ` — ${b.action}` : ''}${note}`;
      }
      case 'file': return `- 📎 [${n.name || 'file'}](${n.src})${note}`;
      default: return `- ${n.type}`;
    }
  };
  const emit = (list) => {
    for (const n of list) out.push(line(n));
    out.push('');
  };
  if (groups.get('')) emit(groups.get(''));
  for (const f of frames) {
    out.push(`## ${f.title || '(제목 없음)'}`, '');
    emit(groups.get(f.id) || []);
  }
  const edges = (wb && wb.edges) || [];
  if (edges.length) {
    out.push('## 연결', '');
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const label = (n) => (n ? n.title || n.text || n.name || n.alt || n.uid || n.type : '?');
    for (const e of edges) out.push(`- ${label(byId.get(e.from))} → ${label(byId.get(e.to))}${e.label ? ` (${e.label})` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

module.exports = {
  VERSION,
  NODE_TYPES,
  NOTE_COLORS,
  FRAME_COLORS,
  DEFAULT_SIZE,
  defaultWhiteboard,
  normalizeWhiteboard,
  normalizeNode,
  referencedAssets,
  bounds,
  nextFreeOrigin,
  addBoardCards,
  toMarkdown,
};
