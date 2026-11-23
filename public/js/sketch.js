// Stick-figure / simple-shape storyboard renderer ("졸라맨 모드") and
// key-frame outline sketches ("윤곽 스케치").  Pure canvas, deterministic
// (seeded jitter) so the same layout always renders the same picture.
//
// Layout format (what the vision model returns, see server/lib/ai/providers/openaiText.js):
//   { figures: [{ x, y, h, pose, facing, label }], shapes: [{ type, x, y, w, h, label }], horizon }
//   x,y = head centre (0..1 of frame), h = body height / frame height.
//   shapes are top-left anchored; type rect|ellipse|line ("line": x,y → x+w,y+h).

const INK = '#2a2a2e';
const INK_SOFT = '#6b6b72';
const WASH = ['#ffffff', '#ededf0', '#d5d5db', '#b9b9c2'];

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Shot type → default figure framing when the model gives no figures. */
const SHOT_FRAMING = {
  EWS: { h: 0.22, y: 0.52 },
  WS: { h: 0.4, y: 0.42 },
  FS: { h: 0.78, y: 0.2 },
  TWO: { h: 0.7, y: 0.26, two: true },
  OTS: { h: 0.9, y: 0.3, ots: true },
  MS: { h: 1.15, y: 0.28 },
  MCU: { h: 1.6, y: 0.4 },
  CU: { h: 2.4, y: 0.5 },
  ECU: { h: 4, y: 0.55 },
  POV: { h: 0, y: 0 },
  INSERT: { h: 0, y: 0, insert: true },
  LOW: { h: 0.9, y: 0.22 },
  HIGH: { h: 0.6, y: 0.4 },
  BIRD: { h: 0.3, y: 0.5 },
  DUTCH: { h: 1.0, y: 0.3, dutch: true },
};

const MOVE_LABEL = {
  'pan-left': 'PAN ←', 'pan-right': 'PAN →', 'tilt-up': 'TILT ↑', 'tilt-down': 'TILT ↓', 'dolly-in': 'DOLLY IN', 'dolly-out': 'DOLLY OUT',
  'truck-left': 'TRUCK ←', 'truck-right': 'TRUCK →', 'crane-up': 'CRANE ↑', 'crane-down': 'CRANE ↓', handheld: 'HANDHELD', 'zoom-in': 'ZOOM IN',
  'zoom-out': 'ZOOM OUT', orbit: 'ORBIT', 'rack-focus': 'RACK FOCUS', follow: 'FOLLOW', 'whip-pan': 'WHIP PAN', static: '',
};

/* ------------------------------------------------------------ primitives */

class Pen {
  constructor(ctx, rand, scale) {
    this.ctx = ctx;
    this.rand = rand;
    this.s = scale; // px per 1000 units of frame width
    this.jitter = 1.6 * scale;
  }

  j() {
    return (this.rand() - 0.5) * this.jitter;
  }

