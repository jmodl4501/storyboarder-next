// Browser-side scene (shot) detection for "영상 → 장면 스토리보드".
//
// The video is *played* (muted, fast) and every presented frame is sampled
// through requestVideoFrameCallback — this works for any source the browser can
// decode, including MediaRecorder WebM files without seek cues.  For every
// sample we keep a 64px luma image + a coarse colour histogram and compute a
// cut score between consecutive samples:
//
//   score = 0.6 · motion-compensated mean |Δluma|  +  0.4 · histogram distance · 255
//
// A cut is declared when the score beats both an absolute threshold and an
// adaptive multiple of the recent baseline (so hand-held or panning footage is
// not chopped), is confirmed by the following sample (flash rejection) and the
// previous scene is at least `minSceneSec` long.  Fades through black/white and
// slow dissolves (compared against the frame one second earlier) are handled
// separately.  One representative key frame per scene is captured as a JPEG.
//
// No dependencies.  See docs/VIDEO_TO_STORYBOARD.md for the tuning rationale.

const SW = 64; // sample width in pixels
const SHIFT = 8; // motion compensation search radius (sample pixels); searched coarse (step 2) then fine

export const DEFAULTS = {
  sampleFps: 8,
  threshold: 30, // 0..~150, lower = more cuts
  adaptiveRatio: 2.2,
  minSceneSec: 0.6,
  maxScenes: 300,
  playbackRate: 8,
  captureMaxWidth: 1280,
  captureOffsetSec: 0.5,
  thumbWidth: 240,
  jpegQuality: 0.86,
  detectDissolves: true,
};

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Feature vector of one sampled frame (data = RGBA bytes, w×h). */
export function sampleFeatures(data, w, h, t) {
  const n = w * h;
  const lum = new Float32Array(n);
  const hist = new Float32Array(64);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sat = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sr += r;
    sg += g;
    sb += b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sat += mx ? (mx - mn) / mx : 0;
    hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1;
  }
  for (let i = 0; i < 64; i++) hist[i] /= n;
  let meanLum = 0;
  for (let i = 0; i < n; i++) meanLum += lum[i];
  meanLum /= n;
  return { t, w, h, lum, hist, meanLum, meanR: sr / n, meanG: sg / n, meanB: sb / n, sat: sat / n };
}

// coarse candidate offsets (step 2) sorted by distance from zero, so ties prefer "no motion"
const COARSE = (() => {
  const list = [];
  for (let dy = -SHIFT; dy <= SHIFT; dy += 2) for (let dx = -SHIFT; dx <= SHIFT; dx += 2) list.push([dx, dy]);
  return list.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
})();
const FINE = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const GRID = 3; // block grid for the global-motion estimate

