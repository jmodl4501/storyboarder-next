// Infinite reference whiteboard (draw.io / FigJam style) backed by project.ext.whiteboard.
//
//   const wb = new Whiteboard(rootElement, { projectId, project, callbacks… });
//   wb.load(whiteboardData);           // from GET /api/projects/:id/whiteboard
//   wb.setActive(true)                 // enables paste / keyboard handling
//
// World coordinates are stored in the data; the viewport applies
// `translate(view.x, view.y) scale(view.zoom)` so screen = world * zoom + view.

import { api } from './api.js';
import { el, debounce, thumbnailName } from './util.js';
import { modal, promptDialog, toast, isModalOpen } from './ui.js';

const NOTE_COLORS = ['#FFE08A', '#FFB4A2', '#BDE0FE', '#CDEAC0', '#E4C1F9', '#F1F1F1'];
const FRAME_COLORS = ['#7C9CFF', '#FF7A4A', '#3DDC84', '#FFC857', '#C77DFF', '#9AA0A6'];
const DEFAULT_SIZE = {
  image: [320, 200], video: [400, 260], embed: [400, 260], link: [300, 120], note: [220, 160],
  text: [280, 48], frame: [800, 600], board: [220, 164], file: [240, 72],
};
const ASPECT_LOCKED = new Set(['image', 'video', 'embed', 'board']);
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?.*)?$/i;
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
const GRID = 8;
const HISTORY_MAX = 60;

