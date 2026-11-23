// Drawing engine: a stack of layer canvases (BoardSurface) + pointer handling,
// tools, undo/redo and guides (DrawingEditor).  No framework, no dependencies.

import { LAYER_ORDER, DRAWING_LAYERS } from './util.js';

export const TOOLS = {
  'light-pencil': { label: '연한 연필', layer: 'pencil', sizes: [2, 4, 8], alpha: 0.35, colors: ['#8d8d8d', '#9ab0c9', '#c9a79a', '#a3c99a', '#c4a0c9'] },
  pencil: { label: '연필', layer: 'pencil', sizes: [2.5, 5, 9], alpha: 0.9, colors: ['#2b2b2b', '#1f3a93', '#8b1a1a', '#1f6b3a', '#6b1f8b'] },
  pen: { label: '펜', layer: 'ink', sizes: [3, 6, 12], alpha: 1, colors: ['#000000', '#0b2b64', '#5c0a0a', '#0a4a2a', '#4a0a5c'] },
  brush: { label: '브러시', layer: 'tone', sizes: [26, 52, 96], alpha: 0.3, colors: ['#6e6e6e', '#4a90d9', '#d98b4a', '#6cc070', '#c06cb5'] },
  'note-pen': { label: '노트 펜', layer: 'notes', sizes: [3, 6, 12], alpha: 1, colors: ['#ff3b30', '#ff9500', '#34c759', '#007aff', '#af52de'] },
  eraser: { label: '지우개', layer: null, sizes: [16, 40, 100], alpha: 1, colors: [] },
};

const PALETTE_KEY = 'sbn.palettes.v1';

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

