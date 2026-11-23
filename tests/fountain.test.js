'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fountain = require('../server/lib/fountain');

const ENGLISH = `Title: Rooftop
Author: Someone

INT. KITCHEN - NIGHT

A kettle whistles. MARY (40s) stares at it without moving.

MARY
(quietly)
Not tonight.

JOHN (V.O.)
You always say that.

CUT TO:

EXT. STREET - CONTINUOUS

Rain. A single bicycle passes.

# Act Two

= Mary finally leaves.

.FLASHBACK - THE BEACH

Sun. Laughter.`;

const KOREAN = `S#1. 옥상 - 해질녘

도시의 스카이라인 위로 노을이 번진다. 민지가 난간에 기대어 서 있다.

민지: 여기서 보면 다 작아 보여.
준호: (다가오며) 그래서 올라온 거야?

민지
대답 대신 카메라를 들어 올린다.

컷 투

씬 2 골목 - 밤

빗물이 고인 골목. 네온 간판이 물웅덩이에 비친다.`;

test('parses fountain elements', () => {
  const { meta, elements } = fountain.parseScript(ENGLISH);
  assert.equal(meta.title, 'Rooftop');
  const types = elements.map((e) => e.type);
  assert.deepEqual(types, ['scene', 'action', 'dialogue', 'dialogue', 'transition', 'scene', 'action', 'section', 'synopsis', 'scene', 'action']);
  const mary = elements[2];
  assert.equal(mary.character, 'MARY');
  assert.equal(mary.parenthetical, 'quietly');
  assert.equal(mary.text, 'Not tonight.');
  assert.equal(elements[3].character, 'JOHN (V.O.)');
  assert.equal(elements[9].text, 'FLASHBACK - THE BEACH');
});

test('parses Korean conventions', () => {
  const { elements } = fountain.parseScript(KOREAN);
  const types = elements.map((e) => e.type);
  assert.deepEqual(types, ['scene', 'action', 'dialogue', 'dialogue', 'dialogue', 'transition', 'scene', 'action']);
  assert.equal(elements[2].character, '민지');
  assert.equal(elements[2].text, '여기서 보면 다 작아 보여.');
  assert.equal(elements[3].character, '준호');
  assert.equal(elements[4].character, '민지');
  assert.equal(elements[4].text, '대답 대신 카메라를 들어 올린다.');
  assert.equal(elements[6].text, '씬 2 골목 - 밤');
});

test('elements -> boards (element granularity)', () => {
  const { boards } = fountain.scriptToBoards(KOREAN, { granularity: 'element' });
  assert.equal(boards.length, 7); // 2 scenes + 2 actions + 3 dialogues
  assert.equal(boards[0].newShot, true);
  assert.equal(boards[0].action, 'S#1. 옥상 - 해질녘');
  assert.equal(boards[2].dialogue, '민지: 여기서 보면 다 작아 보여.');
  assert.equal(boards[2].ext.shotType, 'MCU');
  assert.ok(boards[2].duration >= 1000);
  assert.match(boards[4].notes, /컷 투/); // transition attached to the previous board
  assert.equal(boards[5].newShot, true);
});

test('elements -> boards (scene granularity aggregates)', () => {
  const { boards } = fountain.scriptToBoards(KOREAN, { granularity: 'scene' });
  assert.equal(boards.length, 2);
  assert.match(boards[0].dialogue, /민지: 여기서 보면/);
  assert.match(boards[0].dialogue, /준호:/);
  assert.match(boards[0].action, /노을이 번진다/);
  assert.ok(boards[0].duration > boards[1].duration);
});

test('sentence granularity splits action paragraphs', () => {
  const { boards } = fountain.scriptToBoards('비가 온다. 민지가 뛴다! 준호는 웃는다?', { granularity: 'sentence' });
  assert.deepEqual(boards.map((b) => b.action), ['비가 온다.', '민지가 뛴다!', '준호는 웃는다?']);
});

test('messy text still produces boards', () => {
  const { boards } = fountain.scriptToBoards('그냥 메모\n\n\n\n두번째 메모   \n세번째 줄', {});
  assert.equal(boards.length, 2);
  assert.equal(boards[1].action, '두번째 메모 세번째 줄');
});

test('empty input produces no boards', () => {
  assert.equal(fountain.scriptToBoards('', {}).boards.length, 0);
});
