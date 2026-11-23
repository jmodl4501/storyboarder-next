'use strict';

// Pure parts of the browser-side scene detector (public/js/sceneDetect.js is an
// ES module; the DOM-dependent SceneAnalyzer class is exercised by the e2e test).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'sceneDetect.js')).href;
const load = () => import(modUrl);

const W = 64;
const H = 36;

/** Synthetic RGBA frame: a smooth multi-scale texture shifted by (dx, dy), optional brightness scale. */
function frame(dx = 0, dy = 0, { seed = 1, scale = 1, flat = false } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const tex = (x, y) => {
    const k = seed * 0.37;
    return 128 + 45 * Math.sin(x / 3.1 + k) * Math.cos(y / 2.3 - k) + 35 * Math.sin((x + 2 * y) / 5.7 + 2 * k) + 25 * Math.cos(x / 1.7 - y / 4.1 + 3 * k) + 20 * Math.sin(x * y / 90 + k);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = flat ? 128 : Math.max(0, Math.min(255, tex(x - dx, y - dy)));
      const p = (y * W + x) * 4;
      data[p] = Math.min(255, v * scale);
      data[p + 1] = Math.min(255, v * scale * 0.9);
      data[p + 2] = Math.min(255, v * scale * 0.6);
      data[p + 3] = 255;
    }
  }
  return data;
}

test('compareFeatures: identical frames score 0, shifted frames are motion-compensated', async () => {
  const { sampleFeatures, compareFeatures } = await load();
  const a = sampleFeatures(frame(0, 0), W, H, 0);
  const same = compareFeatures(a, sampleFeatures(frame(0, 0), W, H, 0.1));
  assert.strictEqual(same.score, 0);
  assert.strictEqual(same.dx, 0);
  // content moved 3px right / 1px down → the estimator reports (3, 1) and explains the motion
  const moved = compareFeatures(a, sampleFeatures(frame(3, 1), W, H, 0.1));
  assert.strictEqual(moved.dx, 3);
  assert.strictEqual(moved.dy, 1);
  assert.ok(moved.raw0 > 20, `raw diff should be large (${moved.raw0})`);
  assert.ok(moved.mc < moved.raw0 * 0.3, `compensated diff should be small (${moved.mc} vs ${moved.raw0})`);
  assert.ok(moved.agree >= 0.8);
  assert.ok(moved.score < 30, `a pan must not look like a cut (${moved.score})`);
  // a completely different picture is a cut: high score, blocks disagree
  const cut = compareFeatures(a, sampleFeatures(frame(0, 0, { seed: 99, scale: 0.55 }), W, H, 0.1));
  assert.ok(cut.score > 30, `cut score ${cut.score}`);
  assert.ok(cut.agree < 0.8);
  // flat frames: no texture → no motion estimate, no false pan
  const flat = compareFeatures(sampleFeatures(frame(0, 0, { flat: true }), W, H, 0), sampleFeatures(frame(5, 0, { flat: true }), W, H, 0.1));
  assert.strictEqual(flat.dx, 0);
  assert.strictEqual(flat.score, 0);
});

test('sampleFeatures: brightness / saturation / histogram', async () => {
  const { sampleFeatures } = await load();
  const dark = sampleFeatures(frame(0, 0, { scale: 0.1 }), W, H, 0);
  const bright = sampleFeatures(frame(0, 0, { scale: 1 }), W, H, 0);
  assert.ok(dark.meanLum < 30 && bright.meanLum > dark.meanLum * 5);
  assert.ok(Math.abs(bright.hist.reduce((x, y) => x + y, 0) - 1) < 1e-6, 'histogram is normalised');
  assert.ok(bright.sat > 0.3, 'orange-ish pattern is saturated');
});

