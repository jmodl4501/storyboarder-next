'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const png = require('../server/lib/png');

/** Build a synthetic RGBA image: soft gradient background + a few dark strokes. */
function makePixels(width, height, { opaque }) {
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stroke = Math.abs(y - (x * 0.5 + 10)) < 2 || (x % 37 === 0 && y > 20);
      px[i] = stroke ? 20 : 255;
      px[i + 1] = stroke ? 20 : 250 - (y % 7);
      px[i + 2] = stroke ? 30 : 240;
      px[i + 3] = opaque ? 255 : stroke ? 255 : 0;
    }
  }
  return px;
}

/** Encode like a browser would: filter 0 everywhere, fast deflate. */
function fatPng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(require('../server/lib/zip').crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('optimize() is lossless and smaller for a transparent layer', () => {
  const w = 160;
  const h = 90;
  const pixels = makePixels(w, h, { opaque: false });
  const input = fatPng(w, h, pixels);
  const out = png.optimize(input);
  assert.ok(out.length < input.length, `expected ${out.length} < ${input.length}`);
  const decoded = png.decode(out);
  assert.equal(decoded.colorType, 6);
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.ok(decoded.pixels.equals(pixels));
});

test('optimize({stripAlpha}) drops the alpha channel only when fully opaque', () => {
  const w = 64;
  const h = 40;
  const opaque = makePixels(w, h, { opaque: true });
  const out = png.optimize(fatPng(w, h, opaque), { stripAlpha: true });
  const d = png.decode(out);
  assert.equal(d.colorType, 2);
  for (let i = 0, j = 0; i < opaque.length; i += 4, j += 3) {
    assert.equal(d.pixels[j], opaque[i]);
    assert.equal(d.pixels[j + 1], opaque[i + 1]);
    assert.equal(d.pixels[j + 2], opaque[i + 2]);
  }

  const translucent = makePixels(w, h, { opaque: false });
  const out2 = png.optimize(fatPng(w, h, translucent), { stripAlpha: true });
  assert.equal(png.decode(out2).colorType, 6);
});

test('optimize() passes unknown data through untouched', () => {
  const junk = Buffer.from('definitely not a png');
  assert.equal(png.optimize(junk), junk);
  const jpegish = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
  assert.equal(png.optimize(jpegish), jpegish);
});

test('optimizeAsync() runs in a worker and matches the sync result', async () => {
  const w = 120;
  const h = 60;
  const pixels = makePixels(w, h, { opaque: false });
  const input = fatPng(w, h, pixels);
  const [a, b] = await Promise.all([png.optimizeAsync(input), png.optimizeAsync(input)]);
  assert.ok(a.equals(png.optimize(input)));
  assert.ok(b.equals(a));
  assert.ok(png.decode(a).pixels.equals(pixels));
});