const uid = () => `n${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-2)}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (v) => Math.round(v / GRID) * GRID;
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function loadImageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export class Whiteboard {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.projectId = opts.projectId || null;
    this.project = opts.project || null;
    this.data = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
    this.view = { x: 0, y: 0, zoom: 1 };
    this.selected = new Set(); // node ids
    this.selectedEdge = null;
    this.mode = 'select';
    this.spaceDown = false;
    this.active = false;
    this.editing = null; // node id whose text is being edited
    this.interactive = null; // node id whose iframe/video receives pointer events
    this.connectFrom = null;
    this.history = [];
    this.future = [];
    this.nodeEls = new Map();
    this.pointers = new Map();
    this.lastPointerWorld = null;
    this.filter = '';
    this.saveState = 'saved';
    this.saveSoon = debounce(() => this.save(), 800);
    this.saveViewportSoon = debounce(() => this.save({ viewportOnly: true }), 2500);
    this.build();
    this.bind();
  }

  /* ------------------------------------------------------------------ DOM */

  build() {
    const r = this.root;
    r.classList.add('wb');
    r.innerHTML = '';
    const tool = (id, label, title, extra = {}) => el('button', { class: 'wb-tool', 'data-mode': id, title, ...extra }, [el('span', { html: label })]);
    this.toolbar = el('div', { class: 'wb-toolbar glass', role: 'toolbar', 'aria-label': '화이트보드 도구' }, [
      tool('select', '<svg viewBox="0 0 24 24"><path d="M6 3l12 9-5 1 3 6-2 1-3-6-4 4z" fill="currentColor"/></svg>', '선택 (V)'),
      tool('hand', '<svg viewBox="0 0 24 24"><path d="M8 11V5a1.5 1.5 0 0 1 3 0v6m0-7a1.5 1.5 0 0 1 3 0v7m0-5a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-3-5a1.5 1.5 0 0 1 2.5-1.5L8 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>', '손 도구 — 끌어서 이동 (H, Space)'),
      el('span', { class: 'wb-sep' }),
      tool('note', '<svg viewBox="0 0 24 24"><path d="M4 4h16v11l-5 5H4z" fill="currentColor" opacity=".9"/><path d="M15 20v-5h5" fill="none" stroke="#0008" stroke-width="1.4"/></svg>', '스티키 노트 (N) — 빈 곳을 더블클릭해도 됩니다'),
      tool('text', '<svg viewBox="0 0 24 24"><path d="M5 5h14v4h-2V7h-4v10h2v2H9v-2h2V7H7v2H5z" fill="currentColor"/></svg>', '텍스트 (T)'),
      tool('frame', '<svg viewBox="0 0 24 24"><path d="M7 3v18M17 3v18M3 7h18M3 17h18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>', '프레임 — 영역을 끌어 그룹 만들기 (F)'),
      tool('connect', '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><path d="M7 17L17 7" stroke="currentColor" stroke-width="1.8"/></svg>', '연결선 — 노드 두 개를 차례로 클릭 (C)'),
      el('span', { class: 'wb-sep' }),
      el('button', { class: 'wb-tool', title: 'URL 붙이기 — YouTube/Vimeo는 임베드, 이미지 주소는 이미지로 (Ctrl+V로 바로 붙여넣어도 됩니다)', onclick: () => this.promptUrl() }, [el('span', { html: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' })]),
      el('button', { class: 'wb-tool', title: '파일 업로드 — 이미지 · 영상 · PDF (드래그 앤 드롭 가능)', onclick: () => this.fileInput.click() }, [el('span', { html: '<svg viewBox="0 0 24 24"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' })]),
      el('button', { class: 'wb-tool', title: '스토리보드 보드를 카드로 추가', onclick: () => this.promptAddBoards() }, [el('span', { html: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="8" height="6" rx="1" fill="currentColor"/><rect x="13" y="5" width="8" height="6" rx="1" fill="currentColor" opacity=".6"/><rect x="3" y="13" width="8" height="6" rx="1" fill="currentColor" opacity=".6"/><rect x="13" y="13" width="8" height="6" rx="1" fill="currentColor" opacity=".35"/></svg>' })]),
      el('span', { class: 'wb-sep' }),
      el('button', { class: 'wb-tool', title: '실행 취소 (Ctrl+Z)', onclick: () => this.undo() }, [el('span', { text: '↶' })]),
      el('button', { class: 'wb-tool', title: '다시 실행 (Ctrl+Shift+Z)', onclick: () => this.redo() }, [el('span', { text: '↷' })]),
    ]);
    this.searchInput = el('input', { class: 'wb-search', type: 'search', placeholder: '검색 — 제목·메모·태그·URL', title: 'Enter: 일치하는 노드로 이동' });
    this.searchCount = el('span', { class: 'wb-search-count' });
    this.searchBox = el('div', { class: 'wb-searchbox glass' }, [this.searchInput, this.searchCount]);

    this.viewport = el('div', { class: 'wb-viewport', tabindex: '0' });
    this.world = el('div', { class: 'wb-world' });
    this.edgeLayer = svgEl('svg', { class: 'wb-edges' });
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'wb-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0 0L10 5L0 10z', fill: 'context-stroke' }));
    defs.append(marker);
    this.edgeLayer.append(defs);
    this.edgeGroup = svgEl('g');
    this.edgeLayer.append(this.edgeGroup);
    this.nodeLayer = el('div', { class: 'wb-nodes' });
    this.world.append(this.edgeLayer, this.nodeLayer);
    this.marquee = el('div', { class: 'wb-marquee', hidden: true });
    this.connectLine = svgEl('svg', { class: 'wb-connect-line' });
    this.connectPath = svgEl('path', { d: '', fill: 'none' });
    this.connectLine.append(this.connectPath);
    this.connectLine.style.display = 'none';
    this.emptyHint = el('div', { class: 'wb-empty', hidden: true }, [
      el('h3', { text: '레퍼런스를 여기에 모으세요' }),
      el('p', { html: '이미지를 <b>붙여넣기(Ctrl+V)</b>하거나 파일을 <b>끌어다 놓으세요</b>.<br>YouTube / Vimeo 링크를 붙여넣으면 <b>바로 재생되는 임베드</b>가 됩니다.<br>빈 곳을 <b>더블클릭</b>하면 메모가 생깁니다. 캔버스는 무한히 넓어집니다.' }),
      el('div', { class: 'wb-empty-actions' }, [
        el('button', { class: 'btn small', text: 'URL 붙이기', onclick: () => this.promptUrl() }),
        el('button', { class: 'btn small', text: '파일 업로드', onclick: () => this.fileInput.click() }),
        el('button', { class: 'btn small', text: '보드 카드 추가', onclick: () => this.promptAddBoards() }),
      ]),
    ]);
    this.dropHint = el('div', { class: 'wb-drop-hint', hidden: true, text: '놓으면 화이트보드에 추가됩니다' });
    this.viewport.append(this.world, this.marquee, this.connectLine, this.emptyHint, this.dropHint);

    this.zoomLabel = el('button', { class: 'wb-zoom-label', title: '100% (Ctrl+0)', onclick: () => this.setZoom(1) , text: '100%' });
    this.zoomBar = el('div', { class: 'wb-zoombar glass' }, [
      el('button', { title: '축소 (-)', text: '−', onclick: () => this.zoomBy(1 / 1.25) }),
      this.zoomLabel,
      el('button', { title: '확대 (+)', text: '+', onclick: () => this.zoomBy(1.25) }),
      el('button', { title: '전체 보기 (Shift+1)', text: '⤢', onclick: () => this.fitAll() }),
    ]);
    this.selToolbar = el('div', { class: 'wb-seltoolbar glass', hidden: true });
    this.ctxMenu = el('div', { class: 'wb-ctx glass', hidden: true });
    this.fileInput = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.pdf,.json,.txt,.md,.csv', hidden: true });
    this.fileInput.addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      this.addFiles(files, this.viewportCenterWorld());
    });
    this.status = el('div', { class: 'wb-status' });
    r.append(this.toolbar, this.searchBox, this.viewport, this.zoomBar, this.selToolbar, this.ctxMenu, this.fileInput, this.status);
    this.updateModeUI();
  }

  /* ------------------------------------------------------------- state */

  load(data) {
    this.data = data && Array.isArray(data.nodes) ? data : { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
    this.data.edges = this.data.edges || [];
    const v = this.data.viewport || {};
    this.view = { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: clamp(Number(v.zoom) || 1, MIN_ZOOM, MAX_ZOOM) };
    this.selected.clear();
    this.selectedEdge = null;
    this.history = [];
    this.future = [];
    this.nodeLayer.innerHTML = '';
    this.nodeEls.clear();
    this.renderAll();
    const untouched = !data.viewport || (this.view.x === 0 && this.view.y === 0 && this.view.zoom === 1);
    if (this.data.nodes.length && untouched) requestAnimationFrame(() => this.fitAll());
    this.applyView();
  }

  setProject(project, projectId) {
    this.project = project;
    if (projectId) this.projectId = projectId;
    for (const n of this.data.nodes) if (n.type === 'board') this.renderContent(n);
  }

  setActive(on) {
    this.active = on;
    if (on) {
      requestAnimationFrame(() => this.applyView());
    } else {
      this.setInteractive(null);
      if (this.saveState === 'dirty') {
        this.saveSoon.cancel();
        this.save();
      }
    }
  }

  node(id) {
    return this.data.nodes.find((n) => n.id === id);
  }

  setStatus(s) {
    this.saveState = s;
    this.status.dataset.state = s;
    this.status.textContent = { saved: '', saving: '저장 중…', dirty: '변경됨', error: '저장 실패 — 다시 시도합니다' }[s] || '';
    if (this.opts.onStatus) this.opts.onStatus(s);
  }

  snapshot() {
    return JSON.stringify({ nodes: this.data.nodes, edges: this.data.edges });
  }

  /** Call before a mutating operation; records undo state and schedules a save afterwards via commit(). */
  begin() {
    this._pending = this.snapshot();
  }

  commit() {
    const before = this._pending;
    this._pending = null;
    if (before == null || before === this.snapshot()) return;
    this.history.push(before);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.future = [];
    this.changed();
  }

  changed() {
    this.setStatus('dirty');
    this.saveSoon();
    this.renderEdges();
    this.updateEmpty();
  }

  restore(json) {
    const d = JSON.parse(json);
    this.data.nodes = d.nodes;
    this.data.edges = d.edges;
    for (const id of [...this.selected]) if (!this.node(id)) this.selected.delete(id);
    this.renderAll();
    this.changed();
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot());
    this.restore(this.history.pop());
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot());
    this.restore(this.future.pop());
  }

  async save({ viewportOnly = false } = {}) {
    if (!this.projectId) return;
    this.data.viewport = { ...this.view };
    if (viewportOnly && this.saveState !== 'dirty') {
      // only the camera moved: persist quietly
      api.saveWhiteboard(this.projectId, this.data).catch(() => {});
      return;
    }
    this.setStatus('saving');
    try {
      const { whiteboard } = await api.saveWhiteboard(this.projectId, this.data);
      // adopt server-assigned ids for nodes that had none (rare) — keep local objects otherwise
      if (whiteboard && whiteboard.nodes.length !== this.data.nodes.length) {
        const dropped = this.data.nodes.length - whiteboard.nodes.length;
        if (dropped > 0) toast(`${dropped}개의 항목이 저장되지 않았습니다 (삭제된 보드 등)`, 'error');
      }
      this.setStatus(this.saveState === 'saving' ? 'saved' : this.saveState);
    } catch (err) {
      this.setStatus('error');
      toast(`화이트보드 저장 실패: ${err.message}`, 'error');
      setTimeout(() => this.saveSoon(), 5000);
    }
  }

  flush() {
    if (this.saveState === 'dirty') return this.save();
    return Promise.resolve();
  }

  /* ------------------------------------------------------------- view */

  applyView() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    let g = 24 * zoom;
    while (g < 12) g *= 4;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    this.world.classList.toggle('wb-far', zoom < 0.3);
    this.positionSelToolbar();
  }

  viewportRect() {
    return this.viewport.getBoundingClientRect();
  }

  toWorld(clientX, clientY) {
    const r = this.viewportRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  toScreen(wx, wy) {
    return { x: wx * this.view.zoom + this.view.x, y: wy * this.view.zoom + this.view.y };
  }

  viewportCenterWorld() {
    const r = this.viewportRect();
    return { x: (r.width / 2 - this.view.x) / this.view.zoom, y: (r.height / 2 - this.view.y) / this.view.zoom };
  }

  setZoom(zoom, cx, cy) {
    const r = this.viewportRect();
    if (cx == null) {
      cx = r.width / 2;
      cy = r.height / 2;
    }
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const wx = (cx - this.view.x) / this.view.zoom;
    const wy = (cy - this.view.y) / this.view.zoom;
    this.view.zoom = z;
    this.view.x = cx - wx * z;
    this.view.y = cy - wy * z;
    this.applyView();
    this.saveViewportSoon();
  }

  zoomBy(f, cx, cy) {
    this.setZoom(this.view.zoom * f, cx, cy);
  }

  panBy(dx, dy) {
    this.view.x += dx;
    this.view.y += dy;
    this.applyView();
    this.saveViewportSoon();
  }

  bounds(nodes) {
    if (!nodes.length) return null;
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

  fitTo(nodes, { pad = 80, maxZoom = 1.5 } = {}) {
    const b = this.bounds(nodes);
    const r = this.viewportRect();
    if (!b || !r.width) return;
    const z = clamp(Math.min((r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h)), MIN_ZOOM, maxZoom);
    this.view.zoom = z;
    this.view.x = (r.width - b.w * z) / 2 - b.x * z;
    this.view.y = (r.height - b.h * z) / 2 - b.y * z;
    this.applyView();
    this.saveViewportSoon();
  }

  fitAll() {
    if (!this.data.nodes.length) {
      this.view = { x: 0, y: 0, zoom: 1 };
      this.applyView();
      return;
    }
    this.fitTo(this.data.nodes);
  }

  fitSelection() {
    const nodes = [...this.selected].map((id) => this.node(id)).filter(Boolean);
    if (nodes.length) this.fitTo(nodes, { maxZoom: 2 });
  }

  /* ------------------------------------------------------------- render */

  renderAll() {
    const alive = new Set(this.data.nodes.map((n) => n.id));
    for (const [id, elm] of this.nodeEls) {
      if (!alive.has(id)) {
        elm.remove();
        this.nodeEls.delete(id);
      }
    }
    for (const n of this.data.nodes) {
      let elm = this.nodeEls.get(n.id);
      if (!elm) {
        elm = this.createNodeEl(n);
        this.nodeEls.set(n.id, elm);
        this.nodeLayer.append(elm);
        this.renderContent(n);
      } else if (elm.dataset.rev !== this.contentRev(n)) {
        this.renderContent(n);
      }
      this.layoutNode(n);
    }
    this.renderEdges();
    this.updateSelectionUI();
    this.updateEmpty();
    this.applyFilter();
  }

  contentRev(n) {
    // cheap fingerprint of fields that affect the inner HTML
    return [n.type, n.src, n.url, n.embedUrl, n.title, n.text, n.color, n.size, n.uid, n.name, n.thumbnail, n.note, n.poster].join('\u0001');
  }

  createNodeEl(n) {
    const elm = el('div', { class: `wb-node wb-${n.type}`, 'data-id': n.id, 'data-type': n.type });
    elm.append(el('div', { class: 'wb-content' }));
    elm.append(el('div', { class: 'wb-shield' }));
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) elm.append(el('div', { class: `wb-handle wb-h-${h}`, 'data-handle': h }));
    elm.append(el('div', { class: 'wb-badge', hidden: true }));
    return elm;
  }

  layoutNode(n) {
    const elm = this.nodeEls.get(n.id);
    if (!elm) return;
    elm.style.transform = `translate(${n.x}px, ${n.y}px)`;
    elm.style.width = `${n.w}px`;
    elm.style.height = `${n.h}px`;
    elm.style.zIndex = n.type === 'frame' ? 0 : 1000 + (n.z || 0);
    elm.classList.toggle('selected', this.selected.has(n.id));
    elm.classList.toggle('interactive', this.interactive === n.id);
    elm.classList.toggle('locked', !!n.locked);
    const badge = elm.querySelector('.wb-badge');
    if (n.note && !['note', 'text', 'frame'].includes(n.type)) {
      badge.hidden = false;
      badge.textContent = n.note;
      badge.title = n.note;
    } else badge.hidden = true;
  }

  renderContent(n) {
    const elm = this.nodeEls.get(n.id);
    if (!elm) return;
    elm.dataset.rev = this.contentRev(n);
    const c = elm.querySelector('.wb-content');
    c.innerHTML = '';
    switch (n.type) {
      case 'image': {
        const img = el('img', { src: n.src, alt: n.alt || '', draggable: 'false', loading: 'lazy' });
        img.addEventListener('load', () => {
          if (!n.natural && img.naturalWidth) n.natural = [img.naturalWidth, img.naturalHeight];
        });
        img.addEventListener('error', () => c.append(el('div', { class: 'wb-broken', text: '이미지를 불러올 수 없습니다' })));
        c.append(img);
        break;
      }
      case 'video': {
        const v = el('video', { src: n.src, controls: '', preload: 'metadata', playsinline: '' });
        if (n.poster) v.setAttribute('poster', n.poster);
        c.append(v, el('div', { class: 'wb-caption', text: n.name || '' }));
        break;
      }
      case 'embed': {
        c.append(this.embedPreview(n));
        break;
      }
      case 'link': {
        let host = '';
        try { host = new URL(n.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
        c.append(
          n.thumbnail ? el('div', { class: 'wb-link-thumb' }, [el('img', { src: n.thumbnail, alt: '', draggable: 'false', loading: 'lazy' })]) : el('div', { class: 'wb-link-thumb wb-link-nothumb', text: '🔗' }),
          el('div', { class: 'wb-link-body' }, [
            el('div', { class: 'wb-link-title', text: n.title || n.url }),
            el('div', { class: 'wb-link-meta', text: [n.siteName, host].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') }),
            n.description ? el('div', { class: 'wb-link-desc', text: n.description }) : null,
          ].filter(Boolean)),
        );
        break;
      }
      case 'note': {
        elm.style.setProperty('--note', n.color || NOTE_COLORS[0]);
        c.append(el('div', { class: 'wb-text', text: n.text || '' }));
        break;
      }
      case 'text': {
        elm.style.setProperty('--size', `${n.size || 20}px`);
        if (n.color) elm.style.setProperty('--color', n.color);
        c.append(el('div', { class: 'wb-text', text: n.text || '' }));
        break;
      }
      case 'frame': {
        elm.style.setProperty('--frame', n.color || FRAME_COLORS[0]);
        c.append(el('div', { class: 'wb-frame-title', text: n.title || '프레임' }));
        break;
      }
      case 'board': {
        const b = this.project && this.project.boards.find((x) => x.uid === n.uid);
        if (!b) {
          c.append(el('div', { class: 'wb-board-missing', text: `삭제된 보드 (${n.uid})` }));
          break;
        }
        const idx = this.project.boards.indexOf(b);
        const thumb = el('div', { class: 'wb-board-thumb' });
        if (b.layers && Object.keys(b.layers).length) thumb.append(el('img', { src: api.imageUrl(this.projectId, thumbnailName(b), b.lastEdited), alt: '', draggable: 'false', loading: 'lazy' }));
        else thumb.append(el('span', { class: 'wb-board-empty', text: '빈 보드' }));
        c.append(
          thumb,
          el('div', { class: 'wb-board-cap' }, [
            el('b', { text: b.shot || `#${idx + 1}` }),
            el('span', { text: b.action || b.dialogue || '' }),
          ]),
        );
        break;
      }
      case 'file': {
        c.append(el('div', { class: 'wb-file-icon', text: /pdf/.test(n.mime || n.src) ? 'PDF' : 'FILE' }), el('div', { class: 'wb-link-body' }, [el('div', { class: 'wb-link-title', text: n.name || 'file' }), el('div', { class: 'wb-link-meta', text: n.size ? fmtBytes(n.size) : '' })]));
        break;
      }
      default:
        c.append(el('div', { text: n.type }));
    }
  }

  embedPreview(n) {
    const wrap = el('div', { class: 'wb-embed' });
    if (this.interactive === n.id && n.embedUrl) {
      const sep = n.embedUrl.includes('?') ? '&' : '?';
      wrap.append(el('iframe', { src: `${n.embedUrl}${sep}autoplay=1`, allow: 'autoplay; fullscreen; picture-in-picture; clipboard-write', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin', title: n.title || 'embed' }));
    } else {
      if (n.thumbnail) wrap.append(el('img', { src: n.thumbnail, alt: '', draggable: 'false', loading: 'lazy' }));
      wrap.append(el('div', { class: 'wb-play', html: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>' }));
      wrap.append(el('div', { class: 'wb-embed-cap' }, [
        el('span', { class: 'wb-provider', text: n.provider === 'youtube' ? 'YouTube' : n.provider === 'vimeo' ? 'Vimeo' : (n.provider || 'web') }),
        el('span', { class: 'wb-embed-title', text: n.title || n.url }),
        n.startSeconds ? el('span', { class: 'wb-embed-time', text: `${fmtTime(n.startSeconds)}~` }) : null,
      ].filter(Boolean)));
    }
    return wrap;
  }

  edgeAnchor(a, b) {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x;
    const dy = bc.y - ac.y;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { x: a.x + a.w, y: ac.y, dir: [1, 0] } : { x: a.x, y: ac.y, dir: [-1, 0] };
    return dy > 0 ? { x: ac.x, y: a.y + a.h, dir: [0, 1] } : { x: ac.x, y: a.y, dir: [0, -1] };
  }

  edgePath(a, b) {
    const p1 = this.edgeAnchor(a, b);
    const p2 = this.edgeAnchor(b, a);
    const d = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
    const c1 = { x: p1.x + p1.dir[0] * d, y: p1.y + p1.dir[1] * d };
    const c2 = { x: p2.x + p2.dir[0] * d, y: p2.y + p2.dir[1] * d };
    return { d: `M${p1.x} ${p1.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`, mid: { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 } };
  }

  renderEdges() {
    const g = this.edgeGroup;
    g.innerHTML = '';
    const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    for (const e of this.data.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const { d, mid } = this.edgePath(a, b);
      const grp = svgEl('g', { class: `wb-edge${this.selectedEdge === e.id ? ' selected' : ''}`, 'data-edge': e.id });
      grp.append(svgEl('path', { d, class: 'wb-edge-hit' }));
      const p = svgEl('path', { d, class: 'wb-edge-line', 'marker-end': e.style === 'line' ? '' : 'url(#wb-arrow)' });
      if (e.color) p.setAttribute('stroke', e.color);
      if (e.style === 'dashed') p.setAttribute('stroke-dasharray', '8 6');
      grp.append(p);
      if (e.label) {
        const t = svgEl('text', { x: mid.x, y: mid.y, class: 'wb-edge-label', 'text-anchor': 'middle' });
        t.textContent = e.label;
        grp.append(t);
      }
      g.append(grp);
    }
  }

  updateEmpty() {
    this.emptyHint.hidden = this.data.nodes.length > 0;
  }

  /* --------------------------------------------------------- selection */

  select(ids, { add = false } = {}) {
    if (!add) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.selectedEdge = null;
    this.updateSelectionUI();
  }

  toggleSelect(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.updateSelectionUI();
  }

  clearSelection() {
    this.selected.clear();
    this.selectedEdge = null;
    this.updateSelectionUI();
  }

  selectedNodes() {
    return this.data.nodes.filter((n) => this.selected.has(n.id));
  }

  updateSelectionUI() {
    for (const n of this.data.nodes) {
      const elm = this.nodeEls.get(n.id);
      if (elm) elm.classList.toggle('selected', this.selected.has(n.id));
    }
    this.renderEdges();
    this.renderSelToolbar();
  }

  renderSelToolbar() {
    const nodes = this.selectedNodes();
    const tb = this.selToolbar;
    tb.innerHTML = '';
    if (!nodes.length && !this.selectedEdge) {
      tb.hidden = true;
      return;
    }
    const btn = (label, title, fn, cls = '') => el('button', { class: `wb-sb ${cls}`, title, text: label, onclick: (e) => { e.stopPropagation(); fn(); } });
    if (this.selectedEdge) {
      const e = this.data.edges.find((x) => x.id === this.selectedEdge);
      tb.append(
        btn('라벨', '연결선 라벨', async () => {
          const v = await promptDialog('연결선 라벨', { value: e.label || '' });
          if (v == null) return;
          this.begin();
          e.label = v.trim();
          this.commit();
        }),
        btn(e.style === 'dashed' ? '실선' : '점선', '선 스타일', () => { this.begin(); e.style = e.style === 'dashed' ? undefined : 'dashed'; this.commit(); }),
        btn(e.style === 'line' ? '화살표' : '화살표 없음', '화살표 토글', () => { this.begin(); e.style = e.style === 'line' ? undefined : 'line'; this.commit(); }),
        btn('삭제', '연결선 삭제 (Delete)', () => this.deleteSelection(), 'danger'),
      );
      tb.hidden = false;
      this.positionSelToolbar();
      return;
    }
    const one = nodes.length === 1 ? nodes[0] : null;
    const types = new Set(nodes.map((n) => n.type));
    if (one && one.type === 'board' && this.opts.onOpenBoard) tb.append(btn('보드 열기', '이 보드를 에디터에서 열기 (더블클릭)', () => this.opts.onOpenBoard(one.uid)));
    if (one && one.type === 'image' && this.opts.onUseAsReference) tb.append(btn('레퍼런스로', '현재 보드의 레퍼런스 레이어로 보내기', () => this.opts.onUseAsReference(one)));
    if (one && one.type === 'image') tb.append(btn('크게 보기', '원본 크기로 보기 (더블클릭)', () => this.openLightbox(one)));
    if (one && (one.type === 'embed' || one.type === 'link') && this.opts.onAddLinkToBoard) tb.append(btn('보드에 링크', '현재 보드의 레퍼런스 링크에 추가', () => this.opts.onAddLinkToBoard(one)));
    if (one && (one.type === 'embed' || one.type === 'link' || one.type === 'file' || one.type === 'video' || one.type === 'image')) tb.append(btn('열기 ↗', '새 탭에서 열기', () => window.open(one.url || one.src, '_blank', 'noopener')));
    if (one && one.type === 'embed') tb.append(btn(this.interactive === one.id ? '정지' : '재생', '인라인 재생 (더블클릭)', () => this.setInteractive(this.interactive === one.id ? null : one.id)));
    if (one && one.type === 'frame') tb.append(btn('이름', '프레임 이름 바꾸기', () => this.renameFrame(one)));
    if (one && one.type === 'frame') tb.append(btn('내용 선택', '프레임 안의 항목 모두 선택', () => this.select(this.childrenOf(one).map((n) => n.id))));
    if (types.has('note') || types.has('frame') || types.has('text')) {
      const palette = types.has('frame') && !types.has('note') ? FRAME_COLORS : NOTE_COLORS;
      const sw = el('span', { class: 'wb-swatches' });
      for (const color of palette) {
        sw.append(el('button', { class: 'wb-swatch', style: `--c:${color}`, title: color, onclick: (e) => { e.stopPropagation(); this.begin(); for (const n of nodes) if (n.type === 'note' || n.type === 'frame' || n.type === 'text') { n.color = color; this.renderContent(n); } this.commit(); } }));
      }
      tb.append(sw);
    }
    if (types.has('text')) {
      tb.append(btn('A−', '글자 작게', () => { this.begin(); for (const n of nodes) if (n.type === 'text') { n.size = clamp((n.size || 20) - 4, 10, 200); this.renderContent(n); } this.commit(); }));
      tb.append(btn('A+', '글자 크게', () => { this.begin(); for (const n of nodes) if (n.type === 'text') { n.size = clamp((n.size || 20) + 4, 10, 200); this.renderContent(n); } this.commit(); }));
    }
    if (one && !['note', 'text', 'frame'].includes(one.type)) tb.append(btn('메모', '이 항목에 메모 달기', async () => {
      const v = await promptDialog('메모 (카드 아래에 표시됩니다)', { value: one.note || '' });
      if (v == null) return;
      this.begin();
      one.note = v.trim();
      this.layoutNode(one);
      this.commit();
    }));
    if (one) tb.append(btn('연결 →', '다른 노드로 연결선 긋기', () => this.startConnect(one.id)));
    tb.append(btn('⤒', '맨 앞으로', () => this.reorderZ('front')));
    tb.append(btn('⤓', '맨 뒤로', () => this.reorderZ('back')));
    tb.append(btn('복제', 'Ctrl+D', () => this.duplicateSelection()));
    tb.append(btn(one && one.locked ? '잠금 해제' : '잠금', '이동/크기 조절 잠금', () => { this.begin(); const lock = !(one && one.locked); for (const n of nodes) n.locked = lock || undefined; for (const n of nodes) this.layoutNode(n); this.commit(); }));
    tb.append(btn('삭제', 'Delete', () => this.deleteSelection(), 'danger'));
    tb.hidden = false;
    this.positionSelToolbar();
  }

  positionSelToolbar() {
    const tb = this.selToolbar;
    if (tb.hidden) return;
    let b;
    if (this.selectedEdge) {
      const e = this.data.edges.find((x) => x.id === this.selectedEdge);
      const a = e && this.node(e.from);
      const c = e && this.node(e.to);
      if (!a || !c) return;
      const { mid } = this.edgePath(a, c);
      b = { x: mid.x, y: mid.y, w: 0, h: 0 };
    } else b = this.bounds(this.selectedNodes());
    if (!b) return;
    const s1 = this.toScreen(b.x, b.y);
    const s2 = this.toScreen(b.x + b.w, b.y + b.h);
    const r = this.viewportRect();
    const tw = tb.offsetWidth || 300;
    let x = (s1.x + s2.x) / 2 - tw / 2;
    x = clamp(x, 8, Math.max(8, r.width - tw - 8));
    let y = s1.y - 52;
    if (y < 64) y = Math.min(s2.y + 12, r.height - 60);
    tb.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /* ---------------------------------------------------------- mutations */

  maxZ() {
    return this.data.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0);
  }

  addNode(partial, { select = true } = {}) {
    const [dw, dh] = DEFAULT_SIZE[partial.type] || [240, 160];
    const n = { id: uid(), z: this.maxZ() + 1, createdAt: Date.now(), w: dw, h: dh, x: 0, y: 0, ...partial };
    this.begin();
    this.data.nodes.push(n);
    const elm = this.createNodeEl(n);
    this.nodeEls.set(n.id, elm);
    this.nodeLayer.append(elm);
    this.renderContent(n);
    this.layoutNode(n);
    this.commit();
    if (select) this.select([n.id]);
    this.applyFilter();
    return n;
  }

  /** Spot for new content: around `at` (world), nudged so consecutive drops cascade. */
  placeAt(at, w, h) {
    const p = at || this.viewportCenterWorld();
    this._cascade = (this._cascade || 0) % 8;
    const off = this._cascade * 24;
    this._cascade += 1;
    return { x: snap(p.x - w / 2 + off), y: snap(p.y - h / 2 + off) };
  }

  deleteSelection() {
    if (this.selectedEdge) {
      this.begin();
      this.data.edges = this.data.edges.filter((e) => e.id !== this.selectedEdge);
      this.selectedEdge = null;
      this.commit();
      this.updateSelectionUI();
      return;
    }
    if (!this.selected.size) return;
    this.begin();
    const ids = new Set(this.selected);
    this.data.nodes = this.data.nodes.filter((n) => !ids.has(n.id));
    this.data.edges = this.data.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
    for (const id of ids) {
      const elm = this.nodeEls.get(id);
      if (elm) elm.remove();
      this.nodeEls.delete(id);
    }
    this.selected.clear();
    this.commit();
    this.updateSelectionUI();
  }

  duplicateSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    this.begin();
    const map = new Map();
    let z = this.maxZ();
    const copies = nodes.map((n) => {
      const c = { ...JSON.parse(JSON.stringify(n)), id: uid(), x: n.x + 32, y: n.y + 32, z: ++z, createdAt: Date.now() };
      map.set(n.id, c.id);
      return c;
    });
    this.data.nodes.push(...copies);
    for (const e of this.data.edges) {
      if (map.has(e.from) && map.has(e.to)) this.data.edges.push({ ...e, id: `e${uid().slice(1)}`, from: map.get(e.from), to: map.get(e.to) });
    }
    this.renderAll();
    this.commit();
    this.select(copies.map((c) => c.id));
  }

  reorderZ(where) {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    this.begin();
    if (where === 'front') {
      let z = this.maxZ();
      for (const n of nodes) n.z = ++z;
    } else {
      let z = this.data.nodes.reduce((m, n) => Math.min(m, n.z || 0), 0);
      for (const n of nodes) n.z = --z;
    }
    for (const n of nodes) this.layoutNode(n);
    this.commit();
  }

  nudge(dx, dy) {
    const nodes = this.selectedNodes().filter((n) => !n.locked);
    if (!nodes.length) return;
    this.begin();
    for (const n of nodes) {
      n.x += dx;
      n.y += dy;
      this.layoutNode(n);
    }
    this.commit();
    this.positionSelToolbar();
  }

  childrenOf(frame) {
    return this.data.nodes.filter((n) => n.id !== frame.id && n.type !== 'frame' && n.x >= frame.x && n.y >= frame.y && n.x + n.w <= frame.x + frame.w && n.y + n.h <= frame.y + frame.h);
  }

  async renameFrame(n) {
    const v = await promptDialog('프레임 이름', { value: n.title || '' });
    if (v == null) return;
    this.begin();
    n.title = v.trim();
    this.renderContent(n);
    this.commit();
  }

  startConnect(fromId) {
    this.connectFrom = fromId;
    this.setMode('connect');
    toast('연결할 대상 노드를 클릭하세요 (Esc 취소)', '', 2000);
  }

  finishConnect(toId) {
    const from = this.connectFrom;
    this.connectFrom = null;
    this.connectLine.style.display = 'none';
    if (!from || !toId || from === toId) {
      if (toId && !from) {
        this.connectFrom = toId;
        return;
      }
      this.setMode('select');
      return;
    }
    if (this.data.edges.some((e) => (e.from === from && e.to === toId) || (e.from === toId && e.to === from))) {
      toast('이미 연결되어 있습니다');
    } else {
      this.begin();
      this.data.edges.push({ id: `e${uid().slice(1)}`, from, to: toId });
      this.commit();
    }
    this.setMode('select');
    this.select([toId]);
  }

  setInteractive(id) {
    const prev = this.interactive;
    this.interactive = id;
    if (prev && prev !== id) {
      const p = this.node(prev);
      if (p) {
        this.layoutNode(p);
        if (p.type === 'embed') this.renderContent(p);
      }
    }
    if (id) {
      const n = this.node(id);
      if (n) {
        this.layoutNode(n);
        if (n.type === 'embed') this.renderContent(n);
      }
    }
    this.renderSelToolbar();
  }

  /* ------------------------------------------------------ text editing */

  startEdit(n) {
    const elm = this.nodeEls.get(n.id);
    const t = elm && elm.querySelector('.wb-text');
    if (!t) return;
    this.editing = n.id;
    elm.classList.add('editing');
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = () => {
      t.removeEventListener('blur', finish);
      t.contentEditable = 'false';
      elm.classList.remove('editing');
      this.editing = null;
      const text = t.innerText.replace(/\n$/, '');
      if (text !== (n.text || '')) {
        this.begin();
        n.text = text;
        this.commit();
      }
      if (n.type === 'text') this.autosizeText(n);
      elm.dataset.rev = this.contentRev(n);
    };
    t.addEventListener('blur', finish);
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        t.blur();
      }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    });
  }

  autosizeText(n) {
    const elm = this.nodeEls.get(n.id);
    const t = elm && elm.querySelector('.wb-text');
    if (!t) return;
    const h = Math.max(32, Math.ceil(t.scrollHeight + 12));
    if (Math.abs(h - n.h) > 4) {
      n.h = h;
      this.layoutNode(n);
      this.saveSoon();
    }
  }

  /* --------------------------------------------------------- creators */

  createNoteAt(p, text = '') {
    const [w, h] = DEFAULT_SIZE.note;
    const n = this.addNode({ type: 'note', text, color: NOTE_COLORS[this.data.nodes.filter((x) => x.type === 'note').length % NOTE_COLORS.length], x: snap(p.x - w / 2), y: snap(p.y - h / 2), w, h });
    if (!text) this.startEdit(n);
    return n;
  }

  createTextAt(p, text = '') {
    const [w, h] = DEFAULT_SIZE.text;
    const n = this.addNode({ type: 'text', text, size: 20, x: snap(p.x), y: snap(p.y - h / 2), w, h });
    if (!text) this.startEdit(n);
    return n;
  }

  createFrame(rect, title = '') {
    const n = this.addNode({ type: 'frame', title, color: FRAME_COLORS[this.data.nodes.filter((x) => x.type === 'frame').length % FRAME_COLORS.length], x: snap(rect.x), y: snap(rect.y), w: Math.max(160, snap(rect.w)), h: Math.max(120, snap(rect.h)) });
    return n;
  }

  async addFromUrl(url, at) {
    url = String(url || '').trim();
    if (!isUrl(url)) return null;
    if (IMAGE_URL_RE.test(url)) return this.addImage(url, at, { sourceUrl: url });
    if (VIDEO_URL_RE.test(url) && !/youtube|vimeo/.test(url)) {
      const [w, h] = DEFAULT_SIZE.video;
      return this.addNode({ type: 'video', src: url, name: url.split('/').pop(), ...this.placeAt(at, w, h), w, h });
    }
    let info = null;
    try {
      info = await api.linkPreview(url);
    } catch (err) {
      toast(`링크 정보를 가져오지 못했습니다: ${err.message}`, 'error');
    }
    if (info && (info.provider === 'youtube' || info.provider === 'vimeo') && info.embedUrl) {
      const [w, h] = DEFAULT_SIZE.embed;
      return this.addNode({ type: 'embed', provider: info.provider, url, embedUrl: info.embedUrl, title: info.title || '', author: info.author || '', thumbnail: info.thumbnail || '', startSeconds: info.startSeconds || 0, videoId: info.id || '', ...this.placeAt(at, w, h), w, h });
    }
    if (info && info.provider === 'video' && info.url) {
      const [w, h] = DEFAULT_SIZE.video;
      return this.addNode({ type: 'video', src: info.url, name: info.title || url.split('/').pop(), ...this.placeAt(at, w, h), w, h });
    }
    const [w, h] = DEFAULT_SIZE.link;
    let hh = h;
    if (info && info.thumbnail) hh = 240;
    return this.addNode({ type: 'link', url, title: (info && info.title) || url, description: (info && info.description) || '', thumbnail: (info && info.thumbnail) || '', siteName: (info && info.siteName) || '', ...this.placeAt(at, w, hh), w, h: hh });
  }

  async addImage(src, at, extra = {}) {
    const natural = await loadImageSize(src);
    let w = 360;
    let h = 240;
    if (natural && natural[0] && natural[1]) {
      const ratio = natural[1] / natural[0];
      w = clamp(natural[0], 120, 480);
      h = Math.round(w * ratio);
    }
    return this.addNode({ type: 'image', src, natural: natural || undefined, ...this.placeAt(at, w, h), w, h, ...extra });
  }

  async addFiles(files, at) {
    if (!files.length || !this.projectId) return;
    const list = [...files];
    const ok = [];
    toast(`${list.length}개 파일 업로드 중…`, '', 1500);
    for (const f of list) {
      try {
        const asset = await api.uploadAsset(this.projectId, f);
        const mime = f.type || asset.mime || '';
        if (mime.startsWith('image/')) await this.addImage(asset.url, at, { alt: f.name });
        else if (mime.startsWith('video/')) {
          const [w, h] = DEFAULT_SIZE.video;
          this.addNode({ type: 'video', src: asset.url, name: f.name, ...this.placeAt(at, w, h), w, h });
        } else {
          const [w, h] = DEFAULT_SIZE.file;
          this.addNode({ type: 'file', src: asset.url, name: f.name, mime, size: f.size, ...this.placeAt(at, w, h), w, h });
        }
        ok.push(f.name);
      } catch (err) {
        toast(`${f.name}: ${err.message}`, 'error');
      }
    }
    if (ok.length) toast(`${ok.length}개 추가됨`, 'ok');
  }

  async addText(text, at) {
    text = String(text || '').trim();
    if (!text) return null;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const urls = lines.filter(isUrl);
    if (urls.length && urls.length === lines.length) {
      let last = null;
      for (const u of urls) last = await this.addFromUrl(u, at);
      return last;
    }
    return this.createNoteAt(at || this.viewportCenterWorld(), text.slice(0, 2000));
  }

  async promptUrl() {
    const v = await promptDialog('URL 붙이기', { placeholder: 'https://youtu.be/… · 이미지 주소 · 웹페이지', title: '링크 / 임베드 추가' });
    if (!v) return;
    const n = await this.addFromUrl(v, this.viewportCenterWorld());
    if (!n) toast('http(s) URL을 입력하세요', 'error');
  }

  async promptAddBoards() {
    if (!this.project || !this.projectId) return;
    const boards = this.project.boards;
    const which = el('select', {}, [
      el('option', { value: 'all', text: `모든 보드 (${boards.length}개)` }),
      el('option', { value: 'missing', text: '아직 화이트보드에 없는 보드만' }),
      el('option', { value: 'current', text: '현재 보드만' }),
    ]);
    const cols = el('input', { type: 'number', min: 1, max: 12, value: 5 });
    const title = el('input', { value: this.project.ext.title || this.projectId, placeholder: '프레임 이름' });
    modal({
      title: '보드 → 화이트보드 카드',
      body: el('div', { class: 'form-stack' }, [
        el('label', { text: '대상' }, [which]),
        el('div', { class: 'row2' }, [el('label', { text: '프레임 이름' }, [title]), el('label', { text: '열 수' }, [cols])]),
        el('p', { class: 'hint', text: '카드는 보드 썸네일과 함께 프레임 안에 격자로 놓입니다. 카드를 더블클릭하면 그 보드가 열립니다. 그림을 고치면 카드도 갱신됩니다.' }),
      ]),
      actions: [
        { label: '취소' },
        {
          label: '추가',
          primary: true,
          onClick: async () => {
            const have = new Set(this.data.nodes.filter((n) => n.type === 'board').map((n) => n.uid));
            let uids = boards.map((b) => b.uid);
            if (which.value === 'missing') uids = uids.filter((u) => !have.has(u));
            if (which.value === 'current' && this.opts.currentBoardUid) uids = [this.opts.currentBoardUid()].filter(Boolean);
            if (!uids.length) {
              toast('추가할 보드가 없습니다');
              return;
            }
            await this.flush();
            try {
              const { whiteboard, cards } = await api.addBoardsToWhiteboard(this.projectId, { uids, title: title.value, cols: Number(cols.value) || 5 });
              this.history.push(this.snapshot());
              this.data.nodes = whiteboard.nodes;
              this.data.edges = whiteboard.edges;
              this.renderAll();
              this.select(cards.map((c) => c.id));
              this.fitSelection();
              this.setStatus('saved');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          },
        },
      ],
    });
  }

  openLightbox(n) {
    const img = el('img', { src: n.src, alt: n.alt || '', style: 'max-width:100%;max-height:78vh;display:block;margin:0 auto;border-radius:8px' });
    modal({ title: n.alt || n.src.split('/').pop(), body: el('div', {}, [img, n.sourceUrl ? el('p', { class: 'hint' }, [el('a', { href: n.sourceUrl, target: '_blank', rel: 'noopener', text: n.sourceUrl })]) : null].filter(Boolean)), size: 'wide', actions: [{ label: '닫기' }] });
  }

  /* --------------------------------------------------------- filtering */

  nodeSearchText(n) {
    const parts = [n.title, n.text, n.note, n.url, n.name, n.alt, n.author, n.siteName, n.description, (n.tags || []).join(' ')];
    if (n.type === 'board' && this.project) {
      const b = this.project.boards.find((x) => x.uid === n.uid);
      if (b) parts.push(b.shot, b.action, b.dialogue, b.notes, (b.ext && b.ext.tags || []).join(' '));
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  applyFilter() {
    const q = this.filter.trim().toLowerCase();
    let hits = 0;
    for (const n of this.data.nodes) {
      const elm = this.nodeEls.get(n.id);
      if (!elm) continue;
      const hit = !q || this.nodeSearchText(n).includes(q);
      elm.classList.toggle('wb-dim', !!q && !hit);
      if (q && hit) hits += 1;
    }
    this.searchCount.textContent = q ? `${hits}` : '';
    this.root.classList.toggle('filtering', !!q);
  }

  /* ----------------------------------------------------------- events */

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'connect') {
      this.connectFrom = null;
      this.connectLine.style.display = 'none';
    }
    this.updateModeUI();
  }

  updateModeUI() {
    for (const b of this.toolbar.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === this.mode);
    this.viewport.dataset.mode = this.spaceDown ? 'hand' : this.mode;
  }

  isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }

  bind() {
    const vp = this.viewport;
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) this.setMode(b.dataset.mode);
    });
    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value;
      this.applyFilter();
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = this.filter.trim().toLowerCase();
        const hits = q ? this.data.nodes.filter((n) => this.nodeSearchText(n).includes(q)) : [];
        if (hits.length) {
          this.select(hits.map((n) => n.id));
          this.fitTo(hits, { maxZoom: 1.2 });
        }
      }
      if (e.key === 'Escape') {
        this.searchInput.value = '';
        this.filter = '';
        this.applyFilter();
        this.searchInput.blur();
      }
    });

    vp.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    vp.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    vp.addEventListener('pointermove', (e) => this.onPointerMove(e));
    vp.addEventListener('pointerup', (e) => this.onPointerUp(e));
    vp.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    vp.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    vp.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.ctxMenu.hidden && !e.target.closest('.wb-ctx')) this.ctxMenu.hidden = true;
    });

    // drag & drop
    ['dragenter', 'dragover'].forEach((t) => vp.addEventListener(t, (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.dropHint.hidden = false;
    }));
    vp.addEventListener('dragleave', (e) => {
      if (e.target === vp) this.dropHint.hidden = true;
    });
    vp.addEventListener('drop', (e) => this.onDrop(e));

    document.addEventListener('paste', (e) => this.onPaste(e));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && this.spaceDown) {
        this.spaceDown = false;
        this.updateModeUI();
      }
    });
    window.addEventListener('resize', () => this.positionSelToolbar());
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.viewportRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015) * 1.2);
      this.zoomBy(factor, cx, cy);
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      if (e.shiftKey && !e.deltaX) this.panBy(-e.deltaY * k, 0);
      else this.panBy(-e.deltaX * k, -e.deltaY * k);
    }
  }

  onPointerDown(e) {
    if (!this.ctxMenu.hidden) this.ctxMenu.hidden = true;
    const target = e.target;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // pinch start
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.view.zoom };
      this.drag = null;
      return;
    }
    if (target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    if (target.closest('.wb-seltoolbar, .wb-toolbar, .wb-zoombar, .wb-searchbox, .wb-empty')) return;
    const nodeEl = target.closest('.wb-node');
    const node = nodeEl ? this.node(nodeEl.dataset.id) : null;
    if (node && this.interactive === node.id && target.closest('.wb-content')) return; // let iframe/video have it
    if (this.editing && (!node || node.id !== this.editing)) document.activeElement && document.activeElement.blur();
    if (this.interactive && (!node || node.id !== this.interactive)) this.setInteractive(null);
    const p = this.toWorld(e.clientX, e.clientY);
    this.lastPointerWorld = p;
    const pan = e.button === 1 || this.spaceDown || this.mode === 'hand' || (e.button === 0 && e.altKey && !node);
    vpFocus(this.viewport);
    if (pan) {
      e.preventDefault();
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      this.viewport.setPointerCapture(e.pointerId);
      this.viewport.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const edgeEl = target.closest('[data-edge]');
    if (edgeEl) {
      this.selected.clear();
      this.selectedEdge = edgeEl.dataset.edge;
      this.updateSelectionUI();
      return;
    }
    if (this.mode === 'connect') {
      if (node) {
        if (!this.connectFrom) {
          this.connectFrom = node.id;
          this.connectLine.style.display = '';
        } else this.finishConnect(node.id);
      } else this.setMode('select');
      return;
    }
    if (this.mode === 'note' && !node) {
      this.createNoteAt(p);
      if (!e.shiftKey) this.setMode('select');
      return;
    }
    if (this.mode === 'text' && !node) {
      this.createTextAt(p);
      if (!e.shiftKey) this.setMode('select');
      return;
    }
    if (this.mode === 'frame') {
      e.preventDefault();
      this.drag = { kind: 'frame', start: p };
      this.viewport.setPointerCapture(e.pointerId);
      this.marquee.hidden = false;
      return;
    }
    const handle = target.closest('[data-handle]');
    if (handle && node && !node.locked) {
      e.preventDefault();
      this.select([node.id]);
      this.begin();
      this.drag = { kind: 'resize', node, handle: handle.dataset.handle, start: p, orig: { x: node.x, y: node.y, w: node.w, h: node.h } };
      this.viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (node) {
      e.preventDefault();
      if (e.shiftKey) this.toggleSelect(node.id);
      else if (!this.selected.has(node.id)) this.select([node.id]);
      const moving = this.selectedNodes().filter((n) => !n.locked);
      const extra = [];
      for (const f of moving) if (f.type === 'frame') for (const c of this.childrenOf(f)) if (!this.selected.has(c.id) && !c.locked) extra.push(c);
      const all = [...moving, ...extra];
      this.drag = { kind: 'move', start: p, nodes: all, orig: all.map((n) => ({ x: n.x, y: n.y })), moved: false, node };
      this.viewport.setPointerCapture(e.pointerId);
      return;
    }
    // background: marquee
    e.preventDefault();
    if (!e.shiftKey) this.clearSelection();
    this.drag = { kind: 'marquee', start: p, add: e.shiftKey };
    this.viewport.setPointerCapture(e.pointerId);
  }

  onPointerMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = this.viewportRect();
      this.setZoom(this.pinch.zoom * (dist / this.pinch.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    const p = this.toWorld(e.clientX, e.clientY);
    this.lastPointerWorld = p;
    if (this.mode === 'connect' && this.connectFrom) {
      const from = this.node(this.connectFrom);
      if (from) {
        const s = this.toScreen(from.x + from.w / 2, from.y + from.h / 2);
        const r = this.viewportRect();
        this.connectLine.style.display = '';
        this.connectPath.setAttribute('d', `M${s.x} ${s.y} L${e.clientX - r.left} ${e.clientY - r.top}`);
      }
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pan') {
      this.view.x = d.vx + (e.clientX - d.sx);
      this.view.y = d.vy + (e.clientY - d.sy);
      this.applyView();
      return;
    }
    if (d.kind === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * this.view.zoom < 3) return;
      if (!d.moved) {
        d.moved = true;
        this.begin();
      }
      if (!e.altKey) {
        dx = snap(d.orig[0].x + dx) - d.orig[0].x;
        dy = snap(d.orig[0].y + dy) - d.orig[0].y;
      }
      d.nodes.forEach((n, i) => {
        n.x = d.orig[i].x + dx;
        n.y = d.orig[i].y + dy;
        this.layoutNode(n);
      });
      this.renderEdges();
      this.positionSelToolbar();
      return;
    }
    if (d.kind === 'resize') {
      const n = d.node;
      const o = d.orig;
      const h = d.handle;
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      let { x, y, w, hgt } = { x: o.x, y: o.y, w: o.w, hgt: o.h };
      if (h.includes('e')) w = o.w + dx;
      if (h.includes('s')) hgt = o.h + dy;
      if (h.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (h.includes('n')) { hgt = o.h - dy; y = o.y + dy; }
      const lock = ASPECT_LOCKED.has(n.type) ? !e.shiftKey : e.shiftKey;
      if (lock && h.length === 2) {
        const ratio = o.h / o.w;
        if (Math.abs(w - o.w) * ratio > Math.abs(hgt - o.h)) hgt = w * ratio;
        else w = hgt / ratio;
        if (h.includes('w')) x = o.x + o.w - w;
        if (h.includes('n')) y = o.y + o.h - hgt;
      }
      w = Math.max(40, w);
      hgt = Math.max(28, hgt);
      if (!e.altKey) { w = snap(w); hgt = snap(hgt); }
      n.x = x; n.y = y; n.w = w; n.h = hgt;
      this.layoutNode(n);
      this.renderEdges();
      this.positionSelToolbar();
      return;
    }
    if (d.kind === 'marquee' || d.kind === 'frame') {
      const x1 = Math.min(d.start.x, p.x);
      const y1 = Math.min(d.start.y, p.y);
      const x2 = Math.max(d.start.x, p.x);
      const y2 = Math.max(d.start.y, p.y);
      d.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      const s1 = this.toScreen(x1, y1);
      const s2 = this.toScreen(x2, y2);
      this.marquee.hidden = false;
      this.marquee.classList.toggle('frame', d.kind === 'frame');
      this.marquee.style.transform = `translate(${s1.x}px, ${s1.y}px)`;
      this.marquee.style.width = `${s2.x - s1.x}px`;
      this.marquee.style.height = `${s2.y - s1.y}px`;
      if (d.kind === 'marquee') {
        const ids = this.data.nodes.filter((n) => {
          const inter = n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1;
          if (!inter) return false;
          if (n.type === 'frame') return n.x >= x1 && n.y >= y1 && n.x + n.w <= x2 && n.y + n.h <= y2;
          return true;
        }).map((n) => n.id);
        this.select(ids, { add: d.add });
      }
    }
  }

  onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      this.saveViewportSoon();
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.viewport.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.viewport.classList.remove('panning');
    if (d.kind === 'pan') this.saveViewportSoon();
    if (d.kind === 'move') {
      if (d.moved) this.commit();
      this.positionSelToolbar();
    }
    if (d.kind === 'resize') {
      this.commit();
      if (d.node.type === 'text') this.autosizeText(d.node);
    }
    if (d.kind === 'marquee') this.marquee.hidden = true;
    if (d.kind === 'frame') {
      this.marquee.hidden = true;
      const rect = d.rect && d.rect.w > 20 && d.rect.h > 20 ? d.rect : { x: d.start.x - 300, y: d.start.y - 200, w: 600, h: 400 };
      const f = this.createFrame(rect);
      if (!e.shiftKey) this.setMode('select');
      this.renameFrame(f);
    }
  }

  /** Element under the pointer — e.target is the viewport while pointer capture is active. */
  nodeAtPoint(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    const nodeEl = hit && hit.closest('.wb-node');
    return nodeEl ? this.node(nodeEl.dataset.id) : null;
  }

  onDoubleClick(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.closest('.wb-seltoolbar, .wb-toolbar, .wb-zoombar, .wb-searchbox, .wb-empty')) return;
    const n = this.nodeAtPoint(e.clientX, e.clientY);
    if (!n) {
      if (this.mode === 'select' || this.mode === 'hand') this.createNoteAt(this.toWorld(e.clientX, e.clientY));
      return;
    }
    switch (n.type) {
      case 'note':
      case 'text': this.startEdit(n); break;
      case 'frame': this.renameFrame(n); break;
      case 'board': if (this.opts.onOpenBoard) this.opts.onOpenBoard(n.uid); break;
      case 'image': this.openLightbox(n); break;
      case 'embed':
      case 'video': this.setInteractive(this.interactive === n.id ? null : n.id); break;
      case 'link':
      case 'file': window.open(n.url || n.src, '_blank', 'noopener'); break;
      default: break;
    }
  }

  onContextMenu(e) {
    if (e.target.closest('.wb-seltoolbar, .wb-toolbar, .wb-zoombar, .wb-searchbox')) return;
    e.preventDefault();
    const p = this.toWorld(e.clientX, e.clientY);
    const nodeEl = e.target.closest('.wb-node');
    const n = nodeEl ? this.node(nodeEl.dataset.id) : null;
    if (n && !this.selected.has(n.id)) this.select([n.id]);
    const m = this.ctxMenu;
    m.innerHTML = '';
    const item = (label, fn) => el('button', { text: label, onclick: () => { m.hidden = true; fn(); } });
    if (n) {
      m.append(item('복제', () => this.duplicateSelection()), item('맨 앞으로', () => this.reorderZ('front')), item('맨 뒤로', () => this.reorderZ('back')), item('연결선 긋기', () => this.startConnect(n.id)), item('삭제', () => this.deleteSelection()));
    } else {
      m.append(
        item('여기에 메모', () => this.createNoteAt(p)),
        item('여기에 텍스트', () => this.createTextAt(p)),
        item('여기에 프레임', () => { const f = this.createFrame({ x: p.x - 300, y: p.y - 200, w: 600, h: 400 }); this.renameFrame(f); }),
        item('URL 붙이기…', () => this.promptUrl()),
        item('클립보드 붙여넣기', () => this.pasteFromClipboardApi(p)),
        item('파일 업로드…', () => this.fileInput.click()),
        item('전체 보기', () => this.fitAll()),
      );
    }
    const r = this.root.getBoundingClientRect();
    m.hidden = false;
    m.style.transform = `translate(${Math.min(e.clientX - r.left, r.width - 200)}px, ${Math.min(e.clientY - r.top, r.height - m.offsetHeight - 8)}px)`;
  }

  async pasteFromClipboardApi(at) {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const imgType = it.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await it.getType(imgType);
            await this.addFiles([new File([blob], `clipboard.${imgType.split('/')[1] || 'png'}`, { type: imgType })], at);
            return;
          }
        }
      }
      const text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : '';
      if (text) await this.addText(text, at);
      else toast('클립보드가 비어 있습니다. Ctrl+V 로 붙여넣어 보세요');
    } catch {
      toast('브라우저가 클립보드 읽기를 막았습니다 — Ctrl+V 로 붙여넣으세요', 'error');
    }
  }

  async onPaste(e) {
    if (!this.active || isModalOpen() || this.isTyping()) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files].filter((f) => f.type);
    const at = this.lastPointerWorld && this.isPointerInside() ? this.lastPointerWorld : this.viewportCenterWorld();
    if (files.length) {
      e.preventDefault();
      await this.addFiles(files, at);
      return;
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    const uri = dt.getData('text/uri-list');
    if (html && !isUrl(text)) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const imgs = [...doc.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((s) => s && /^https?:/.test(s));
      if (imgs.length) {
        e.preventDefault();
        for (const src of imgs.slice(0, 10)) await this.addImage(src, at, { sourceUrl: doc.querySelector('a') ? doc.querySelector('a').href : '' });
        return;
      }
    }
    if (uri || text) {
      e.preventDefault();
      await this.addText(uri || text, at);
    }
  }

  isPointerInside() {
    return this.viewport.matches(':hover');
  }

  async onDrop(e) {
    e.preventDefault();
    this.dropHint.hidden = true;
    const at = this.toWorld(e.clientX, e.clientY);
    const dt = e.dataTransfer;
    const files = [...dt.files];
    if (files.length) {
      await this.addFiles(files, at);
      return;
    }
    const uri = dt.getData('text/uri-list');
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const img = doc.querySelector('img');
      const src = img && img.getAttribute('src');
      if (src && /^https?:/.test(src)) {
        await this.addImage(src, at, { sourceUrl: uri && !IMAGE_URL_RE.test(uri) ? uri : '' });
        return;
      }
    }
    if (uri || text) await this.addText(uri || text, at);
  }

  onKeyDown(e) {
    if (!this.active || isModalOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (this.isTyping()) return;
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      this.spaceDown = true;
      this.updateModeUI();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.select(this.data.nodes.map((n) => n.id)); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
    if (mod && e.key === '0') { e.preventDefault(); this.setZoom(1); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); this.zoomBy(1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); this.zoomBy(1 / 1.25); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.searchInput.focus(); return; }
    if (mod) return;
    const step = e.shiftKey ? 40 : GRID;
    switch (e.key) {
      case 'Escape':
        if (this.interactive) this.setInteractive(null);
        else if (this.mode !== 'select') this.setMode('select');
        else this.clearSelection();
        return;
      case 'Delete':
      case 'Backspace': e.preventDefault(); this.deleteSelection(); return;
      case 'ArrowLeft': e.preventDefault(); this.nudge(-step, 0); return;
      case 'ArrowRight': e.preventDefault(); this.nudge(step, 0); return;
      case 'ArrowUp': e.preventDefault(); this.nudge(0, -step); return;
      case 'ArrowDown': e.preventDefault(); this.nudge(0, step); return;
      case 'Enter': {
        const one = this.selectedNodes();
        if (one.length === 1 && (one[0].type === 'note' || one[0].type === 'text')) { e.preventDefault(); this.startEdit(one[0]); }
        return;
      }
      case '+':
      case '=': this.zoomBy(1.25); return;
      case '-': this.zoomBy(1 / 1.25); return;
      case '!': this.fitAll(); return;
      case '@': this.fitSelection(); return;
      default: break;
    }
    const k = e.key.toLowerCase();
    if (k === 'v') this.setMode('select');
    else if (k === 'h') this.setMode('hand');
    else if (k === 'n') this.setMode('note');
    else if (k === 't') this.setMode('text');
    else if (k === 'f') this.setMode('frame');
    else if (k === 'c') this.setMode('connect');
    else if (k === '1' && e.shiftKey) this.fitAll();
  }
}

function vpFocus(vp) {
  if (document.activeElement !== vp) vp.focus({ preventScroll: true });
}

export { NOTE_COLORS, FRAME_COLORS };
