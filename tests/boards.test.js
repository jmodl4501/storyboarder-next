'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const boards = require('../server/lib/boards');
const util = require('../server/lib/util');

test('uidGen produces 5 upper-case base36 chars', () => {
  for (let i = 0; i < 50; i++) assert.match(util.uidGen(5), /^[0-9A-Z]{5}$/);
});

test('safeProjectId strips path characters and keeps Korean', () => {
  assert.equal(util.safeProjectId('  브랜드 필름/1차:*?  '), '브랜드-필름1차');
  assert.equal(util.safeProjectId('../../etc'), 'etc');
  assert.equal(util.safeProjectId('.hidden'), 'hidden');
});

test('isSafeFilename rejects traversal', () => {
  assert.ok(util.isSafeFilename('board-1-ABCDE-pencil.png'));
  assert.ok(!util.isSafeFilename('../x.png'));
  assert.ok(!util.isSafeFilename('a/b.png'));
});

test('timecode formatting', () => {
  assert.equal(util.msToTimecode(0, 24), '00:00:00:00');
  assert.equal(util.msToTimecode(2000, 24), '00:00:02:00');
  assert.equal(util.msToTimecode(2500, 24), '00:00:02:12');
  assert.equal(util.msToTimecode(3661000, 24), '01:01:01:00');
});

test('numbering without new shots: every board is its own shot (original behaviour)', () => {
  const p = boards.normalizeProject({ defaultBoardTiming: 2000, boards: [{ uid: 'A' }, { uid: 'B' }, { uid: 'C', duration: 500 }, { uid: 'D' }] });
  assert.deepEqual(p.boards.map((b) => b.shot), ['1A', '2A', '3A', '4A']);
  assert.deepEqual(p.boards.map((b) => b.time), [0, 2000, 4000, 4500]);
  assert.equal(boards.totalDuration(p), 6500);
});

test('numbering with new shots: letters within a shot', () => {
  const p = boards.normalizeProject({
    boards: [{ uid: 'A' }, { uid: 'B' }, { uid: 'C', newShot: true }, { uid: 'D' }, { uid: 'E', newShot: true }],
  });
  assert.deepEqual(p.boards.map((b) => b.shot), ['1A', '1B', '2A', '2B', '3A']);
  assert.deepEqual(p.boards.map((b) => b.number), [1, 2, 3, 4, 5]);
});

test('createBoard fills defaults and ext', () => {
  const p = boards.normalizeProject({ boards: [] });
  const b = boards.createBoard(p, { action: 'hi', ext: { shotType: 'CU' } });
  assert.match(b.url, /^board-1-[0-9A-Z]{5}\.png$/);
  assert.equal(b.action, 'hi');
  assert.equal(b.ext.shotType, 'CU');
  assert.deepEqual(b.ext.links, []);
  assert.equal(boards.boardFilenameForLayer(b, 'pencil'), b.url.replace('.png', '-pencil.png'));
  assert.equal(boards.boardFilenameForThumbnail(b), b.url.replace('.png', '-thumbnail.png'));
  assert.equal(boards.boardFilenameForPosterFrame(b), b.url.replace('.png', '-posterframe.jpg'));
  assert.equal(boards.boardImageFilename(b), b.url.replace('.png', '-posterframe.jpg'));
  assert.equal(boards.boardImageFilename({ ...b, _legacyMain: true }), b.url);
  assert.ok(boards.referencedFiles(b).includes(b.url.replace('.png', '-posterframe.jpg')));
  assert.ok(!boards.toFileJson({ boards: [{ uid: 'A', _legacyMain: true }] }).includes('_legacyMain'));
});

test('original storyboarder file round-trips through normalizeProject', () => {
  const original = {
    version: '2.0.1', aspectRatio: 1.7777777777777777, fps: 24, defaultBoardTiming: 2000,
    boards: [{ uid: 'UDRF3', url: 'board-1-UDRF3.png', newShot: false, lastEdited: 1499375725536, layers: { reference: { url: 'board-1-UDRF3-reference.png', opacity: 1 }, notes: { url: 'board-1-UDRF3-notes.png' }, fill: { url: 'board-1-UDRF3-fill.png' } }, number: 1, shot: '1A', time: 0, lineMileage: 821.5 }],
  };
  const p = boards.normalizeProject(original);
  assert.equal(p.boards[0].layers.fill.url, 'board-1-UDRF3-fill.png');
  assert.equal(p.boards[0].dialogue, '');
  assert.equal(p.boards[0].ext.status, 'draft');
  assert.equal(boards.boardFileImageSize(p)[0], 1600);
  assert.equal(boards.boardFileImageSize(p)[1], 900);
  assert.deepEqual(boards.boardFileImageSize({ aspectRatio: 0.5625 }), [900, 1600]);
});

test('estimateDurationMs handles Korean and English', () => {
  const ko = util.estimateDurationMs('오늘 뭐 먹을까?', 'dialogue');
  const en = util.estimateDurationMs('We should go now, before it gets dark.', 'dialogue');
  assert.ok(ko >= 1000 && ko <= 4000, String(ko));
  assert.ok(en >= 2000 && en <= 6000, String(en));
  assert.equal(util.estimateDurationMs('', 'dialogue'), null);
});