function blockError(a, b, x0, y0, x1, y1, dx, dy) {
  const w = a.w;
  let sum = 0;
  let cnt = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * w;
    const rb = (y + dy) * w + dx;
    for (let x = x0; x < x1; x++) {
      sum += Math.abs(a.lum[ra + x] - b.lum[rb + x]);
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

function blockSd(a, x0, y0, x1, y1) {
  const w = a.w;
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = a.lum[y * w + x];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/**
 * Motion-compensated luma difference + histogram distance between two samples.
 * The global camera motion is the median of per-block best shifts (textured
 * blocks only), so a subject moving across a plain background does not read
 * as a pan.  Returns { score, mc, raw, raw0, hd, dx, dy, agree }.
 */
export function compareFeatures(a, b) {
  const { w, h } = a;
  const inW = w - 2 * SHIFT;
  const inH = h - 2 * SHIFT;
  const bw = inW / GRID;
  const bh = inH / GRID;
  const shifts = [];
  const radial = []; // outward component of each block shift (zoom in > 0)
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = SHIFT + Math.round(gx * bw);
      const x1 = SHIFT + Math.round((gx + 1) * bw);
      const y0 = SHIFT + Math.round(gy * bh);
      const y1 = SHIFT + Math.round((gy + 1) * bh);
      if (blockSd(a, x0, y0, x1, y1) < 5) continue; // flat block: any shift fits
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (const [dx, dy] of COARSE) {
        const e = blockError(a, b, x0, y0, x1, y1, dx, dy);
        if (e < best * 0.97) {
          best = e;
          bdx = dx;
          bdy = dy;
        }
      }
      const cx = bdx;
      const cy = bdy;
      for (const [fx, fy] of FINE) {
        const dx = cx + fx;
        const dy = cy + fy;
        if (Math.abs(dx) > SHIFT || Math.abs(dy) > SHIFT || (fx === 0 && fy === 0)) continue;
        const e = blockError(a, b, x0, y0, x1, y1, dx, dy);
        if (e < best * 0.97) {
          best = e;
          bdx = dx;
          bdy = dy;
        }
      }
      shifts.push([bdx, bdy]);
      const sx = gx - (GRID - 1) / 2;
      const sy = gy - (GRID - 1) / 2;
      if (sx || sy) {
        const len = Math.hypot(sx, sy);
        radial.push((bdx * sx + bdy * sy) / len);
      }
    }
  }
  let dx = 0;
  let dy = 0;
  let agree = 0;
  let zoom = 0;
  if (radial.length >= 4) {
    const pos = radial.filter((r) => r > 0.5).length;
    const neg = radial.filter((r) => r < -0.5).length;
    if (pos >= radial.length * 0.75) zoom = radial.reduce((a, b) => a + b, 0) / radial.length;
    else if (neg >= radial.length * 0.75) zoom = radial.reduce((a, b) => a + b, 0) / radial.length;
  }
  if (shifts.length >= 2) {
    dx = Math.round(median(shifts.map((v) => v[0])));
    dy = Math.round(median(shifts.map((v) => v[1])));
    const tol = Math.floor(Math.hypot(dx, dy) * 0.25); // exact agreement for small shifts
    agree = shifts.filter((v) => Math.abs(v[0] - dx) <= tol && Math.abs(v[1] - dy) <= tol).length / shifts.length;
    if (agree < 0.5) {
      dx = 0;
      dy = 0;
    }
  }
  const raw0 = blockError(a, b, SHIFT, SHIFT, w - SHIFT, h - SHIFT, 0, 0);
  const mc = dx || dy ? blockError(a, b, SHIFT, SHIFT, w - SHIFT, h - SHIFT, dx, dy) : raw0;
  let raw = 0;
  for (let i = 0; i < a.lum.length; i++) raw += Math.abs(a.lum[i] - b.lum[i]);
  raw /= a.lum.length;
  let hd = 0;
  for (let i = 0; i < 64; i++) hd += Math.abs(a.hist[i] - b.hist[i]);
  hd *= 0.5;
  const score = 0.6 * mc + 0.4 * hd * 255;
  return { score, mc, raw, raw0, hd, dx, dy, agree, zoom };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class SceneAnalyzer extends EventTarget {
  /**
   * @param {HTMLVideoElement} video  muted element whose metadata is loaded
   * @param {object} opts  see DEFAULTS
   */
  constructor(video, opts = {}) {
    super();
    this.video = video;
    this.opts = { ...DEFAULTS, ...opts };
    this.aborted = false;
    this.scenes = [];
    this.samples = 0;
  }

  abort() {
    this.aborted = true;
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async run() {
    const v = this.video;
    const o = this.opts;
    const t0 = performance.now();
    if (v.readyState < 1) {
      await new Promise((res, rej) => {
        v.addEventListener('loadedmetadata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('영상을 열 수 없습니다 (코덱 미지원?)')), { once: true });
      });
    }
    const vw = v.videoWidth || 640;
    const vh = v.videoHeight || 360;
    const aspect = vw / vh;
    this.sw = SW;
    this.sh = Math.max(12, Math.min(64, Math.round(SW / aspect)));
    this.small = makeCanvas(this.sw, this.sh);
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    const capScale = Math.min(1, o.captureMaxWidth / vw); // never upscale
    this.capW = Math.round(vw * capScale);
    this.capH = Math.round(vh * capScale);
    this.thumbCanvas = makeCanvas(o.thumbWidth, Math.round(o.thumbWidth / aspect));
    this.duration = Number.isFinite(v.duration) ? v.duration : null;

    // state
    this.prev = null; // previous sample features
    this.recent = []; // recent scores (baseline)
    this.history = []; // {t, f} ring for dissolve detection
    this.current = null; // scene being built
    this.pending = null; // candidate cut awaiting confirmation
    this.lastT = -Infinity;
    this.blank = false;
    this.captures = []; // async blob promises
    this.firstDone = false;

    v.muted = true;
    v.playsInline = true;
    v.loop = false;
    await this.sampleFirstFrame();

    if ('requestVideoFrameCallback' in v) await this.runPlayback();
    else await this.runSeeking();

    this.closeScene(this.lastT + 1 / o.sampleFps, { final: true });
    await Promise.all(this.captures);
    const scenes = this.finalize();
    const result = { scenes, duration: this.duration || this.lastT, samples: this.samples, elapsedMs: Math.round(performance.now() - t0), aborted: this.aborted, width: vw, height: vh };
    this.emit('done', result);
    return result;
  }

  async sampleFirstFrame() {
    const v = this.video;
    if (v.readyState < 2) {
      await new Promise((res) => {
        v.addEventListener('loadeddata', res, { once: true });
        setTimeout(res, 3000);
      });
    }
    try {
      if (v.currentTime > 0.05) {
        v.currentTime = 0;
        await new Promise((res) => {
          v.addEventListener('seeked', res, { once: true });
          setTimeout(res, 1500);
        });
      }
    } catch {
      /* ignore */
    }
    this.process(v.currentTime || 0);
    this.firstDone = true;
  }

  runPlayback() {
    const v = this.video;
    const o = this.opts;
    return new Promise((resolve) => {
      let finished = false;
      let lastFrameAt = performance.now();
      let lastMedia = -1;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        v.removeEventListener('ended', finish);
        v.removeEventListener('error', finish);
        try {
          v.pause();
        } catch {
          /* ignore */
        }
        resolve();
      };
      const onFrame = (now, meta) => {
        if (finished) return;
        lastFrameAt = performance.now();
        if (this.aborted) {
          finish();
          return;
        }
        const t = meta.mediaTime;
        if (t - this.lastT >= 1 / o.sampleFps - 0.005) this.process(t);
        if (v.ended) finish();
        else v.requestVideoFrameCallback(onFrame);
      };
      const watchdog = setInterval(() => {
        if (finished) return;
        if (this.aborted || v.ended) {
          finish();
          return;
        }
        const idle = performance.now() - lastFrameAt;
        if (v.currentTime === lastMedia && idle > 4000) {
          // stalled: nudge playback, give up after a while
          if (idle > 15000) finish();
          else v.play().catch(() => {});
        }
        lastMedia = v.currentTime;
      }, 1000);
      v.addEventListener('ended', finish);
      v.addEventListener('error', finish);
      v.requestVideoFrameCallback(onFrame);
      v.playbackRate = o.playbackRate;
      v.play().catch((err) => {
        this.emit('error', { message: err.message });
        finish();
      });
    });
  }

  async runSeeking() {
    const v = this.video;
    const o = this.opts;
    const step = 1 / o.sampleFps;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    for (let t = step; t < dur; t += step) {
      if (this.aborted) break;
      v.currentTime = t;
      await new Promise((res) => {
        v.addEventListener('seeked', res, { once: true });
        setTimeout(res, 2000);
      });
      this.process(v.currentTime);
    }
  }

  /** Sample the frame currently shown by the video element at media time t. */
  process(t) {
    const v = this.video;
    const o = this.opts;
    if (t <= this.lastT) return;
    this.samples++;
    this.lastT = t;
    // small feature image (full-resolution frames are only copied when a key frame is captured)
    this.sctx.drawImage(v, 0, 0, this.sw, this.sh);
    const f = sampleFeatures(this.sctx.getImageData(0, 0, this.sw, this.sh).data, this.sw, this.sh, t);
    const blank = f.meanLum < 12 || f.meanLum > 246;

    if (!this.current) {
      if (!blank) this.openScene(t, f, { transition: this.blank ? 'fade-in' : null });
      this.blank = blank;
      this.prev = f;
      this.pushHistory(f);
      this.emitProgress(t);
      return;
    }

    let cmp = this.prev ? compareFeatures(this.prev, f) : null;
    // a cut proposed at the previous sample is confirmed by this one (single-frame flashes are rejected)
    if (this.pending && cmp) {
      const back = compareFeatures(this.pending.before, f);
      if (back.score >= o.threshold * 0.6) {
        this.commitCut(this.pending.t, this.pending.f, this.pending.cmp, 'cut');
      } else {
        // flash / glitch: the skipped sample belongs to the current scene; compare against the frame before it
        if (this.current) this.accumulate(this.current, this.pending.f, this.pending.cmp);
        cmp = back;
      }
      this.pending = null;
    }
    if (blank && !this.blank) {
      // entering black/white → close the scene here
      this.closeScene(t, { transition: 'fade-out' });
      this.current = null;
      this.blank = true;
      this.prev = f;
      this.pushHistory(f);
      this.emitProgress(t);
      return;
    }
    let cut = false;
    if (!blank && cmp && this.current) {
      const baseline = Math.max(4, median(this.recent));
      const sceneLen = t - this.current.start;
      // comparison against the frame ~1 s ago: slow camera moves (sub-pixel per sample) and dissolves
      let long = null;
      let longDt = 0;
      if (sceneLen >= 1.0) {
        const old = this.history.find((hh) => t - hh.t >= 0.9 && t - hh.t <= 1.4 && hh.t >= this.current.start);
        if (old) {
          long = compareFeatures(old.f, f);
          longDt = t - old.t;
        }
      }
      const big = cmp.score >= o.threshold && cmp.score >= baseline * o.adaptiveRatio;
      if (big && sceneLen >= o.minSceneSec) {
        // the cut happened somewhere between the previous sample and this one
        this.pending = { t: this.prev ? (this.prev.t + t) / 2 : t, f, cmp, before: this.prev };
        cut = true;
      } else if (big && this.current.stats.n <= Math.ceil(o.minSceneSec * o.sampleFps) + 1) {
        // another jump right after a cut: we were inside a transition (fade / wipe / dissolve).
        // Re-anchor the scene start here so the key frame is a clean frame.
        this.reanchorScene(t, f);
        cut = true;
      } else if (o.detectDissolves && long && sceneLen >= 1.4 && cmp.raw0 < 6 && cmp.hd < 0.06 && long.mc >= o.threshold && long.hd * 255 >= 20) {
        // slow dissolve: consecutive frames barely differ, but the frame one second ago is a different picture
        // (only when the camera is not moving — the short-window checks above exclude pans/zooms)
        this.commitCut(t - 0.45, f, long, 'dissolve');
        cut = true;
      }
      if (!cut) {
        this.recent.push(cmp.score);
        if (this.recent.length > 8) this.recent.shift();
        this.accumulate(this.current, f, cmp, long, longDt);
      }
    }
    if (this.blank && !blank && !this.current) this.openScene(t, f, { transition: 'fade-in' });
    this.blank = blank;
    this.prev = f;
    this.pushHistory(f);
    if (!this.pending) this.maybeCapture(t);
    this.emitProgress(t);
  }

  pushHistory(f) {
    this.history.push({ t: f.t, f });
    while (this.history.length && f.t - this.history[0].t > 2) this.history.shift();
  }

  reanchorScene(t, f) {
    const sc = this.current;
    sc.start = t;
    sc.transitionIn = sc.transitionIn || 'transition';
    sc.stats = { n: 0, lum: f.meanLum, sat: f.sat, warm: f.meanR - f.meanB, motion: 0, mc: 0, raw0: 0, agree: 0, zoom: 0, abszoom: 0, ln: 0, ldx: 0, ldy: 0, labsdx: 0, labsdy: 0, lzoom: 0, labszoom: 0, lagree: 0, dx: 0, dy: 0, absdx: 0, absdy: 0, hist: Float32Array.from(f.hist), lumMin: f.meanLum, lumMax: f.meanLum };
    sc.captureAt = t + this.opts.captureOffsetSec;
    this.capture(sc, t, { provisional: true });
    this.recent = [];
  }

  commitCut(t, f, cmp, kind) {
    this.closeScene(t, { cutScore: cmp.score });
    this.openScene(t, f, { transition: kind === 'dissolve' ? 'dissolve' : null, cutScore: cmp.score });
    this.recent = [];
  }

  openScene(t, f, { transition = null, cutScore = null } = {}) {
    if (this.scenes.length >= this.opts.maxScenes) {
      this.current = null;
      this.aborted = true;
      this.emit('error', { message: `최대 장면 수(${this.opts.maxScenes})에 도달해 분석을 멈췄습니다` });
      return;
    }
    this.current = {
      index: this.scenes.length,
      start: t,
      end: null,
      transitionIn: transition,
      transitionOut: null,
      cutScore,
      stats: { n: 0, lum: f.meanLum, sat: f.sat, warm: f.meanR - f.meanB, motion: 0, mc: 0, raw0: 0, agree: 0, zoom: 0, abszoom: 0, ln: 0, ldx: 0, ldy: 0, labsdx: 0, labsdy: 0, lzoom: 0, labszoom: 0, lagree: 0, dx: 0, dy: 0, absdx: 0, absdy: 0, hist: Float32Array.from(f.hist), lumMin: f.meanLum, lumMax: f.meanLum },
      keyframe: null,
      thumb: null,
      captureAt: t + this.opts.captureOffsetSec,
    };
    // provisional key frame = first frame of the scene; replaced once captureAt is reached
    this.capture(this.current, t, { provisional: true });
  }

  accumulate(scene, f, cmp, long = null, longDt = 0) {
    const s = scene.stats;
    s.n++;
    if (long && longDt > 0) {
      s.ln++;
      s.ldx += long.dx / longDt;
      s.ldy += long.dy / longDt;
      s.labsdx += Math.abs(long.dx) / longDt;
      s.labsdy += Math.abs(long.dy) / longDt;
      s.lzoom += long.zoom / longDt;
      s.labszoom += Math.abs(long.zoom) / longDt;
      s.lagree += long.agree;
    }
    s.lum += f.meanLum;
    s.sat += f.sat;
    s.warm += f.meanR - f.meanB;
    s.motion += cmp.raw;
    s.mc += cmp.mc;
    s.raw0 += cmp.raw0;
    s.agree += cmp.agree;
    s.zoom += cmp.zoom;
    s.abszoom += Math.abs(cmp.zoom);
    s.dx += cmp.dx;
    s.dy += cmp.dy;
    s.absdx += Math.abs(cmp.dx);
    s.absdy += Math.abs(cmp.dy);
    for (let i = 0; i < 64; i++) s.hist[i] += f.hist[i];
    s.lumMin = Math.min(s.lumMin, f.meanLum);
    s.lumMax = Math.max(s.lumMax, f.meanLum);
  }

  maybeCapture(t) {
    const sc = this.current;
    if (!sc || (sc.keyframe && !sc.keyframe.provisional) || t < sc.captureAt) return;
    this.capture(sc, t);
  }

  /** Copy the frame currently shown by the video element as the scene's key frame (JPEG blob + small thumbnail). */
  capture(scene, t, { provisional = false } = {}) {
    const o = this.opts;
    const canvas = makeCanvas(this.capW, this.capH);
    canvas.getContext('2d').drawImage(this.video, 0, 0, this.capW, this.capH);
    const tctx = this.thumbCanvas.getContext('2d');
    tctx.drawImage(canvas, 0, 0, this.thumbCanvas.width, this.thumbCanvas.height);
    scene.thumb = this.thumbCanvas.toDataURL('image/jpeg', 0.8);
    const kf = { time: t, width: canvas.width, height: canvas.height, blob: null, provisional };
    scene.keyframe = kf;
    const p = new Promise((res) => {
      canvas.toBlob((blob) => {
        kf.blob = blob;
        res();
      }, 'image/jpeg', o.jpegQuality);
    });
    this.captures.push(p);
  }

  closeScene(t, { cutScore = null, transition = null, final = false } = {}) {
    const sc = this.current;
    if (!sc) return;
    sc.end = Math.max(sc.start + 0.05, t);
    sc.transitionOut = transition;
    if (cutScore != null) sc.cutScoreOut = cutScore;
    if (!sc.keyframe) this.capture(sc, t);
    if (final) sc.final = true;
    this.scenes.push(sc);
    this.current = null;
    this.emit('scene', { scene: this.publicScene(sc) });
  }

  emitProgress(t) {
    const now = performance.now();
    if (this._lastProgress && now - this._lastProgress < 150) return;
    this._lastProgress = now;
    const dur = this.duration || (Number.isFinite(this.video.duration) ? this.video.duration : 0);
    this.emit('progress', { t, duration: dur, percent: dur ? Math.min(100, (t / dur) * 100) : 0, scenes: this.scenes.length });
  }

  publicScene(sc) {
    return { index: sc.index, start: sc.start, end: sc.end, thumb: sc.thumb };
  }

  /** Merge too-short scenes, compute metrics. */
  finalize() {
    const o = this.opts;
    let scenes = this.scenes.filter((s) => s.end != null);
    // merge scenes shorter than minSceneSec into their predecessor
    const merged = [];
    for (const s of scenes) {
      const last = merged[merged.length - 1];
      const dur = s.end - s.start;
      const dark = s.stats.lum / Math.max(1, s.stats.n + 1) < 26;
      if (last && dur < o.minSceneSec && !(s.transitionIn === 'fade-in' && !dark)) {
        last.end = s.end;
        if (s.transitionOut) last.transitionOut = s.transitionOut;
        // transition / blank frames only extend the previous scene; real content also merges its statistics
        if (!dark && !s.transitionIn) mergeStats(last.stats, s.stats);
        continue;
      }
      merged.push(s);
    }
    scenes = merged;
    if (!Number.isFinite(this.duration)) this.duration = scenes.length ? scenes[scenes.length - 1].end : 0;
    return scenes.map((s, i) => {
      const st = s.stats;
      const n = Math.max(1, st.n + 1);
      const samples = Math.max(1, st.n);
      const metrics = {
        brightness: st.lum / n / 255,
        saturation: st.sat / n,
        warmth: st.warm / n / 255,
        motion: st.motion / samples, // mean raw luma diff per sample (0..255)
        mc: st.mc / samples,
        gain: st.raw0 ? Math.max(0, 1 - st.mc / st.raw0) : 0, // how much of the motion a global shift explains
        agree: st.agree / samples,
        zoom: st.zoom / samples,
        zoomConsistency: st.abszoom ? Math.abs(st.zoom) / st.abszoom : 0,
        // slow (1 s window) camera motion in 64px-space pixels per second
        slowPanX: st.ln ? st.ldx / st.ln : 0,
        slowPanY: st.ln ? st.ldy / st.ln : 0,
        slowPanConsistencyX: st.labsdx ? Math.abs(st.ldx) / st.labsdx : 0,
        slowPanConsistencyY: st.labsdy ? Math.abs(st.ldy) / st.labsdy : 0,
        slowZoom: st.ln ? st.lzoom / st.ln : 0,
        slowZoomConsistency: st.labszoom ? Math.abs(st.lzoom) / st.labszoom : 0,
        slowAgree: st.ln ? st.lagree / st.ln : 0,
        slowSamples: st.ln,
        panX: st.dx / samples,
        panY: st.dy / samples,
        jitter: (st.absdx + st.absdy) / samples,
        panConsistencyX: st.absdx ? Math.abs(st.dx) / st.absdx : 0,
        panConsistencyY: st.absdy ? Math.abs(st.dy) / st.absdy : 0,
        lumRange: (st.lumMax - st.lumMin) / 255,
        hue: dominantHue(st.hist),
        samples: st.n,
      };
      return {
        index: i,
        start: s.start,
        end: s.end,
        duration: s.end - s.start,
        transitionIn: s.transitionIn,
        transitionOut: s.transitionOut,
        cutScore: s.cutScore,
        keyframe: s.keyframe,
        thumb: s.thumb,
        metrics,
      };
    });
  }
}

function mergeStats(a, b) {
  a.n += b.n + 1;
  a.lum += b.lum;
  a.sat += b.sat;
  a.warm += b.warm;
  a.motion += b.motion;
  a.mc += b.mc;
  a.raw0 += b.raw0;
  a.agree += b.agree;
  a.zoom += b.zoom;
  a.abszoom += b.abszoom;
  for (const k of ['ln', 'ldx', 'ldy', 'labsdx', 'labsdy', 'lzoom', 'labszoom', 'lagree']) a[k] += b[k];
  a.dx += b.dx;
  a.dy += b.dy;
  a.absdx += b.absdx;
  a.absdy += b.absdy;
  for (let i = 0; i < 64; i++) a.hist[i] += b.hist[i];
  a.lumMin = Math.min(a.lumMin, b.lumMin);
  a.lumMax = Math.max(a.lumMax, b.lumMax);
}

const HUE_NAMES = [
  { name: '빨강', h: 0 }, { name: '주황', h: 30 }, { name: '노랑', h: 55 }, { name: '초록', h: 120 },
  { name: '청록', h: 175 }, { name: '파랑', h: 220 }, { name: '보라', h: 275 }, { name: '분홍', h: 320 },
];

/** Dominant saturated colour name from the accumulated 4×4×4 RGB histogram. */
export function dominantHue(hist) {
  let best = null;
  let bestW = 0;
  const acc = new Map();
  for (let i = 0; i < 64; i++) {
    const w = hist[i];
    if (!w) continue;
    const r = ((i >> 4) & 3) * 85;
    const g = ((i >> 2) & 3) * 85;
    const b = (i & 3) * 85;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === 0 || (mx - mn) / mx < 0.25 || mx < 60) continue; // grey-ish / too dark
    let h;
    const d = mx - mn;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    let name = HUE_NAMES[0].name;
    let dist = 999;
    for (const hn of HUE_NAMES) {
      const dd = Math.min(Math.abs(h - hn.h), 360 - Math.abs(h - hn.h));
      if (dd < dist) {
        dist = dd;
        name = hn.name;
      }
    }
    acc.set(name, (acc.get(name) || 0) + w);
  }
  let total = 0;
  for (const [name, w] of acc) {
    total += w;
    if (w > bestW) {
      bestW = w;
      best = name;
    }
  }
  const sum = hist.reduce((a, b) => a + b, 0) || 1;
  return best && total / sum > 0.12 ? best : '';
}

/* ------------------------------------------------------------------ text */

const SHOT_LABEL = { static: '고정', 'pan-left': '왼쪽으로 팬', 'pan-right': '오른쪽으로 팬', 'tilt-up': '틸트 업', 'tilt-down': '틸트 다운', 'zoom-in': '줌 인/달리 인', 'zoom-out': '줌 아웃/달리 아웃', handheld: '핸드헬드/흔들림' };

/** Rule-based camera move guess from the motion statistics. */
export function guessCameraMove(m) {
  if (!m || !m.samples) return '';
  // panX/panY: mean content shift per sample in 64px-wide space.
  // content moving right (+x) = camera panning left; content moving down (+y) = tilt up.
  const px = m.panX;
  const py = m.panY;
  const globalMotion = (m.gain ?? 0) >= 0.3 && (m.agree ?? 0) >= 0.5;
  if (globalMotion && Math.abs(px) >= 0.45 && m.panConsistencyX >= 0.6 && Math.abs(px) >= Math.abs(py)) return px > 0 ? 'pan-left' : 'pan-right';
  if (globalMotion && Math.abs(py) >= 0.45 && m.panConsistencyY >= 0.6) return py > 0 ? 'tilt-up' : 'tilt-down';
  if (Math.abs(m.zoom ?? 0) >= 0.35 && (m.zoomConsistency ?? 0) >= 0.6) return m.zoom > 0 ? 'zoom-in' : 'zoom-out';
  // slow moves: sub-pixel per sample, but visible over a one-second window
  if ((m.slowSamples ?? 0) >= 3 && m.motion < 12) {
    const sx = m.slowPanX;
    const sy = m.slowPanY;
    // a zoom is divergent, so the blocks never agree on one translation — only the radial consistency counts
    if (Math.abs(m.slowZoom) >= 0.6 && m.slowZoomConsistency >= 0.7) return m.slowZoom > 0 ? 'zoom-in' : 'zoom-out';
    if ((m.slowAgree ?? 0) >= 0.5) {
      if (Math.abs(sx) >= 1.2 && m.slowPanConsistencyX >= 0.7 && Math.abs(sx) >= Math.abs(sy)) return sx > 0 ? 'pan-left' : 'pan-right';
      if (Math.abs(sy) >= 1.2 && m.slowPanConsistencyY >= 0.7) return sy > 0 ? 'tilt-up' : 'tilt-down';
    }
  }
  if (m.motion < 4) return 'static';
  // the compensation keeps finding offsets, but in no consistent direction → camera shake
  if (m.motion >= 6 && (m.jitter ?? 0) >= 0.4 && (m.agree ?? 0) >= 0.6 && (m.gain ?? 0) >= 0.15 && m.panConsistencyX < 0.5 && m.panConsistencyY < 0.5) return 'handheld';
  return '';
}

/**
 * Honest, rule-based description of a scene from colour / brightness / motion.
 * Used when no vision model is configured.  Returns Korean strings.
 */
export function describeHeuristic(scene, { chapter = '', transcriptText = '' } = {}) {
  const m = scene.metrics || {};
  const b = m.brightness ?? 0.5;
  const bright = b < 0.18 ? '매우 어두운' : b < 0.38 ? '어두운' : b > 0.8 ? '매우 밝은' : b > 0.62 ? '밝은' : '중간 밝기의';
  const tone = (m.saturation ?? 0) < 0.09 ? '무채색에 가까운' : (m.warmth ?? 0) > 0.07 ? '따뜻한 톤' : (m.warmth ?? 0) < -0.07 ? '차가운 톤' : '중성 톤';
  const hue = m.hue ? `${m.hue} 계열` : '';
  const cam = guessCameraMove(m);
  const mv = m.motion ?? 0;
  const motion = /^pan|^tilt|^zoom/.test(cam) ? '' : mv < 4 ? '거의 정지된 화면' : mv < 12 ? '약간의 움직임' : mv < 28 ? '피사체 움직임이 많음' : '매우 역동적인 화면';
  const camText = cam ? `카메라 ${SHOT_LABEL[cam] || cam}` : '';
  const dur = scene.duration || scene.end - scene.start;
  const pace = dur < 1 ? '아주 짧은 컷' : dur < 2.5 ? '짧은 컷' : dur > 8 ? '긴 컷' : '';
  const parts = [`${bright} ${tone}${hue ? ` (${hue})` : ''} 장면`, motion, camText, pace].filter(Boolean);
  const action = parts.join(' · ');
  const tags = [bright.replace(/의$/, ''), tone.replace(/에 가까운$/, ''), m.hue || '', chapter].filter(Boolean).slice(0, 6);
  const notes = [];
  if (chapter) notes.push(`챕터: ${chapter}`);
  if (scene.transitionIn === 'fade-in') notes.push('페이드 인으로 시작');
  else if (scene.transitionIn === 'dissolve') notes.push('디졸브로 시작');
  else if (scene.transitionIn === 'transition') notes.push('전환 효과 뒤에 시작');
  if (scene.transitionOut === 'fade-out') notes.push('페이드 아웃으로 끝남');
  const mood = b < 0.3 ? '어둡고 무거움' : (m.warmth ?? 0) > 0.07 && b > 0.5 ? '따뜻함' : (m.warmth ?? 0) < -0.07 ? '차분함/서늘함' : '';
  return { action, tags, cameraMove: cam, shotType: '', mood, notes: notes.join(' · '), description: transcriptText ? `대사/자막: ${transcriptText.slice(0, 160)}` : '' };
}

/** Attach transcript segments ({start,end,speaker,text}) to scenes by time overlap. */
export function attachTranscript(scenes, transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return scenes;
  for (const s of scenes) {
    s.transcript = transcript.filter((t) => {
      if (t.start == null || t.end == null) return false;
      const ov = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      const dur = Math.max(0.01, t.end - t.start);
      return ov >= Math.min(0.3, dur * 0.5);
    }).map((t) => ({ speaker: t.speaker || '', text: t.text }));
  }
  return scenes;
}
