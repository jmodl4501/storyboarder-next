'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const wb = require('../server/lib/whiteboard');
const util = require('../server/lib/util');

test('normalizeWhiteboard drops unknown types, duplicate ids and dangling edges', () => {
  const out = wb.normalizeWhiteboard({
    viewport: { x: 10, y: -20, zoom: 99 },
    nodes: [
      { id: 'a', type: 'note', x: 0, y: 0, text: 'hello', color: 'red' },
      { id: 'a', type: 'image', x: 5, y: 5, src: '/projects/p/assets/x.png' },
      { id: 'bad', type: 'teleport', x: 0, y: 0 },
      { type: 'embed', url: 'https://youtu.be/abc', embedUrl: 'https://www.youtube.com/embed/abc', provider: 'youtube', startSeconds: '12.7' },
      { id: 'frame1', type: 'frame', w: 1, h: 1, color: '#FF7A4A' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'frame1' },
      { id: 'e2', from: 'a', to: 'missing' },
      { id: 'e3', from: 'a', to: 'a' },
    ],
  });
  assert.equal(out.version, 1);
  assert.deepEqual(out.viewport, { x: 10, y: -20, zoom: 8 });
  assert.equal(out.nodes.length, 4);
  const ids = out.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, 4); // duplicate id was re-assigned
  const note = out.nodes[0];
  assert.equal(note.color, '#FFE08A'); // invalid color → default
  assert.equal(note.text, 'hello');
  const embed = out.nodes.find((n) => n.type === 'embed');
  assert.equal(embed.startSeconds, 13);
  assert.deepEqual([embed.w, embed.h], [400, 260]);
  const frame = out.nodes.find((n) => n.type === 'frame');
  assert.deepEqual([frame.w, frame.h], [16, 16]); // clamped minimum
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].id, 'e1');
});

test('normalizeWhiteboard tolerates garbage input', () => {
  assert.deepEqual(wb.normalizeWhiteboard(null).nodes, []);
  assert.deepEqual(wb.normalizeWhiteboard('nope').edges, []);
  assert.deepEqual(wb.normalizeWhiteboard({ nodes: 'x', edges: 5 }).nodes, []);
});

test('referencedAssets lists only this project\'s asset files', () => {
  const data = wb.normalizeWhiteboard({
    nodes: [
      { type: 'image', src: '/projects/my%20proj/assets/abc-photo.png' },
      { type: 'image', src: '/projects/my proj/assets/def-photo.jpg?x=1' },
      { type: 'video', src: '/projects/other/assets/zzz.mp4', poster: '/projects/my%20proj/assets/poster.png' },
      { type: 'image', src: 'https://example.com/a.png' },
      { type: 'link', url: 'https://example.com', thumbnail: '/projects/my%20proj/assets/thumb.png' },
    ],
  });
  assert.deepEqual(wb.referencedAssets(data, 'my proj').sort(), ['abc-photo.png', 'def-photo.jpg', 'poster.png', 'thumb.png']);
});

test('addBoardCards lays cards out in a grid inside a frame below existing content', () => {
  const data = wb.defaultWhiteboard();
  data.nodes.push(wb.normalizeNode({ type: 'note', x: 0, y: 0, w: 200, h: 100 }, new Set()));
  const { frame, cards } = wb.addBoardCards(data, { title: 'Scene 1', uids: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], aspectRatio: 16 / 9, cols: 3, notes: { A: 'note A' } });
  assert.equal(frame.type, 'frame');
  assert.equal(frame.title, 'Scene 1');
  assert.ok(frame.y >= 100 + 120, 'placed below the note');
  assert.equal(cards.length, 7);
  assert.equal(cards[0].note, 'note A');
  assert.equal(cards[3].x, cards[0].x); // wraps after 3 columns
  assert.ok(cards[3].y > cards[0].y);
  for (const c of cards) {
    assert.ok(c.x >= frame.x && c.x + c.w <= frame.x + frame.w, 'card inside frame horizontally');
    assert.ok(c.y >= frame.y && c.y + c.h + 64 <= frame.y + frame.h, 'card (and its note badge) inside frame vertically');
  }
  assert.equal(data.nodes.length, 1 + 1 + 7);
  const ids = new Set(data.nodes.map((n) => n.id));
  assert.equal(ids.size, data.nodes.length);
});

test('toMarkdown renders every node kind and resolves board uids', () => {
  const data = wb.normalizeWhiteboard({
    nodes: [
      { id: 'f', type: 'frame', title: 'Refs', x: 0, y: 0, w: 1000, h: 800 },
      { id: 'i', type: 'image', x: 10, y: 10, src: '/projects/p/assets/a.png', note: 'lighting ref' },
      { id: 'e', type: 'embed', x: 10, y: 300, url: 'https://youtu.be/x', title: 'Clip', startSeconds: 90, provider: 'youtube' },
      { id: 'b', type: 'board', x: 500, y: 10, uid: 'ABCDE' },
      { id: 'n', type: 'note', x: 500, y: 300, text: 'line1\nline2' },
      { id: 'l', type: 'link', x: 2000, y: 2000, url: 'https://example.com', title: 'Example', siteName: 'Ex' },
    ],
    edges: [{ id: 'e1', from: 'i', to: 'b', label: 'use as ref' }],
  });
  const md = wb.toMarkdown(data, { title: 'Test', boardsByUid: { ABCDE: { shot: '2A', action: 'walks in' } } });
  assert.ok(md.startsWith('# 레퍼런스 보드 — Test'));
  assert.ok(md.includes('## Refs'));
  assert.ok(md.includes('lighting ref'));
  assert.ok(md.includes('(1:30~)'));
  assert.ok(md.includes('보드 2A — walks in'));
  assert.ok(md.includes('line1 / line2'));
  assert.ok(md.includes('[Example](https://example.com)'));
  assert.ok(md.includes('use as ref'));
  // Map form is accepted too
  const md2 = wb.toMarkdown(data, { boardsByUid: new Map([['ABCDE', { shot: '3B' }]]) });
  assert.ok(md2.includes('보드 3B'));
});

test('util: safeAssetName / mimeFromName / Windows-safe project ids', () => {
  assert.equal(util.safeAssetName('내 사진 (1).PNG'), '1.png');
  assert.equal(util.safeAssetName('clip.MOV'), 'clip.mov');
  assert.equal(util.safeAssetName('blob', 'image/jpeg'), 'blob.jpeg');
  assert.equal(util.safeAssetName('../../x.exe'), 'x.exe');
  assert.equal(util.safeAssetName(''), 'file.bin');
  assert.equal(util.mimeFromName('a.webp'), 'image/webp');
  assert.equal(util.mimeFromName('a.unknownext'), 'application/octet-stream');
  assert.equal(util.safeProjectId('CON'), 'CON-project');
  assert.equal(util.safeProjectId('이름.'), '이름');
  assert.equal(util.safeProjectId('a/b:c*d'), 'abcd');
  assert.ok(util.isSafeFilename('1a2b3c4d5e-my-photo.png'));
  assert.ok(!util.isSafeFilename('../x'));
});