  stroke(points, { width = 3, color = INK, alpha = 1, close = false } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width * this.s;
    ctx.beginPath();
    points.forEach(([x, y], i) => {
      const px = x + this.j();
      const py = y + this.j();
      if (i === 0) ctx.moveTo(px, py);
      else {
        const [x0, y0] = points[i - 1];
        const mx = (x0 + x) / 2 + this.j() * 1.5;
        const my = (y0 + y) / 2 + this.j() * 1.5;
        ctx.quadraticCurveTo(mx, my, px, py);
      }
    });
    if (close) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  line(x0, y0, x1, y1, o) {
    this.stroke([[x0, y0], [x1, y1]], o);
  }

  ellipse(cx, cy, rx, ry, { width = 3, color = INK, alpha = 1, fill = null } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = width * this.s;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx + this.j();
      const y = cy + Math.sin(a) * ry + this.j();
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  rect(x, y, w, h, o = {}) {
    if (o.fill) {
      this.ctx.save();
      this.ctx.fillStyle = o.fill;
      this.ctx.globalAlpha = o.fillAlpha ?? 1;
      this.ctx.fillRect(x, y, w, h);
      this.ctx.restore();
    }
    this.stroke([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { ...o, close: true });
  }

  arrow(x0, y0, x1, y1, o = {}) {
    this.line(x0, y0, x1, y1, o);
    const a = Math.atan2(y1 - y0, x1 - x0);
    const L = (o.head || 14) * this.s;
    this.line(x1, y1, x1 - L * Math.cos(a - 0.5), y1 - L * Math.sin(a - 0.5), o);
    this.line(x1, y1, x1 - L * Math.cos(a + 0.5), y1 - L * Math.sin(a + 0.5), o);
  }

  text(str, x, y, { size = 22, color = INK, align = 'left', alpha = 1, bold = false, bg = null } = {}) {
    if (!str) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${bold ? '600 ' : ''}${size * this.s}px "Nanum Pen Script", "Segoe Print", "Comic Sans MS", "Noto Sans KR", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    if (bg) {
      const m = ctx.measureText(str);
      const pad = 4 * this.s;
      const w = m.width + pad * 2;
      const hh = size * this.s * 1.2;
      const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      ctx.fillStyle = bg;
      ctx.fillRect(bx - pad, y - hh / 2, w + pad, hh);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
    ctx.restore();
  }
}

/* ---------------------------------------------------------- stick figure */

/**
 * Draw a stick figure.  (hx, hy) = head centre in px, H = total body height in px.
 * pose: stand|walk|run|sit|lie|arms-up|point|crouch|wave ; facing: left|right|front|back
 */
export function drawStickFigure(pen, { hx, hy, H, pose = 'stand', facing = 'front', label = '' }, opts = {}) {
  const r = H * 0.085; // head radius
  const lw = opts.width || Math.max(2.2, Math.min(7, H / 110 + 2));
  const dir = facing === 'left' ? -1 : 1;
  const col = opts.color || INK;
  const o = { width: lw, color: col };
  const neck = [hx, hy + r];
  const torsoLen = H * 0.36;
  const legLen = H * 0.42;
  const armLen = H * 0.3;

  if (pose === 'lie') {
    // horizontal figure: head on the left (facing right) / right
    const d = dir;
    const hip = [hx + d * (r + torsoLen), hy];
    pen.ellipse(hx, hy, r, r, o);
    pen.line(hx + d * r, hy, hip[0], hip[1], o);
    pen.line(hx + d * (r + torsoLen * 0.3), hy, hx + d * (r + torsoLen * 0.3 + armLen * 0.8), hy - armLen * 0.4, o);
    pen.line(hx + d * (r + torsoLen * 0.3), hy, hx + d * (r + torsoLen * 0.3 + armLen * 0.7), hy + armLen * 0.45, o);
    pen.line(hip[0], hip[1], hip[0] + d * legLen * 0.9, hy - legLen * 0.25, o);
    pen.line(hip[0], hip[1], hip[0] + d * legLen * 0.95, hy + legLen * 0.2, o);
    if (label) pen.text(label, hx, hy - r - 26 * pen.s, { size: 20, align: 'center', color: INK_SOFT });
    return;
  }

  let hip;
  if (pose === 'sit') {
    hip = [hx, hy + r + torsoLen * 0.95];
  } else if (pose === 'crouch') {
    hip = [hx - dir * torsoLen * 0.25, hy + r + torsoLen * 0.75];
  } else {
    hip = [hx, hy + r + torsoLen];
  }
  // head (+ a tiny face hint for front/back)
  pen.ellipse(hx, hy, r, r * 1.05, o);
  if (facing === 'front' && H > 90) {
    pen.line(hx - r * 0.35, hy - r * 0.1, hx - r * 0.3, hy - r * 0.08, { ...o, width: lw * 0.8 });
    pen.line(hx + r * 0.35, hy - r * 0.1, hx + r * 0.3, hy - r * 0.08, { ...o, width: lw * 0.8 });
  } else if ((facing === 'left' || facing === 'right') && H > 90) {
    pen.line(hx + dir * r * 0.95, hy, hx + dir * r * 1.25, hy + r * 0.08, { ...o, width: lw * 0.8 }); // nose
  }
  // torso
  pen.line(neck[0], neck[1], hip[0], hip[1], o);
  const sh = [neck[0], neck[1] + torsoLen * 0.12]; // shoulder point

  // arms
  const arm = (ex, ey) => pen.line(sh[0], sh[1], ex, ey, o);
  switch (pose) {
    case 'arms-up':
      arm(sh[0] - armLen * 0.55, sh[1] - armLen * 0.8);
      arm(sh[0] + armLen * 0.55, sh[1] - armLen * 0.8);
      break;
    case 'point':
      arm(sh[0] + dir * armLen * 1.0, sh[1] - armLen * 0.1);
      arm(sh[0] - dir * armLen * 0.25, sh[1] + armLen * 0.85);
      break;
    case 'wave':
      arm(sh[0] + dir * armLen * 0.6, sh[1] - armLen * 0.75);
      arm(sh[0] - dir * armLen * 0.3, sh[1] + armLen * 0.85);
      break;
    case 'walk':
      arm(sh[0] + dir * armLen * 0.5, sh[1] + armLen * 0.7);
      arm(sh[0] - dir * armLen * 0.5, sh[1] + armLen * 0.7);
      break;
    case 'run':
      arm(sh[0] + dir * armLen * 0.7, sh[1] - armLen * 0.2);
      arm(sh[0] - dir * armLen * 0.6, sh[1] + armLen * 0.5);
      break;
    case 'sit':
      arm(sh[0] + dir * armLen * 0.7, sh[1] + armLen * 0.55);
      arm(sh[0] + dir * armLen * 0.5, sh[1] + armLen * 0.6);
      break;
    case 'crouch':
      arm(sh[0] + dir * armLen * 0.6, sh[1] + armLen * 0.7);
      arm(sh[0] + dir * armLen * 0.4, sh[1] + armLen * 0.75);
      break;
    default: // stand
      if (facing === 'front' || facing === 'back') {
        arm(sh[0] - armLen * 0.45, sh[1] + armLen * 0.85);
        arm(sh[0] + armLen * 0.45, sh[1] + armLen * 0.85);
      } else {
        arm(sh[0] + dir * armLen * 0.2, sh[1] + armLen * 0.9);
      }
  }
  // legs
  const leg = (ex, ey) => pen.line(hip[0], hip[1], ex, ey, o);
  switch (pose) {
    case 'walk':
      leg(hip[0] + dir * legLen * 0.45, hip[1] + legLen * 0.9);
      leg(hip[0] - dir * legLen * 0.35, hip[1] + legLen * 0.92);
      break;
    case 'run':
      leg(hip[0] + dir * legLen * 0.7, hip[1] + legLen * 0.7);
      leg(hip[0] - dir * legLen * 0.55, hip[1] + legLen * 0.75);
      break;
    case 'sit': {
      const knee = [hip[0] + dir * legLen * 0.55, hip[1]];
      pen.line(hip[0], hip[1], knee[0], knee[1], o);
      pen.line(knee[0], knee[1], knee[0], knee[1] + legLen * 0.6, o);
      break;
    }
    case 'crouch': {
      const knee = [hip[0] + dir * legLen * 0.6, hip[1] - legLen * 0.1];
      pen.line(hip[0], hip[1], knee[0], knee[1], o);
      pen.line(knee[0], knee[1], knee[0] - dir * legLen * 0.1, knee[1] + legLen * 0.5, o);
      break;
    }
    default:
      if (facing === 'front' || facing === 'back') {
        leg(hip[0] - legLen * 0.25, hip[1] + legLen);
        leg(hip[0] + legLen * 0.25, hip[1] + legLen);
      } else {
        leg(hip[0] + dir * legLen * 0.12, hip[1] + legLen);
        leg(hip[0] - dir * legLen * 0.08, hip[1] + legLen);
      }
  }
  if (label) pen.text(label, hx, hy - r - 24 * pen.s, { size: 20, align: 'center', color: INK_SOFT });
}

/* ------------------------------------------------------------- shapes */

function drawShape(pen, W, Hh, sh) {
  const x = sh.x * W;
  const y = sh.y * Hh;
  const w = sh.w * W;
  const h = sh.h * Hh;
  const o = { width: 2.6, color: INK_SOFT };
  if (sh.type === 'ellipse') pen.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, o);
  else if (sh.type === 'line') pen.line(x, y, x + w, y + h, o);
  else pen.rect(x, y, w, h, { ...o, fill: WASH[1], fillAlpha: 0.6 });
  if (sh.label) pen.text(sh.label, x + w / 2, sh.type === 'line' ? y - 14 * pen.s : y + h / 2, { size: 19, align: 'center', color: INK_SOFT, bg: 'rgba(255,255,255,.7)' });
}

/* --------------------------------------------------------------- edges */

/**
 * Convert an image to a simple line drawing (Sobel edges + 3-level tonal wash).
 * Returns a canvas of the requested size (image is letter-boxed/contained).
 */
export function outlineSketch(img, width, height, { strength = 1, wash = true, lines = true, alpha = 1 } = {}) {
  const iw = img.naturalWidth || img.videoWidth || img.width;
  const ih = img.naturalHeight || img.videoHeight || img.height;
  const pw = Math.min(480, iw); // processing width
  const ph = Math.max(1, Math.round((ih / iw) * pw));
  const src = makeCanvas(pw, ph);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, pw, ph);
  const data = sctx.getImageData(0, 0, pw, ph).data;
  const n = pw * ph;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  // 3x3 blur
  const bl = new Float32Array(n);
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lum[(y + dy) * pw + x + dx];
      bl[y * pw + x] = s / 9;
    }
  }
  // sobel
  const mag = new Float32Array(n);
  let sum = 0;
  let sum2 = 0;
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      const i = y * pw + x;
      const gx = -bl[i - pw - 1] - 2 * bl[i - 1] - bl[i + pw - 1] + bl[i - pw + 1] + 2 * bl[i + 1] + bl[i + pw + 1];
      const gy = -bl[i - pw - 1] - 2 * bl[i - pw] - bl[i - pw + 1] + bl[i + pw - 1] + 2 * bl[i + pw] + bl[i + pw + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      sum += m;
      sum2 += m * m;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const thr = Math.max(18, mean + sd * (1.6 / Math.max(0.2, strength)));
  // tonal levels from blurred luma (quantiles so dark footage still reads)
  const sorted = Float32Array.from(bl).sort();
  const q = (f) => sorted[Math.min(n - 1, Math.floor(f * n))];
  const dark = Math.min(q(0.22), 70);
  const mid = Math.min(q(0.5), 135);
  const out = sctx.createImageData(pw, ph);
  const od = out.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let v = 255;
    let a = 0;
    if (wash) {
      if (bl[i] < dark) {
        v = 185;
        a = 255;
      } else if (bl[i] < mid) {
        v = 222;
        a = 255;
      }
    }
    if (lines && mag[i] >= thr) {
      const k = Math.min(1, (mag[i] - thr) / (thr * 1.5) + 0.55);
      v = Math.round(255 - k * 215);
      a = 255;
    }
    od[p] = v;
    od[p + 1] = v;
    od[p + 2] = v;
    od[p + 3] = a;
  }
  sctx.putImageData(out, 0, 0);
  // scale to output with a paper-like softness
  const dst = makeCanvas(width, height);
  const dctx = dst.getContext('2d');
  const s = Math.min(width / pw, height / ph);
  const dw = pw * s;
  const dh = ph * s;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.globalAlpha = alpha;
  dctx.drawImage(src, (width - dw) / 2, (height - dh) / 2, dw, dh);
  return dst;
}