/** Draw an image inside w×h keeping its aspect ratio (contain), centered. */
export function drawImageContain(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class BoardSurface {
  constructor(width = 1600, height = 900) {
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.layers = {};
    for (const name of LAYER_ORDER) {
      const canvas = makeCanvas(width, height);
      this.layers[name] = { name, canvas, ctx: canvas.getContext('2d'), opacity: 1, hasContent: false, dirty: false };
    }
    this.legacyMain = false;
  }

  clear() {
    for (const layer of Object.values(this.layers)) {
      layer.ctx.clearRect(0, 0, this.width, this.height);
      layer.hasContent = false;
      layer.dirty = false;
      layer.opacity = 1;
    }
    this.legacyMain = false;
  }

  clearLayer(name) {
    const layer = this.layers[name];
    layer.ctx.clearRect(0, 0, this.width, this.height);
    layer.hasContent = false;
    layer.dirty = true;
  }

  /** Load a board's layer images.  urlFor(filename, version) -> absolute url */
  async loadBoard(board, urlFor) {
    this.clear();
    const entries = Object.entries(board.layers || {}).filter(([n, l]) => LAYER_ORDER.includes(n) && l && l.url);
    const hasDrawing = entries.some(([n]) => DRAWING_LAYERS.includes(n));
    const jobs = entries.map(([name, l]) =>
      loadImage(urlFor(l.url, board.lastEdited))
        .then((img) => {
          const layer = this.layers[name];
          layer.ctx.drawImage(img, 0, 0, this.width, this.height);
          layer.opacity = l.opacity != null ? Number(l.opacity) : 1;
          layer.hasContent = true;
        })
        .catch(() => {}),
    );
    if (!hasDrawing && board.url && board._legacyMain) {
      // Original Storyboarder 1.x files: `url` was the main drawing layer.
      jobs.push(
        loadImage(urlFor(board.url, board.lastEdited))
          .then((img) => {
            const layer = this.layers.fill;
            layer.ctx.drawImage(img, 0, 0, this.width, this.height);
            layer.hasContent = true;
            layer.dirty = true;
            this.legacyMain = true;
          })
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
  }

  /**
   * Composite the layers onto ctx.
   * opts.insertAfter / insertCanvas / insertAlpha let the editor render the
   * in-progress stroke at the right depth.
   */
  drawTo(ctx, opts = {}) {
    const { includeNotes = true, includeReference = true, scale = 1, insertAfter = null, insertCanvas = null, insertAlpha = 1 } = opts;
    const w = this.width * scale;
    const h = this.height * scale;
    for (const name of LAYER_ORDER) {
      if (name === 'notes' && !includeNotes) continue;
      if (name === 'reference' && !includeReference) continue;
      const layer = this.layers[name];
      if (layer.hasContent && layer.opacity > 0) {
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, 0, 0, w, h);
      }
      if (insertCanvas && insertAfter === name) {
        ctx.globalAlpha = insertAlpha;
        ctx.drawImage(insertCanvas, 0, 0, w, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  hasAnyContent() {
    return Object.values(this.layers).some((l) => l.hasContent);
  }

  exportLayer(name) {
    return this.layers[name].canvas.toDataURL('image/png');
  }

  /** Flattened board as JPEG (the "posterframe"): AI input + exports. */
  exportComposite({ includeNotes = false, background = '#ffffff', quality = 0.9 } = {}) {
    const c = makeCanvas(this.width, this.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
    this.drawTo(ctx, { includeNotes });
    return c.toDataURL('image/jpeg', quality);
  }

  /** Small PNG preview for the timeline (same file name convention as the original app). */
  exportThumbnail(width = 320, { includeNotes = true } = {}) {
    const scale = width / this.width;
    const c = makeCanvas(Math.round(this.width * scale), Math.round(this.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    this.drawTo(ctx, { includeNotes, scale });
    return c.toDataURL('image/png');
  }

  /** Draw an <img> into a layer (contain). Returns the affected rect. */
  placeImage(img, layerName = 'reference', { clearFirst = false } = {}) {
    const layer = this.layers[layerName];
    if (clearFirst) layer.ctx.clearRect(0, 0, this.width, this.height);
    drawImageContain(layer.ctx, img, this.width, this.height);
    layer.hasContent = true;
    layer.dirty = true;
  }
}

/* ------------------------------------------------------------------------ */

export class DrawingEditor extends EventTarget {
  constructor({ stage, canvas, overlay, surface }) {
    super();
    this.stage = stage;
    this.canvas = canvas;
    this.overlay = overlay;
    this.surface = surface;
    this.ctx = canvas.getContext('2d');
    this.octx = overlay.getContext('2d');

    this.tool = 'pencil';
    this.sizeIndex = 1;
    this.colorIndex = 0;
    this.palettes = loadPalettes();
    this.activeLayer = 'pencil';
    this.layerOverride = null;
    this.guides = { grid: false, center: false, thirds: false, safe: false };
    this.onion = false;
    this.onionImage = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndo = 40;
    this.drawing = null;
    this.scale = 1;
    this.touchDraw = true;
    this._raf = 0;

    this.strokeCanvas = makeCanvas(surface.width, surface.height);
    this.strokeCtx = this.strokeCanvas.getContext('2d');
    this.preCanvas = makeCanvas(surface.width, surface.height);
    this.preCtx = this.preCanvas.getContext('2d', { willReadFrequently: true });

    this.setSize(surface.width, surface.height);
    this._bind();
  }

  // ---- geometry ----------------------------------------------------------

  setSize(w, h) {
    this.width = w;
    this.height = h;
    for (const c of [this.canvas, this.overlay, this.strokeCanvas, this.preCanvas]) {
      c.width = w;
      c.height = h;
    }
    this.fit();
    this.render();
  }

  fit() {
    const rect = this.stage.getBoundingClientRect();
    const pad = 28;
    const availW = Math.max(50, rect.width - pad);
    const availH = Math.max(50, rect.height - pad);
    const scale = Math.min(availW / this.width, availH / this.height);
    this.scale = scale;
    const cssW = `${Math.floor(this.width * scale)}px`;
    const cssH = `${Math.floor(this.height * scale)}px`;
    for (const c of [this.canvas, this.overlay]) {
      c.style.width = cssW;
      c.style.height = cssH;
    }
    this.renderOverlay();
  }

  _point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.width) / rect.width,
      y: ((e.clientY - rect.top) * this.height) / rect.height,
      pressure: e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5,
      type: e.pointerType,
    };
  }

  // ---- tool state ----------------------------------------------------------

  setTool(name) {
    if (!TOOLS[name]) return;
    this.tool = name;
    if (TOOLS[name].layer) this.activeLayer = TOOLS[name].layer;
    this.colorIndex = Math.min(this.colorIndex, Math.max(0, (this.palettes[name] || []).length - 1));
    this._emit('toolchange');
  }

  targetLayer() {
    return this.layerOverride || TOOLS[this.tool].layer || this.activeLayer;
  }

  currentColor() {
    const p = this.palettes[this.tool] || [];
    return p[this.colorIndex] || '#000000';
  }

  setColorIndex(i) {
    this.colorIndex = i;
    this._emit('toolchange');
  }

  setPaletteColor(i, hex) {
    this.palettes[this.tool] = [...(this.palettes[this.tool] || TOOLS[this.tool].colors)];
    this.palettes[this.tool][i] = hex;
    savePalettes(this.palettes);
    this.colorIndex = i;
    this._emit('toolchange');
  }

  currentSize() {
    return TOOLS[this.tool].sizes[this.sizeIndex];
  }

  setSizeIndex(i) {
    this.sizeIndex = Math.max(0, Math.min(2, i));
    this._emit('toolchange');
  }

  setGuide(name, on) {
    this.guides[name] = on == null ? !this.guides[name] : !!on;
    this.renderOverlay();
    this._emit('toolchange');
  }

  setOnion(on, image) {
    this.onion = on == null ? !this.onion : !!on;
    if (image !== undefined) this.onionImage = image;
    this.render();
    this._emit('toolchange');
  }

  setOnionImage(image) {
    this.onionImage = image;
    this.render();
  }

  setReferenceOpacity(v) {
    this.surface.layers.reference.opacity = Math.max(0, Math.min(1, Number(v)));
    this.render();
  }

  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this._emit('historychange');
  }

  // ---- pointer handling --------------------------------------------------

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('lostpointercapture', (e) => this._up(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.fit()).observe(this.stage);
    } else {
      window.addEventListener('resize', () => this.fit());
    }
  }

  _down(e) {
    if (this.drawing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch' && !this.touchDraw) return;
    const p = this._point(e);
    if (e.altKey) {
      this.eyedrop(p);
      return;
    }
    e.preventDefault();
    // preventDefault() keeps focus where it was; make sure shortcuts work after drawing
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    try {
      this.canvas.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const tool = this.tool;
    const layerName = this.targetLayer();
    const layer = this.surface.layers[layerName];

    // snapshot for undo
    this.preCtx.clearRect(0, 0, this.width, this.height);
    this.preCtx.drawImage(layer.canvas, 0, 0);

    const size = this.currentSize();
    this.drawing = {
      pointerId: e.pointerId,
      tool,
      layerName,
      color: this.currentColor(),
      size,
      alpha: TOOLS[tool].alpha,
      straight: !!e.shiftKey,
      start: p,
      prev: p,
      lastMid: p,
      bbox: { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y },
      mileage: 0,
      pointerType: e.pointerType,
    };
    this.strokeCtx.clearRect(0, 0, this.width, this.height);
    this._dot(p);
    this.render();
  }

  _move(e) {
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = this._point(ev);
      if (d.straight) this._straight(p);
      else this._segment(p);
    }
    this.render();
  }

  _up(e) {
    const d = this.drawing;
    if (!d || (e && e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
    this.drawing = null;
    const layer = this.surface.layers[d.layerName];
    if (d.tool !== 'eraser') {
      layer.ctx.globalAlpha = d.alpha;
      layer.ctx.drawImage(this.strokeCanvas, 0, 0);
      layer.ctx.globalAlpha = 1;
    }
    layer.hasContent = true;
    layer.dirty = true;
    this._pushUndo(d.layerName, d.bbox, d.size);
    this.strokeCtx.clearRect(0, 0, this.width, this.height);
    this.render();
    this._emit('strokeend', { layer: d.layerName, mileage: d.mileage, tool: d.tool });
  }

  _ctxFor(d) {
    if (d.tool === 'eraser') {
      const ctx = this.surface.layers[d.layerName].ctx;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      return ctx;
    }
    const ctx = this.strokeCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    return ctx;
  }

  _width(d, p) {
    if (d.pointerType === 'pen') return d.size * (0.35 + p.pressure * 1.3);
    return d.size;
  }

  _dot(p) {
    const d = this.drawing;
    const ctx = this._ctxFor(d);
    ctx.beginPath();
    ctx.arc(p.x, p.y, this._width(d, p) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    this._grow(p, d.size);
  }

  _segment(p) {
    const d = this.drawing;
    const ctx = this._ctxFor(d);
    const mid = { x: (d.prev.x + p.x) / 2, y: (d.prev.y + p.y) / 2 };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this._width(d, p);
    ctx.beginPath();
    ctx.moveTo(d.lastMid.x, d.lastMid.y);
    ctx.quadraticCurveTo(d.prev.x, d.prev.y, mid.x, mid.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    d.mileage += Math.hypot(p.x - d.prev.x, p.y - d.prev.y);
    d.prev = p;
    d.lastMid = mid;
    this._grow(p, d.size);
  }

  _straight(p) {
    const d = this.drawing;
    const ctx = this._ctxFor(d);
    if (d.tool === 'eraser') {
      // eraser cannot preview; just draw segments
      this._segment(p);
      return;
    }
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineCap = 'round';
    ctx.lineWidth = this._width(d, p);
    ctx.beginPath();
    ctx.moveTo(d.start.x, d.start.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    d.mileage = Math.hypot(p.x - d.start.x, p.y - d.start.y);
    d.prev = p;
    this._grow(p, d.size);
  }

  _grow(p, size) {
    const b = this.drawing.bbox;
    const r = size + 2;
    b.minX = Math.min(b.minX, p.x - r);
    b.minY = Math.min(b.minY, p.y - r);
    b.maxX = Math.max(b.maxX, p.x + r);
    b.maxY = Math.max(b.maxY, p.y + r);
  }

  // ---- undo / redo ---------------------------------------------------------

  _rectFromBbox(bbox, size) {
    const r = Math.ceil(size * 1.6 + 4);
    const x = Math.max(0, Math.floor(bbox.minX - r));
    const y = Math.max(0, Math.floor(bbox.minY - r));
    const x2 = Math.min(this.width, Math.ceil(bbox.maxX + r));
    const y2 = Math.min(this.height, Math.ceil(bbox.maxY + r));
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  }

  _pushUndo(layerName, bbox, size) {
    const rect = this._rectFromBbox(bbox, size);
    if (rect.w <= 0 || rect.h <= 0) return;
    const layer = this.surface.layers[layerName];
    const before = this.preCtx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const after = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    this.undoStack.push({ layerName, rect, before, after });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this._emit('historychange');
  }

  _apply(entry, data) {
    const layer = this.surface.layers[entry.layerName];
    if (entry.full) {
      layer.ctx.clearRect(0, 0, this.width, this.height);
      if (data) layer.ctx.putImageData(data, 0, 0);
      layer.hasContent = !!data;
    } else {
      layer.ctx.putImageData(data, entry.rect.x, entry.rect.y);
      layer.hasContent = true;
    }
    layer.dirty = true;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this._apply(entry, entry.before);
    this.redoStack.push(entry);
    this.render();
    this._emit('historychange');
    this._emit('change', { layer: entry.layerName });
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this._apply(entry, entry.after);
    this.undoStack.push(entry);
    this.render();
    this._emit('historychange');
    this._emit('change', { layer: entry.layerName });
    return true;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  /** Clear one layer (default: the layer the current tool draws on). Undoable. */
  clearLayer(name = this.targetLayer()) {
    const layer = this.surface.layers[name];
    if (!layer.hasContent) return false;
    const before = layer.ctx.getImageData(0, 0, this.width, this.height);
    this.surface.clearLayer(name);
    this.undoStack.push({ layerName: name, full: true, before, after: null });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this.render();
    this._emit('historychange');
    this._emit('change', { layer: name });
    return true;
  }

  /** Put an image on a layer (reference import). Undoable. */
  placeImage(img, layerName = 'reference', opts = {}) {
    const layer = this.surface.layers[layerName];
    const before = layer.hasContent ? layer.ctx.getImageData(0, 0, this.width, this.height) : null;
    this.surface.placeImage(img, layerName, opts);
    const after = layer.ctx.getImageData(0, 0, this.width, this.height);
    this.undoStack.push({ layerName, full: true, before, after });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this.render();
    this._emit('historychange');
    this._emit('change', { layer: layerName });
  }

  eyedrop(p) {
    const c = makeCanvas(this.width, this.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    this.surface.drawTo(ctx);
    const [r, g, b, a] = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    if (a === 0 || this.tool === 'eraser') return;
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    this.setPaletteColor(this.colorIndex, hex);
  }

  // ---- rendering -------------------------------------------------------------

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._paint();
    });
  }

  _paint() {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.onion && this.onionImage) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(this.onionImage, 0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
    const d = this.drawing;
    const insert = d && d.tool !== 'eraser' ? { insertAfter: d.layerName, insertCanvas: this.strokeCanvas, insertAlpha: d.alpha } : {};
    this.surface.drawTo(ctx, insert);
  }

  renderOverlay() {
    const ctx = this.octx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    const lw = Math.max(1, Math.round(w / 900));
    ctx.lineWidth = lw;
    if (this.guides.grid) {
      ctx.strokeStyle = 'rgba(76,194,255,0.25)';
      const n = 12;
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        const x = (w / n) * i;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      const m = Math.round(n / (w / h));
      for (let i = 1; i < m; i++) {
        const y = (h / m) * i;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
    if (this.guides.thirds) {
      ctx.strokeStyle = 'rgba(255,107,61,0.45)';
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(w * f, 0);
        ctx.lineTo(w * f, h);
        ctx.moveTo(0, h * f);
        ctx.lineTo(w, h * f);
      }
      ctx.stroke();
    }
    if (this.guides.center) {
      ctx.strokeStyle = 'rgba(255,107,61,0.6)';
      const s = Math.min(w, h) * 0.05;
      ctx.beginPath();
      ctx.moveTo(w / 2 - s, h / 2);
      ctx.lineTo(w / 2 + s, h / 2);
      ctx.moveTo(w / 2, h / 2 - s);
      ctx.lineTo(w / 2, h / 2 + s);
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, s);
      ctx.moveTo(w / 2, h - s);
      ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2);
      ctx.lineTo(s, h / 2);
      ctx.moveTo(w - s, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }
    if (this.guides.safe) {
      ctx.setLineDash([lw * 6, lw * 6]);
      ctx.strokeStyle = 'rgba(61,220,132,0.6)';
      ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
      ctx.strokeStyle = 'rgba(61,220,132,0.35)';
      ctx.strokeRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
      ctx.setLineDash([]);
    }
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function loadPalettes() {
  const defaults = Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, [...v.colors]]));
  try {
    const saved = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(defaults)) if (Array.isArray(saved[k]) && saved[k].length === defaults[k].length) defaults[k] = saved[k];
    }
  } catch {
    /* ignore */
  }
  return defaults;
}

function savePalettes(p) {
  try {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
