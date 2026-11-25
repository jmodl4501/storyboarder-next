'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'shortcuts.js')).href;
test('shortcuts normalize and customize events', async () => {
  const s = await import(moduleUrl);
  s.resetShortcutMap();
  assert.equal(s.eventToShortcut({ key: 's', ctrlKey: true }), 'Mod+S');
  assert.equal(s.eventToShortcut({ key: '?', shiftKey: true }), '?');
  assert.equal(s.shortcutMatches({ key: 's', ctrlKey: true }, 'save'), true);
  const map = s.getShortcutMap(); map.newBoard = 'Mod+N'; s.saveShortcutMap(map);
  assert.equal(s.shortcutMatches({ key: 'n', ctrlKey: true }, 'newBoard'), true);
  s.resetShortcutMap();
});
test('shortcut conflicts respect view scopes', async () => {
  const s = await import(moduleUrl); const map = s.getShortcutMap();
  map.newBoard = 'X'; map.duplicateBoard = 'X';
  assert.ok(s.shortcutConflicts(map).some(([a, b]) => a === 'newBoard' && b === 'duplicateBoard'));
  map.wbModeSelect = 'N';
  assert.ok(!s.shortcutConflicts(map).some(([a, b]) => [a, b].includes('wbModeSelect') && [a, b].includes('newBoard')));
});
