'use strict';

/**
 * Dependency-free PNG re-compressor.
 *
 * Browsers encode canvas PNGs quickly but not compactly.  Before a board image
 * is written to disk we decode it, pick the best scanline filter per row and
 * deflate again at a high level – typically 30-50% smaller files for sketches,
 * which matters when projects live in git.  Composites (opaque, white
 * background) additionally drop their unused alpha channel.
 *
 * Only the formats a canvas produces are handled (8-bit RGBA / RGB, no
 * interlace); anything else is returned untouched.  Set PNG_OPTIMIZE=0 to skip.
 */

const zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { crc32 } = require('./zip');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a png');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo PNG scanline filtering in place. Returns pixel rows without filter bytes. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      row[x] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

/** Apply the best (lowest sum of absolute values) filter per row. */
function filterAdaptive(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const cand = candidates[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (f) {
          case 0: v = row[x]; break;
          case 1: v = row[x] - a; break;
          case 2: v = row[x] - b; break;
          case 3: v = row[x] - ((a + b) >> 1); break;
          default: v = row[x] - paeth(a, b, c);
        }
        v &= 0xff;
        cand[x] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break; // cannot win any more
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    candidates[best].copy(out, y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

/**
 * @param {Buffer} buf PNG file
 * @param {object} opts { stripAlpha?: boolean (drop alpha when fully opaque), level?: number }
 * @returns {Buffer} optimized PNG (or the original if unsupported / not smaller)
 */
function optimize(buf, opts = {}) {
  if (process.env.PNG_OPTIMIZE === '0') return buf;
  let chunks;
  try {
    chunks = readChunks(buf);
  } catch {
    return buf;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return buf;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) return buf;
  if (width * height > 50e6) return buf;

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  let bpp = colorType === 6 ? 4 : 3;
  let pixels;
  try {
    const raw = zlib.inflateSync(idat);
    if (raw.length !== (width * bpp + 1) * height) return buf;
    pixels = unfilter(raw, width, height, bpp);
  } catch {
    return buf;
  }

  let outColorType = colorType;
  if (opts.stripAlpha && colorType === 6) {
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        opaque = false;
        break;
      }
    }
    if (opaque) {
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        rgb[j] = pixels[i];
        rgb[j + 1] = pixels[i + 1];
        rgb[j + 2] = pixels[i + 2];
      }
      pixels = rgb;
      bpp = 3;
      outColorType = 2;
    }
  }

  const filtered = filterAdaptive(pixels, width, height, bpp);
  const deflated = zlib.deflateSync(filtered, { level: opts.level == null ? 9 : opts.level, memLevel: 9 });
  const newIhdr = Buffer.from(ihdr.data);
  newIhdr[9] = outColorType;
  const out = Buffer.concat([SIGNATURE, chunk('IHDR', newIhdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))]);
  return out.length < buf.length || outColorType !== colorType ? out : buf;
}

/** Decode to raw pixels (used by tests). */
function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const colorType = ihdr[9];
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  return { width, height, colorType, pixels: unfilter(raw, width, height, bpp) };
}

/** Encode raw pixels (used by tests). */
function encode({ width, height, colorType, pixels }, level = 9) {
  const bpp = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const filtered = filterAdaptive(pixels, width, height, bpp);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered, { level })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- off-main-thread variant ----------------------------------------------
// Re-compressing a 1600x900 board takes a few hundred ms of pure CPU; doing it
// on the request thread would stall every other HTTP request meanwhile.  A
// single lazily-created worker (this same file) handles the jobs sequentially.

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(__filename, { workerData: { pngWorker: true } });
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!pending.size) worker.unref();
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(Buffer.from(msg.out.buffer, msg.out.byteOffset, msg.out.length));
  });
  worker.on('error', (err) => {
    failAll(err);
    worker = null;
  });
  worker.on('exit', () => {
    failAll(new Error('png worker exited'));
    worker = null;
  });
  worker.unref();
  return worker;
}

/** Same as optimize() but runs in a worker thread. Falls back to inline work if workers fail. */
function optimizeAsync(buf, opts = {}) {
  if (process.env.PNG_OPTIMIZE === '0') return Promise.resolve(buf);
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = getWorker();
    } catch {
      resolve(optimize(buf, opts));
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, buf, opts });
  });
}

if (!isMainThread && workerData && workerData.pngWorker) {
  parentPort.on('message', ({ id, buf, opts }) => {
    try {
      const out = optimize(Buffer.from(buf.buffer, buf.byteOffset, buf.length), opts);
      parentPort.postMessage({ id, out });
    } catch (err) {
      parentPort.postMessage({ id, error: err.message || String(err) });
    }
  });
}

module.exports = { optimize, optimizeAsync, decode, encode };
