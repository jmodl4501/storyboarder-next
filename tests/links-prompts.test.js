'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lp = require('../server/lib/linkPreview');
const pb = require('../server/lib/promptBuilder');
const { createZip, crc32 } = require('../server/lib/zip');
const higgsfield = require('../server/lib/ai/providers/higgsfield');
const openaiText = require('../server/lib/ai/providers/openaiText');
const zlib = require('zlib');

// ---- link preview -----------------------------------------------------------

test('youtube url variants', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', 'dQw4w9WgXcQ', 90],
    ['https://youtu.be/dQw4w9WgXcQ?t=1m30s', 'dQw4w9WgXcQ', 90],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=12', 'dQw4w9WgXcQ', 12],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', 'dQw4w9WgXcQ', 3723],
  ];
  for (const [url, id, start] of cases) {
    const r = lp.parseYouTube(new URL(url));
    assert.ok(r, url);
    assert.equal(r.id, id, url);
    assert.equal(r.start, start, url);
  }
  assert.equal(lp.parseYouTube(new URL('https://example.com/watch?v=dQw4w9WgXcQ')), null);
  assert.equal(lp.parseYouTube(new URL('https://www.youtube.com/watch?v=short')), null);
});

test('vimeo id', () => {
  assert.equal(lp.parseVimeo(new URL('https://vimeo.com/123456789')).id, '123456789');
  assert.equal(lp.parseVimeo(new URL('https://player.vimeo.com/video/123456789?h=abc')).id, '123456789');
  assert.equal(lp.parseVimeo(new URL('https://vimeo.com/channels/staffpicks')), null);
});

test('private hosts are rejected', async () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '::1', 'foo.local']) {
    assert.ok(lp.isPrivateHost(h), h);
  }
  assert.ok(!lp.isPrivateHost('youtube.com'));
  assert.ok(!lp.isPrivateHost('8.8.8.8'));
  await assert.rejects(lp.preview('http://localhost:3000/x', { offline: true }), /private/);
  await assert.rejects(lp.preview('ftp://example.com/x', { offline: true }), /http/);
  await assert.rejects(lp.preview('not a url', { offline: true }), /invalid/);
});

