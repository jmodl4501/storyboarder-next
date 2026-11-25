const STORAGE_KEY = 'storyboarder-next.shortcuts.v1';
export const SHORTCUT_ACTIONS = Object.freeze([
  { id: 'save', scope: 'global', label: '지금 저장', default: 'Mod+S' },
  { id: 'viewBoards', scope: 'global', label: '보드 에디터 보기', default: 'Mod+1' },
  { id: 'viewWhiteboard', scope: 'global', label: '화이트보드 보기', default: 'Mod+2' },
  { id: 'help', scope: 'global', label: '단축키 도움말', default: '?' },
  { id: 'undo', scope: 'boards', label: '실행 취소', default: 'Mod+Z' },
  { id: 'redo', scope: 'boards', label: '다시 실행', default: 'Mod+Shift+Z' },
  { id: 'previousBoard', scope: 'boards', label: '이전 보드', default: 'ArrowLeft' },
  { id: 'nextBoard', scope: 'boards', label: '다음 보드', default: 'ArrowRight' },
  { id: 'clearLayer', scope: 'boards', label: '현재 레이어 지우기', default: 'Delete' },
  { id: 'deleteBoard', scope: 'boards', label: '보드 삭제', default: 'Shift+Delete' },
  { id: 'play', scope: 'boards', label: '애니매틱 재생', default: 'Space' },
  { id: 'brushSmaller', scope: 'boards', label: '브러시 작게', default: '[' },
  { id: 'brushLarger', scope: 'boards', label: '브러시 크게', default: ']' },
  { id: 'toolLightPencil', scope: 'boards', label: '연한 연필', default: '1' },
  { id: 'toolPencil', scope: 'boards', label: '연필', default: '2' },
  { id: 'toolPen', scope: 'boards', label: '펜', default: '3' },
  { id: 'toolBrush', scope: 'boards', label: '브러시', default: '4' },
  { id: 'toolNotePen', scope: 'boards', label: '노트 펜', default: '5' },
  { id: 'toolEraser', scope: 'boards', label: '지우개', default: '6' },
  { id: 'newBoard', scope: 'boards', label: '새 보드', default: 'N' },
  { id: 'duplicateBoard', scope: 'boards', label: '보드 복제', default: 'D' },
  { id: 'guideGrid', scope: 'boards', label: '그리드 가이드', default: 'G' },
  { id: 'guideCenter', scope: 'boards', label: '센터 가이드', default: 'C' },
  { id: 'guideThirds', scope: 'boards', label: '3분할 가이드', default: 'T' },
  { id: 'onionSkin', scope: 'boards', label: '어니언 스킨', default: 'O' },
  { id: 'wbUndo', scope: 'whiteboard', label: '실행 취소', default: 'Mod+Z' },
  { id: 'wbRedo', scope: 'whiteboard', label: '다시 실행', default: 'Mod+Shift+Z' },
  { id: 'wbSelectAll', scope: 'whiteboard', label: '전체 선택', default: 'Mod+A' },
  { id: 'wbDuplicate', scope: 'whiteboard', label: '선택 복제', default: 'Mod+D' },
  { id: 'wbSearch', scope: 'whiteboard', label: '검색', default: 'Mod+F' },
  { id: 'wbZoom100', scope: 'whiteboard', label: '100% 보기', default: 'Mod+0' },
  { id: 'wbZoomIn', scope: 'whiteboard', label: '확대', default: '+' },
  { id: 'wbZoomOut', scope: 'whiteboard', label: '축소', default: '-' },
  { id: 'wbFitAll', scope: 'whiteboard', label: '전체 보기', default: '!' },
  { id: 'wbFitSelection', scope: 'whiteboard', label: '선택 항목 보기', default: '@' },
  { id: 'wbDelete', scope: 'whiteboard', label: '선택 삭제', default: 'Delete' },
  { id: 'wbNudgeLeft', scope: 'whiteboard', label: '왼쪽 이동', default: 'ArrowLeft' },
  { id: 'wbNudgeRight', scope: 'whiteboard', label: '오른쪽 이동', default: 'ArrowRight' },
  { id: 'wbNudgeUp', scope: 'whiteboard', label: '위쪽 이동', default: 'ArrowUp' },
  { id: 'wbNudgeDown', scope: 'whiteboard', label: '아래쪽 이동', default: 'ArrowDown' },
  { id: 'wbModeSelect', scope: 'whiteboard', label: '선택 도구', default: 'V' },
  { id: 'wbModeHand', scope: 'whiteboard', label: '손 도구', default: 'H' },
  { id: 'wbModeNote', scope: 'whiteboard', label: '스티키 노트', default: 'N' },
  { id: 'wbModeText', scope: 'whiteboard', label: '텍스트', default: 'T' },
  { id: 'wbModeFrame', scope: 'whiteboard', label: '프레임', default: 'F' },
  { id: 'wbModeConnect', scope: 'whiteboard', label: '연결선', default: 'C' },
]);
const ids = new Set(SHORTCUT_ACTIONS.map((a) => a.id));
const defaults = () => Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.default]));
let cached = null;
const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
export function getShortcutMap() {
  if (cached) return { ...cached };
  let saved = {};
  try { saved = JSON.parse((storage() && storage().getItem(STORAGE_KEY)) || '{}'); } catch { saved = {}; }
  cached = { ...defaults(), ...Object.fromEntries(Object.entries(saved).filter(([id, v]) => ids.has(id) && typeof v === 'string')) };
  return { ...cached };
}
export function saveShortcutMap(map) {
  cached = { ...defaults(), ...map };
  if (storage()) storage().setItem(STORAGE_KEY, JSON.stringify(cached));
  return getShortcutMap();
}
export function resetShortcutMap() { cached = defaults(); if (storage()) storage().removeItem(STORAGE_KEY); return getShortcutMap(); }
export function shortcutFor(id) { return getShortcutMap()[id] || ''; }
function baseKey(e) {
  if (e.key === ' ') return 'Space';
  if (e.key && e.key.length === 1) return /[a-z]/i.test(e.key) ? e.key.toUpperCase() : e.key;
  return e.key || e.code || '';
}
export function eventToShortcut(e, { ignoreShift = false } = {}) {
  const key = baseKey(e);
  if (!key || ['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Mod');
  if (e.altKey) mods.push('Alt');
  const shiftedSymbol = key.length === 1 && '~!@#$%^&*()_+{}|:"<>?'.includes(key);
  if (e.shiftKey && !ignoreShift && !shiftedSymbol) mods.push('Shift');
  return [...mods, key].join('+');
}
export function shortcutMatches(e, id, options) { const b = shortcutFor(id); return !!b && eventToShortcut(e, options) === b; }
export function formatShortcut(binding) {
  const apple = /Mac|iPhone|iPad/.test(typeof navigator !== 'undefined' ? navigator.platform : '');
  return String(binding || '미지정').replace(/^Mod\+/, apple ? '⌘+' : 'Ctrl+');
}
export function shortcutConflicts(map) {
  const out = [];
  for (let i = 0; i < SHORTCUT_ACTIONS.length; i++) for (let j = i + 1; j < SHORTCUT_ACTIONS.length; j++) {
    const a = SHORTCUT_ACTIONS[i]; const b = SHORTCUT_ACTIONS[j]; const v = map[a.id];
    if (v && v === map[b.id] && (a.scope === b.scope || a.scope === 'global' || b.scope === 'global')) out.push([a.id, b.id, v]);
  }
  return out;
}