/* --------------------------------------------------------------- main */

/** Paper wash (grey for dark scenes) + optional outline sketch of the frame. */
export function renderBackground({ width, height, brightness, outline = null, outlineAlpha = 0.45 }) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const b = Number.isFinite(brightness) ? brightness : 0.6;
  ctx.fillStyle = b < 0.2 ? WASH[3] : b < 0.4 ? WASH[2] : b < 0.55 ? WASH[1] : WASH[0];
  ctx.fillRect(0, 0, width, height);
  if (outline) {
    ctx.globalAlpha = outlineAlpha;
    ctx.drawImage(outline, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }
  return canvas;
}

/**
 * Render a stick-figure storyboard panel.
 * @param {object} p
 *   width,height      output size (board surface size)
 *   layout            { figures, shapes, horizon } from the vision model (optional)
 *   shotType, cameraMove, mood, brightness (0..1)
 *   caption           small text in the corner (e.g. "S003 · 0:05.2")
 *   outline           optional HTMLImageElement/canvas of the key frame drawn faintly behind
 *   seed              deterministic jitter seed
 */
export function renderStickFigureBoard(p) {
  const W = p.width || 1600;
  const Hh = p.height || 900;
  const scale = W / 1000;
  const rand = rng(p.seed || 7);
  const canvas = makeCanvas(W, Hh);
  const ctx = canvas.getContext('2d');
  const pen = new Pen(ctx, rand, scale);
  const layout = p.layout || {};
  const figures = Array.isArray(layout.figures) ? layout.figures : null;
  const shapes = Array.isArray(layout.shapes) ? layout.shapes : [];
  const shot = String(p.shotType || '').toUpperCase();
  const framing = SHOT_FRAMING[shot] || null;

  if (!p.transparent) {
    const bg = renderBackground({ width: W, height: Hh, brightness: p.brightness, outline: p.outline, outlineAlpha: p.outlineAlpha });
    ctx.drawImage(bg, 0, 0);
  }
  // dutch angle: tilt the whole drawing a bit
  if (framing && framing.dutch) {
    ctx.translate(W / 2, Hh / 2);
    ctx.rotate(-0.12);
    ctx.translate(-W / 2, -Hh / 2);
  }

  // horizon / ground
  let horizon = layout.horizon;
  if (horizon == null && !p.outline && (!figures || !figures.length) && framing && framing.h > 0 && framing.h < 1) horizon = 0.62;
  if (horizon != null && Number.isFinite(horizon)) {
    const y = horizon * Hh;
    pen.line(-10, y, W + 10, y, { width: 2.4, color: INK_SOFT, alpha: 0.8 });
  }

  // shapes first (background objects)
  for (const sh of shapes) drawShape(pen, W, Hh, sh);

  // figures
  let figs = figures;
  if (!figs || !figs.length) {
    figs = [];
    if (!figures && framing && framing.h > 0) {
      // heuristic placeholder figure(s) from shot type
      if (framing.two) {
        figs.push({ x: 0.36, y: framing.y, h: framing.h, pose: 'stand', facing: 'right', label: '' });
        figs.push({ x: 0.64, y: framing.y, h: framing.h, pose: 'stand', facing: 'left', label: '' });
      } else if (framing.ots) {
        figs.push({ x: 0.58, y: framing.y, h: framing.h * 0.75, pose: 'stand', facing: 'front', label: '' });
        figs.push({ x: 0.18, y: 0.35, h: 1.9, pose: 'stand', facing: 'back', label: '', ots: true });
      } else {
        figs.push({ x: 0.5, y: framing.y, h: framing.h, pose: 'stand', facing: 'front', label: '' });
      }
    } else if (!figures && framing && framing.insert) {
      pen.rect(W * 0.3, Hh * 0.25, W * 0.4, Hh * 0.5, { width: 3, color: INK_SOFT });
      pen.text('INSERT', W / 2, Hh / 2, { size: 30, align: 'center', color: INK_SOFT });
    }
  }
  for (const f of figs) {
    const H = f.h * Hh;
    if (f.ots) {
      // dark shoulder/head silhouette in the foreground
      ctx.save();
      ctx.fillStyle = INK;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(f.x * W, f.y * Hh, H * 0.085, H * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(f.x * W - H * 0.05, f.y * Hh + H * 0.42, H * 0.3, H * 0.33, 0, Math.PI, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
      continue;
    }
    drawStickFigure(pen, { hx: f.x * W, hy: f.y * Hh, H, pose: f.pose, facing: f.facing, label: f.label });
  }
  if (framing && framing.dutch) ctx.setTransform(1, 0, 0, 1, 0, 0);

  // camera move marks
  const move = String(p.cameraMove || '');
  const mk = { width: 3.2, color: '#b3261e', alpha: 0.9 };
  const m = 40 * scale;
  if (/^pan|^truck/.test(move)) {
    const left = /left/.test(move);
    const y = Hh * 0.5;
    if (left) pen.arrow(W - m, y, m * 1.8, y, mk);
    else pen.arrow(m, y, W - m * 1.8, y, mk);
  } else if (/^tilt|^crane/.test(move)) {
    const up = /up/.test(move);
    const x = W * 0.92;
    if (up) pen.arrow(x, Hh - m, x, m * 1.8, mk);
    else pen.arrow(x, m, x, Hh - m * 1.8, mk);
  } else if (/dolly-in|zoom-in/.test(move)) {
    pen.rect(W * 0.22, Hh * 0.22, W * 0.56, Hh * 0.56, mk);
    pen.arrow(m, m, W * 0.2, Hh * 0.2, mk);
    pen.arrow(W - m, Hh - m, W * 0.8, Hh * 0.8, mk);
  } else if (/dolly-out|zoom-out/.test(move)) {
    pen.rect(W * 0.22, Hh * 0.22, W * 0.56, Hh * 0.56, mk);
    pen.arrow(W * 0.2, Hh * 0.2, m, m, mk);
    pen.arrow(W * 0.8, Hh * 0.8, W - m, Hh - m, mk);
  } else if (move === 'handheld' || move === 'whip-pan') {
    pen.stroke([[m, Hh - m * 1.6], [m * 2, Hh - m * 2.2], [m * 3, Hh - m * 1.5], [m * 4, Hh - m * 2.1], [m * 5, Hh - m * 1.6]], mk);
  } else if (move === 'orbit') {
    pen.ellipse(W / 2, Hh * 0.62, W * 0.3, Hh * 0.12, mk);
  }
  const label = MOVE_LABEL[move] || '';
  if (label) pen.text(label, W - m * 0.6, m * 0.75, { size: 24, align: 'right', color: '#b3261e', bold: true });
  if (shot) pen.text(shot, m * 0.6, m * 0.75, { size: 24, color: INK_SOFT, bold: true });
  if (p.caption) pen.text(p.caption, m * 0.6, Hh - m * 0.7, { size: 20, color: INK_SOFT, bg: 'rgba(255,255,255,.7)' });
  if (p.mood) pen.text(p.mood, W - m * 0.6, Hh - m * 0.7, { size: 20, align: 'right', color: INK_SOFT, bg: 'rgba(255,255,255,.7)' });
  return canvas;
}

/** Build a stick-figure layout from scene heuristics only (no vision model). */
export function heuristicLayout(scene, { shotType = '', cameraMove = '' } = {}) {
  const m = scene.metrics || {};
  // no figure knowledge: a single medium-shot placeholder, or nothing for black frames
  if ((m.brightness ?? 0.5) < 0.05) return { figures: [], shapes: [], horizon: null, shotType: '', cameraMove, placeholder: true };
  return { figures: null, shapes: [], horizon: null, shotType: shotType || 'MS', cameraMove, placeholder: true };
}