test('offline youtube preview derives thumbnail + start', async () => {
  const r = await lp.preview('https://youtu.be/dQw4w9WgXcQ?t=90', { offline: true });
  assert.equal(r.provider, 'youtube');
  assert.equal(r.startSeconds, 90);
  assert.equal(r.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(r.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
});

test('open graph parsing with an injected fetch', async () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="A Great Reference" />
    <meta property="og:image" content="/img/thumb.jpg">
    <meta name="description" content="desc &#39;quoted&#39;"></head><body></body></html>`;
  const fetchImpl = async () => ({ ok: true, status: 200, body: null, text: async () => html });
  const r = await lp.preview('https://example.com/article', { fetchImpl });
  assert.equal(r.title, 'A Great Reference');
  assert.equal(r.thumbnail, 'https://example.com/img/thumb.jpg');
  assert.equal(r.description, "desc 'quoted'");
  const meta = lp.parseMeta('<title>Only &lt;title&gt;</title>');
  assert.equal(meta.title, 'Only <title>');
});

// ---- prompt builder ---------------------------------------------------------

const project = { aspectRatio: 16 / 9, fps: 24, defaultBoardTiming: 2000, ext: { style: 'cinematic, soft light' } };

test('prompt builder uses shot type, camera move, duration and style', () => {
  const board = { shot: '1A', action: '민지가 난간에 기대어 도시를 내려다본다', dialogue: '민지: 여기서 보면 다 작아 보여.', duration: 3500, ext: { shotType: 'MS', cameraMove: 'dolly-in' } };
  const r = pb.buildPrompt(board, project);
  assert.match(r.imagePrompt, /^Medium shot of 민지가/);
  assert.match(r.imagePrompt, /민지 is speaking/);
  assert.match(r.imagePrompt, /Style: cinematic, soft light/);
  assert.match(r.videoPrompt, /dolly in/);
  assert.match(r.videoPrompt, /3\.5s/);
  assert.equal(r.params.aspectRatio, '16:9');
  assert.equal(r.payloads.higgsfield.duration, 4); // rounded, clamped 3..15
  assert.equal(r.negativePrompt, pb.DEFAULT_NEGATIVE);
});

test('prompt builder clamps higgsfield duration and respects custom negative', () => {
  const r = pb.buildPrompt({ duration: 500, ext: { negativePrompt: 'cats' } }, project);
  assert.equal(r.payloads.higgsfield.duration, 3);
  assert.equal(r.negativePrompt, 'cats');
  const long = pb.buildPrompt({ duration: 60000, ext: {} }, project);
  assert.equal(long.payloads.higgsfield.duration, 15);
});

test('aspect ratio labels', () => {
  assert.equal(pb.aspectRatioLabel(1.7777), '16:9');
  assert.equal(pb.aspectRatioLabel(0.5625), '9:16');
  assert.equal(pb.aspectRatioLabel(2.39), '2.39:1');
  assert.equal(pb.aspectRatioLabel(1.23), '1.23:1');
});

test('scene headings become establishing shots', () => {
  const r = pb.buildPrompt({ action: 'INT. KITCHEN - NIGHT', ext: {} }, project);
  assert.match(r.imagePrompt, /^Establishing wide shot of KITCHEN, NIGHT \(interior\)/);
  assert.equal(pb.parseSceneHeading('그냥 액션 문장'), null);
});

// ---- zip --------------------------------------------------------------------

test('zip writer produces a valid archive', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = createZip([
    { name: 'a/hello.txt', data: 'hello world' },
    { name: 'a/한글.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // EOCD at the end with 2 entries
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  // first entry: deflated text -> inflate and compare
  const nameLen = zip.readUInt16LE(26);
  const compSize = zip.readUInt32LE(18);
  const method = zip.readUInt16LE(8);
  const start = 30 + nameLen;
  const data = zip.subarray(start, start + compSize);
  assert.equal(method, 8);
  assert.equal(zlib.inflateRawSync(data).toString(), 'hello world');
});

// ---- AI providers -----------------------------------------------------------

test('higgsfield provider: not configured -> 503-style error', async () => {
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
  assert.equal(higgsfield.isConfigured(), false);
  await assert.rejects(higgsfield.submit({ input: {} }), (e) => e.status === 503);
});

test('higgsfield provider: request shape with mocked fetch', async () => {
  process.env.HF_API_KEY_ID = 'id123';
  process.env.HF_API_KEY_SECRET = 'sec456';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'queued', request_id: 'R1', status_url: 'https://api.higgsfield.ai/requests/R1/status' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'completed', request_id: 'R1', video: { url: 'https://cdn.example/out.mp4' } }) };
  };
  const input = higgsfield.buildInput({ prompt: 'x'.repeat(3000), imageUrl: 'https://pub.example/board.png', durationSeconds: 2 });
  assert.equal(input.prompt.length, 2500);
  assert.equal(input.duration, 3);
  const r = await higgsfield.submit({ endpoint: 'kling-video/v3.0/std/image-to-video', input }, { fetchImpl, idempotencyKey: 'IDEMP' });
  assert.equal(r.request_id, 'R1');
  assert.equal(calls[0].url, 'https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video');
  assert.equal(calls[0].init.headers.authorization, 'Key id123:sec456');
  assert.equal(calls[0].init.headers['idempotency-key'], 'IDEMP');
  assert.equal(JSON.parse(calls[0].init.body).image_url, 'https://pub.example/board.png');
  const st = await higgsfield.getStatus(r.status_url, { fetchImpl });
  assert.equal(st.video.url, 'https://cdn.example/out.mp4');
  await assert.rejects(higgsfield.getStatus('https://evil.example/status', { fetchImpl }), /not allowed/);
  assert.throws(() => higgsfield.buildInput({ prompt: 'x', imageUrl: null }), /image_url/);
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
});

test('openai text provider: json extraction + mocked completion', async () => {
  assert.deepEqual(openaiText.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(openaiText.extractJson('Sure! {"imagePrompt":"x"} bye'), { imagePrompt: 'x' });
  assert.throws(() => openaiText.extractJson('no json here'));
  delete process.env.AI_TEXT_API_KEY;
  delete process.env.AI_TEXT_BASE_URL;
  assert.equal(openaiText.isConfigured(), false);
  process.env.AI_TEXT_API_KEY = 'k';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(body.messages[0].role, 'system');
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"imagePrompt":"IMG","videoPrompt":"VID","negativePrompt":"NEG"}' } }], usage: { total_tokens: 10 } }) };
  };
  const r = await openaiText.enhancePrompt({ board: { ext: {} }, project: { ext: {} }, draft: { imagePrompt: 'a', videoPrompt: 'b', negativePrompt: 'c' } }, { fetchImpl });
  assert.deepEqual([r.imagePrompt, r.videoPrompt, r.negativePrompt], ['IMG', 'VID', 'NEG']);
  delete process.env.AI_TEXT_API_KEY;
});