test('guessCameraMove: pans, tilts, zoom, static, handheld, subject motion', async () => {
  const { guessCameraMove } = await load();
  const base = { samples: 10, motion: 20, mc: 4, gain: 0.8, agree: 0.9, panX: 0, panY: 0, jitter: 0, panConsistencyX: 0, panConsistencyY: 0, zoom: 0, zoomConsistency: 0, slowSamples: 0 };
  assert.strictEqual(guessCameraMove({ ...base, panX: 2, panConsistencyX: 1 }), 'pan-left', 'content moving right = camera panning left');
  assert.strictEqual(guessCameraMove({ ...base, panX: -2, panConsistencyX: 1 }), 'pan-right');
  assert.strictEqual(guessCameraMove({ ...base, panY: 1, panConsistencyY: 1 }), 'tilt-up');
  assert.strictEqual(guessCameraMove({ ...base, panY: -1, panConsistencyY: 1 }), 'tilt-down');
  assert.strictEqual(guessCameraMove({ ...base, zoom: 0.6, zoomConsistency: 0.9 }), 'zoom-in');
  assert.strictEqual(guessCameraMove({ ...base, motion: 1, gain: 0 }), 'static');
  // slow zoom: nothing per sample, but a consistent divergence over the one-second window
  assert.strictEqual(guessCameraMove({ ...base, motion: 5, gain: 0, agree: 1, slowSamples: 8, slowZoom: 1.1, slowZoomConsistency: 1, slowAgree: 0.1, slowPanX: 0, slowPanY: 0, slowPanConsistencyX: 0, slowPanConsistencyY: 0 }), 'zoom-in');
  assert.strictEqual(guessCameraMove({ ...base, motion: 5, gain: 0, slowSamples: 8, slowZoom: 0, slowZoomConsistency: 0, slowAgree: 0.9, slowPanX: -2, slowPanY: 0, slowPanConsistencyX: 1, slowPanConsistencyY: 0 }), 'pan-right');
  // moving subject on a static background: compensation does not help → not a camera move
  assert.strictEqual(guessCameraMove({ ...base, motion: 15, gain: 0.05, agree: 0.3, panX: 1, panConsistencyX: 1 }), '');
  assert.strictEqual(guessCameraMove({ ...base, motion: 9, gain: 0.3, agree: 0.8, jitter: 0.6, panConsistencyX: 0.1, panConsistencyY: 0.1 }), 'handheld');
  assert.strictEqual(guessCameraMove(null), '');
});

test('describeHeuristic: honest Korean description from metrics', async () => {
  const { describeHeuristic } = await load();
  const dark = describeHeuristic({ start: 0, end: 1.2, duration: 1.2, transitionIn: 'fade-in', metrics: { brightness: 0.1, saturation: 0.2, warmth: -0.1, motion: 1, samples: 5, hue: '파랑', gain: 0, agree: 1 } }, { chapter: '오프닝' });
  assert.match(dark.action, /매우 어두운/);
  assert.match(dark.action, /차가운 톤/);
  assert.match(dark.action, /파랑/);
  assert.match(dark.action, /카메라 고정/);
  assert.strictEqual(dark.cameraMove, 'static');
  assert.match(dark.notes, /페이드 인/);
  assert.match(dark.notes, /챕터: 오프닝/);
  assert.ok(dark.tags.includes('오프닝'));
  const pan = describeHeuristic({ start: 0, end: 4, duration: 4, metrics: { brightness: 0.7, saturation: 0.4, warmth: 0.2, motion: 20, mc: 3, gain: 0.8, agree: 0.9, panX: -2.5, panY: 0, panConsistencyX: 1, panConsistencyY: 0, samples: 20, hue: '주황' } }, { transcriptText: '여기서 만나자' });
  assert.match(pan.action, /오른쪽으로 팬/);
  assert.doesNotMatch(pan.action, /정지/);
  assert.match(pan.description, /여기서 만나자/);
  assert.strictEqual(pan.mood, '따뜻함');
});

test('attachTranscript assigns cues by time overlap', async () => {
  const { attachTranscript } = await load();
  const scenes = [{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 6 }];
  attachTranscript(scenes, [
    { start: 0.2, end: 1.5, text: 'A' },
    { start: 1.9, end: 3.5, text: 'B', speaker: '민지' },
    { start: 4.9, end: 5.0, text: 'tiny' },
    { start: 5.1, end: 5.9, text: 'C' },
    { text: 'no time' },
  ]);
  assert.deepStrictEqual(scenes[0].transcript.map((t) => t.text), ['A']);
  assert.deepStrictEqual(scenes[1].transcript.map((t) => `${t.speaker}:${t.text}`), ['민지:B', ':tiny']);
  assert.deepStrictEqual(scenes[2].transcript.map((t) => t.text), ['C']);
});

test('dominantHue names the main saturated colour', async () => {
  const { dominantHue } = await load();
  const hist = new Float32Array(64);
  hist[(3 << 4) | (0 << 2) | 0] = 0.6; // pure red bin
  hist[(1 << 4) | (1 << 2) | 1] = 0.4; // grey
  assert.strictEqual(dominantHue(hist), '빨강');
  const grey = new Float32Array(64);
  grey[(2 << 4) | (2 << 2) | 2] = 1;
  assert.strictEqual(dominantHue(grey), '');
});
