// Storyboarder Next — front-end entry point / orchestrator.
import { api } from './api.js';
import { BoardSurface, DrawingEditor, TOOLS, loadImage } from './surface.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { openPlayer } from './player.js';
import { Whiteboard } from './whiteboard.js';
import { modal, confirmDialog, toast, isModalOpen } from './ui.js';
import { openVideoImport } from './videoImport.js';
import {
  el, debounce, updateSceneTiming, boardDuration, totalDuration, boardImageSize, msToTimecode, msToClock,
  escapeHtml, aspectLabel, copyText, boardHasImage, boardImageName, LAYER_ORDER,
} from './util.js';

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  projectId: null,
  project: null,
  current: 0,
  loadedUid: null, // uid of the board whose layers are currently in the drawing surface
  loadingBoard: null,
  imageSaving: 0,
  projectDirty: false,
  view: 'boards', // 'boards' | 'whiteboard'
  wbLoadedFor: null, // project id whose whiteboard is loaded into the Whiteboard instance
};

let surface;
let editor;
let timeline;
let inspector;
let whiteboard;

/* ========================================================================== */
/*  Boot                                                                      */
/* ========================================================================== */

async function boot() {
  state.meta = await api.meta();
  $('home-version').textContent = `v${state.meta.version}`;
  setupHome();
  setupEditor();
  window.addEventListener('hashchange', route);
  await route();
}

async function route() {
  const m = /^#\/p\/([^/]+)(\/wb)?$/.exec(location.hash);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const view = m[2] ? 'whiteboard' : 'boards';
    if (id !== state.projectId) await openProject(id, view);
    else await setView(view);
  } else {
    await showHome();
  }
}

/* ========================================================================== */
/*  View switching (boards ↔ whiteboard)                                      */
/* ========================================================================== */

function viewHash(view) {
  return `#/p/${encodeURIComponent(state.projectId)}${view === 'whiteboard' ? '/wb' : ''}`;
}

async function setView(view) {
  if (!state.project) return;
  if (location.hash !== viewHash(view)) {
    location.hash = viewHash(view); // hashchange → route → setView again
    return;
  }
  const prev = state.view;
  state.view = view;
  $('screen-editor').classList.toggle('view-whiteboard', view === 'whiteboard');
  for (const b of $('view-switch').querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === view);
  if (view === 'whiteboard') {
    await flushImageSave();
    await ensureWhiteboardLoaded();
    whiteboard.setActive(true);
  } else {
    whiteboard.setActive(false);
    if (prev === 'whiteboard') whiteboard.flush().catch(() => {});
    editor.fit();
    requestAnimationFrame(() => editor.fit());
  }
}

async function ensureWhiteboardLoaded() {
  if (state.wbLoadedFor === state.projectId) {
    whiteboard.setProject(state.project, state.projectId);
    return;
  }
  const id = state.projectId;
  try {
    const { whiteboard: data } = await api.getWhiteboard(id);
    if (state.projectId !== id) return;
    whiteboard.projectId = id;
    whiteboard.setProject(state.project, id);
    whiteboard.load(data);
    state.wbLoadedFor = id;
  } catch (err) {
    toast(`화이트보드를 불러오지 못했습니다: ${err.message}`, 'error');
  }
}

/** Refresh board cards (thumbnails / captions) if the whiteboard is loaded for this project. */
function syncWhiteboardProject() {
  if (whiteboard && state.wbLoadedFor === state.projectId) whiteboard.setProject(state.project, state.projectId);
}

/** Put a whiteboard image onto the current board's reference layer. */
async function useImageAsReference(node) {
  let src = node.src;
  const sameOrigin = /^\//.test(src) || src.startsWith(location.origin);
  const tryLoad = (url, cors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed'));
    img.src = url;
  });
  let img = null;
  try {
    img = await tryLoad(src, !sameOrigin);
  } catch {
    img = null;
  }
  if (!img && !sameOrigin) {
    // the remote server refuses CORS: keep a copy in the project and use that instead
    try {
      const asset = await api.importAssetFromUrl(state.projectId, src);
      whiteboard.begin();
      node.sourceUrl = node.sourceUrl || src;
      node.src = asset.url;
      whiteboard.renderContent(node);
      whiteboard.commit();
      src = asset.url;
      img = await tryLoad(src, false);
      toast('외부 이미지를 프로젝트 assets 폴더에 저장했습니다', 'ok');
    } catch (err) {
      toast(`이미지를 가져올 수 없습니다: ${err.message}`, 'error');
      return;
    }
  }
  if (!img) return toast('이미지를 불러올 수 없습니다', 'error');
  await setView('boards');
  editor.placeImage(img, 'reference', { clearFirst: true });
  toast(`보드 ${currentBoard().shot} 의 레퍼런스 레이어에 넣었습니다. Ref 슬라이더로 투명도를 조절하세요.`, 'ok');
}

function addLinkFromWhiteboardNode(node) {
  const b = currentBoard();
  if (!b) return;
  const link = {
    url: node.url, provider: node.provider || 'web', id: node.videoId || '', title: node.title || node.url, author: node.author || '',
    thumbnail: node.thumbnail || '', embedUrl: node.embedUrl || '', startSeconds: node.startSeconds || 0, siteName: node.siteName || '', note: node.note || '',
  };
  if ((b.ext.links || []).some((l) => l.url === link.url)) return toast('이미 이 보드에 있는 링크입니다');
  b.ext.links = [...(b.ext.links || []), link];
  markProjectDirty();
  inspector.renderLinks();
  toast(`보드 ${b.shot} 의 레퍼런스 링크에 추가했습니다`, 'ok');
}

/* ========================================================================== */
/*  Home / project picker                                                     */
/* ========================================================================== */

function setupHome() {
  $('new-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    try {
      const { id } = await api.createProject(payload);
      toast(`프로젝트 "${id}" 생성`, 'ok');
      location.hash = `#/p/${encodeURIComponent(id)}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function showHome() {
  if (state.projectId) {
    await flushAll();
    if (whiteboard) {
      whiteboard.setActive(false);
      await whiteboard.flush().catch(() => {});
    }
  }
  state.projectId = null;
  state.project = null;
  state.view = 'boards';
  state.wbLoadedFor = null;
  $('screen-editor').classList.remove('view-whiteboard');
  $('screen-editor').hidden = true;
  $('screen-projects').hidden = false;
  const list = $('project-list');
  list.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const projects = await api.listProjects();
    $('project-count').textContent = projects.length ? `(${projects.length})` : '';
    list.innerHTML = '';
    if (!projects.length) list.append(el('p', { class: 'muted', text: '아직 프로젝트가 없습니다. 왼쪽에서 첫 프로젝트를 만들어 보세요.' }));
    for (const p of projects) {
      const card = el('div', { class: 'project-card', role: 'button', tabindex: '0' }, [
        el('div', { class: 'thumb' }, p.thumbnail ? [el('img', { src: p.thumbnail, alt: '' })] : [el('span', { text: aspectLabel(p.aspectRatio) })]),
        el('div', { class: 'info' }, [
          el('strong', { text: p.title }),
          el('span', { text: `${p.boardCount} 보드 · ${msToClock(p.totalDuration)} · ${aspectLabel(p.aspectRatio)} · ${new Date(p.updated).toLocaleDateString()}` }),
        ]),
      ]);
      const open = () => (location.hash = `#/p/${encodeURIComponent(p.id)}`);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => e.key === 'Enter' && open());
      list.append(card);
    }
  } catch (err) {
    list.innerHTML = `<p class="muted">목록을 불러오지 못했습니다: ${escapeHtml(err.message)}</p>`;
  }
}

/* ========================================================================== */
/*  Editor setup                                                              */
/* ========================================================================== */

function setupEditor() {
  surface = new BoardSurface(1600, 900);
  editor = new DrawingEditor({ stage: $('stage'), canvas: $('board-canvas'), overlay: $('overlay-canvas'), surface });

  timeline = new Timeline($('timeline-strip'), $('timeline-summary'), {
    onSelect: (i) => selectBoard(i),
    onReorder: (order) => reorderBoards(order),
    onAdd: () => addBoard(),
    imageUrl: (file, v) => api.imageUrl(state.projectId, file, v),
  });

  inspector = new Inspector(state.meta, {
    onChange: (patch) => updateBoard(patch),
    onAddLink: (url) => addLink(url),
    onRemoveLink: (i) => removeLink(i),
    onLinkNote: (i, note) => {
      currentBoard().ext.links[i].note = note;
      markProjectDirty();
    },
    onGenPrompt: () => generatePrompt(),
    onEnhance: () => enhancePrompt(),
    onCopyPrompt: () => copyPrompt(),
    onCopyPayload: () => copyPayload(),
    onVideo: () => generateVideo(),
    onPollJob: (jobId) => pollJob(jobId),
  });
  inspector.setAiHint(state.meta.ai);

  whiteboard = new Whiteboard($('whiteboard-view'), {
    onOpenBoard: async (uid) => {
      const idx = state.project.boards.findIndex((b) => b.uid === uid);
      if (idx < 0) return toast('이 보드는 삭제되었습니다', 'error');
      await setView('boards');
      selectBoard(idx);
    },
    onUseAsReference: (node) => useImageAsReference(node),
    onAddLinkToBoard: (node) => addLinkFromWhiteboardNode(node),
    currentBoardUid: () => (currentBoard() ? currentBoard().uid : null),
    onStatus: (s) => {
      if (state.view === 'whiteboard' && s !== 'dirty') setSaveState(s === 'saved' && state.projectDirty ? 'dirty' : s);
      else if (state.view === 'whiteboard') setSaveState('dirty');
    },
  });
  $('view-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });

  // ---- toolbar
  $('btn-home').addEventListener('click', () => (location.hash = ''));
  $('tool-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) editor.setTool(b.dataset.tool);
  });
  $('size-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (b) editor.setSizeIndex(Number(b.dataset.size));
  });
  $('btn-undo').addEventListener('click', () => editor.undo());
  $('btn-redo').addEventListener('click', () => editor.redo());
  $('btn-clear').addEventListener('click', () => clearLayer());
  $('guide-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-guide]');
    if (b) editor.setGuide(b.dataset.guide);
  });
  $('btn-onion').addEventListener('click', () => toggleOnion());
  $('ref-opacity').addEventListener('input', (e) => editor.setReferenceOpacity(e.target.value));
  $('ref-opacity').addEventListener('change', () => {
    const b = currentBoard();
    if (b.layers && b.layers.reference) scheduleImageSave({ layerOpacity: { reference: surface.layers.reference.opacity } });
  });

  // import menu
  const menuBtn = $('btn-import-menu');
  const menu = menuBtn.nextElementSibling;
  menuBtn.addEventListener('click', () => (menu.hidden = !menu.hidden));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) menu.hidden = true;
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    menu.hidden = true;
    if (b.dataset.import) pickFiles(b.dataset.import);
  });
  $('file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    const mode = e.target.dataset.mode || 'reference';
    e.target.value = '';
    importImages(files, mode);
  });
  setupDropZone();

  $('btn-script').addEventListener('click', () => openScriptImport());
  $('btn-analysis').addEventListener('click', () => openAnalysisImport());
  $('btn-video').addEventListener('click', () => openVideoImport({
    state,
    currentBoard,
    adoptProject,
    flushAll,
    ensureWhiteboardLoaded,
    get whiteboard() {
      return whiteboard;
    },
    surfaceSize: () => ({ width: surface.width, height: surface.height }),
  }));
  $('btn-play').addEventListener('click', () => play());
  $('btn-export').addEventListener('click', () => openExport());
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-help').addEventListener('click', () => openHelp());

  $('btn-add-board').addEventListener('click', () => addBoard());
  $('btn-dup-board').addEventListener('click', () => duplicateBoard());
  $('btn-del-board').addEventListener('click', () => deleteBoard());
  $('btn-prev').addEventListener('click', () => selectBoard(state.current - 1));
  $('btn-next').addEventListener('click', () => selectBoard(state.current + 1));

  // ---- editor events
  editor.addEventListener('toolchange', renderToolbar);
  editor.addEventListener('historychange', renderToolbar);
  editor.addEventListener('strokeend', (e) => {
    const b = currentBoard();
    if (b) b.lineMileage = (b.lineMileage || 0) + e.detail.mileage;
    scheduleImageSave();
  });
  editor.addEventListener('change', () => scheduleImageSave());
  renderToolbar();

  installShortcuts();
  window.addEventListener('beforeunload', (e) => {
    if (saveProjectDebounced.pending() || imageSaveDebounced.pending() || state.imageSaving > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function renderToolbar() {
  document.querySelectorAll('#tool-buttons .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === editor.tool));
  document.querySelectorAll('#size-buttons button').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === editor.sizeIndex));
  document.querySelectorAll('#guide-buttons [data-guide]').forEach((b) => b.classList.toggle('active', !!editor.guides[b.dataset.guide]));
  $('btn-onion').classList.toggle('active', editor.onion);
  $('btn-undo').disabled = !editor.canUndo();
  $('btn-redo').disabled = !editor.canRedo();

  const pal = $('palette');
  pal.innerHTML = '';
  const colors = editor.palettes[editor.tool] || [];
  colors.forEach((c, i) => {
    const s = el('button', { class: `swatch ${i === editor.colorIndex ? 'active' : ''}`, title: c, style: `background:${c}` });
    s.addEventListener('click', () => editor.setColorIndex(i));
    const pick = (e) => {
      e.preventDefault();
      const input = el('input', { type: 'color', value: c, style: 'position:fixed;left:-100px;top:-100px;opacity:0' });
      document.body.append(input);
      input.addEventListener('input', () => editor.setPaletteColor(i, input.value));
      input.addEventListener('change', () => input.remove());
      input.click();
    };
    s.addEventListener('contextmenu', pick);
    s.addEventListener('dblclick', pick);
    pal.append(s);
  });
  const t = TOOLS[editor.tool];
  $('layer-info').textContent = `${t.label} · ${editor.currentSize()}px · 레이어: ${editor.targetLayer()}`;
}

/* ========================================================================== */
/*  Project open / save                                                       */
/* ========================================================================== */

async function openProject(id, view = 'boards') {
  try {
    const { project, imageSize } = await api.getProject(id);
    state.projectId = id;
    state.project = project;
    state.current = 0;
    state.wbLoadedFor = null;
    state.view = 'boards';
    $('screen-editor').classList.remove('view-whiteboard');
    for (const b of $('view-switch').querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === 'boards');
    $('screen-projects').hidden = true;
    $('screen-editor').hidden = false;
    $('project-title').textContent = project.ext.title || id;
    document.title = `${project.ext.title || id} — Storyboarder Next`;
    const [w, h] = imageSize || boardImageSize(project);
    if (surface.width !== w || surface.height !== h) {
      surface.resize(w, h);
      editor.setSize(w, h);
    } else editor.fit();
    timeline.render(project, 0);
    await selectBoard(0, { force: true });
    setSaveState('saved');
    if (view === 'whiteboard') await setView('whiteboard');
  } catch (err) {
    toast(`프로젝트를 열 수 없습니다: ${err.message}`, 'error');
    location.hash = '';
  }
}

function currentBoard() {
  return state.project ? state.project.boards[state.current] : null;
}

function setSaveState(s) {
  const node = $('save-status');
  node.dataset.state = s;
  node.textContent = { saved: '저장됨', saving: '저장 중…', dirty: '변경됨', error: '저장 실패' }[s] || s;
}

function markProjectDirty() {
  state.projectDirty = true;
  updateSceneTiming(state.project);
  setSaveState('dirty');
  saveProjectDebounced();
}

const saveProjectDebounced = debounce(() => saveProject(), 700);

async function saveProject() {
  if (!state.project || !state.projectDirty) return;
  const id = state.projectId;
  const snapshot = state.project;
  state.projectDirty = false;
  setSaveState('saving');
  try {
    const { project } = await api.saveProject(id, snapshot);
    if (state.projectId !== id) return;
    // keep local text edits that happened while the request was in flight
    const localByUid = new Map(state.project.boards.map((b) => [b.uid, b]));
    for (const b of project.boards) {
      const local = localByUid.get(b.uid);
      if (local) {
        local.url = b.url;
        local.layers = b.layers;
        local.lastEdited = b.lastEdited;
        local.shot = b.shot;
        local.number = b.number;
        local.time = b.time;
      }
    }
    setSaveState(state.projectDirty ? 'dirty' : 'saved');
  } catch (err) {
    state.projectDirty = true;
    setSaveState('error');
    toast(`저장 실패: ${err.message}`, 'error');
  }
}

/** Replace the project with the server copy (after structural changes). */
function adoptProject(project, { selectUid, selectIndex } = {}) {
  const prevUid = currentBoard() && currentBoard().uid;
  state.project = project;
  updateSceneTiming(project);
  let idx = selectIndex;
  if (selectUid) idx = project.boards.findIndex((b) => b.uid === selectUid);
  if (idx == null || idx < 0) idx = project.boards.findIndex((b) => b.uid === prevUid);
  if (idx < 0) idx = Math.min(state.current, project.boards.length - 1);
  timeline.render(project, idx);
  syncWhiteboardProject();
  return selectBoard(idx, { force: true });
}

/* ========================================================================== */
/*  Board selection + image persistence                                       */
/* ========================================================================== */

async function selectBoard(index, { force = false } = {}) {
  const p = state.project;
  if (!p) return;
  index = Math.max(0, Math.min(p.boards.length - 1, index));
  if (!force && index === state.current) return;
  await flushImageSave();
  state.current = index;
  const board = p.boards[index];
  const token = (state.loadingBoard = {});
  const urlFor = (file, v) => api.imageUrl(state.projectId, file, v);
  state.loadedUid = board.uid;
  await surface.loadBoard(board, urlFor);
  if (state.loadingBoard !== token) return; // another board was selected meanwhile
  editor.clearHistory();
  $('ref-opacity').value = surface.layers.reference.opacity;
  editor.render();
  inspector.render(board, p);
  timeline.highlight(index);
  renderBoardInfo();
  refreshOnion();
}

function renderBoardInfo() {
  const b = currentBoard();
  const p = state.project;
  if (!b) return;
  $('board-info').textContent = `보드 ${b.number}/${p.boards.length} · 샷 ${b.shot} · ${msToTimecode(b.time, p.fps)} · ${(boardDuration(p, b) / 1000).toFixed(1)}s · 총 ${msToClock(totalDuration(p))}`;
}

function refreshOnion() {
  if (!editor.onion) return;
  const prev = state.project.boards[state.current - 1];
  if (boardHasImage(prev)) {
    loadImage(api.imageUrl(state.projectId, boardImageName(prev), prev.lastEdited)).then((img) => editor.setOnionImage(img)).catch(() => editor.setOnionImage(null));
  } else editor.setOnionImage(null);
}

function toggleOnion() {
  editor.setOnion();
  refreshOnion();
}

let pendingImageExtras = {};
const imageSaveDebounced = debounce(() => flushImageSave(), 900);

function scheduleImageSave(extras) {
  if (extras) pendingImageExtras = { ...pendingImageExtras, ...extras };
  setSaveState('dirty');
  imageSaveDebounced();
}

/** Serialise dirty layers synchronously, then upload. Safe to call before switching boards. */
async function flushImageSave() {
  imageSaveDebounced.cancel();
  const board = state.project && state.project.boards.find((b) => b.uid === state.loadedUid);
  if (!board || !state.projectId) {
    for (const l of Object.values(surface.layers)) l.dirty = false;
    pendingImageExtras = {};
    return;
  }
  const payload = { layers: {}, clearedLayers: [], ...pendingImageExtras };
  pendingImageExtras = {};
  let dirty = false;
  for (const name of LAYER_ORDER) {
    const layer = surface.layers[name];
    if (!layer.dirty) continue;
    dirty = true;
    if (layer.hasContent) payload.layers[name] = surface.exportLayer(name);
    else payload.clearedLayers.push(name);
    layer.dirty = false;
  }
  if (!dirty && !payload.layerOpacity) return;
  if (dirty) {
    payload.composite = surface.exportComposite({ includeNotes: false });
    payload.thumbnail = surface.exportThumbnail(320);
    payload.lineMileage = board.lineMileage || 0;
  }
  const id = state.projectId;
  const uid = board.uid;
  state.imageSaving++;
  setSaveState('saving');
  try {
    const { board: saved } = await api.saveBoardImage(id, uid, payload);
    if (state.projectId !== id) return;
    const local = state.project.boards.find((b) => b.uid === uid);
    if (local) {
      local.url = saved.url;
      local.layers = saved.layers;
      local.lastEdited = saved.lastEdited;
      timeline.updateCard(local);
      syncWhiteboardProject();
    }
    if (!state.projectDirty) setSaveState('saved');
  } catch (err) {
    setSaveState('error');
    toast(`이미지 저장 실패: ${err.message}`, 'error');
    for (const name of Object.keys(payload.layers)) surface.layers[name].dirty = true;
  } finally {
    state.imageSaving--;
  }
}

async function flushAll() {
  saveProjectDebounced.cancel();
  await flushImageSave();
  await saveProject();
}

/* ========================================================================== */
/*  Board edits                                                               */
/* ========================================================================== */

function updateBoard(patch) {
  const b = currentBoard();
  if (!b) return;
  const { ext, ...rest } = patch;
  Object.assign(b, rest);
  if (rest.duration === null) delete b.duration;
  if (ext) b.ext = { ...b.ext, ...ext };
  markProjectDirty();
  timeline.updateCard(b);
  if ('newShot' in rest || 'duration' in rest) {
    timeline.render(state.project, state.current);
    inspector.render(b, state.project);
  }
  renderBoardInfo();
}

async function addBoard() {
  await flushImageSave();
  try {
    const { project, created } = await api.addBoard(state.projectId, { afterUid: currentBoard().uid });
    await adoptProject(project, { selectUid: created[0] });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function duplicateBoard() {
  await flushAll();
  try {
    const { project, created } = await api.duplicateBoard(state.projectId, currentBoard().uid);
    await adoptProject(project, { selectUid: created });
    toast('보드를 복제했습니다', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteBoard() {
  const b = currentBoard();
  const ok = await confirmDialog(`보드 ${b.shot} 을(를) 삭제할까요? 그림 파일도 함께 삭제됩니다.`, { title: '보드 삭제', okLabel: '삭제', danger: true });
  if (!ok) return;
  imageSaveDebounced.cancel();
  for (const l of Object.values(surface.layers)) l.dirty = false;
  try {
    const { project, index } = await api.deleteBoard(state.projectId, b.uid);
    await adoptProject(project, { selectIndex: index });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reorderBoards(order) {
  await flushAll();
  try {
    const { project } = await api.reorderBoards(state.projectId, order);
    await adoptProject(project);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function clearLayer() {
  if (!editor.clearLayer()) toast('지울 내용이 없습니다 (현재 도구의 레이어 기준)');
}

/* ========================================================================== */
/*  Images (reference import)                                                 */
/* ========================================================================== */

function pickFiles(mode) {
  const input = $('file-input');
  input.dataset.mode = mode;
  input.multiple = mode === 'boards';
  input.click();
}

function setupDropZone() {
  const stage = $('stage');
  const hint = $('drop-hint');
  ['dragenter', 'dragover'].forEach((t) =>
    stage.addEventListener(t, (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      stage.classList.add('drop-active');
      hint.hidden = false;
    }),
  );
  ['dragleave', 'drop'].forEach((t) =>
    stage.addEventListener(t, (e) => {
      if (t === 'drop') e.preventDefault();
      stage.classList.remove('drop-active');
      hint.hidden = true;
    }),
  );
  stage.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) importImages(files, files.length > 1 ? 'boards' : 'reference');
  });
}

function readAsImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    loadImage(url).then((img) => {
      URL.revokeObjectURL(url);
      resolve(img);
    }, reject);
  });
}

async function importImages(files, mode) {
  if (!files.length) return;
  try {
    if (mode === 'reference') {
      const img = await readAsImage(files[0]);
      editor.placeImage(img, 'reference', { clearFirst: true });
      toast('레퍼런스 레이어에 이미지를 넣었습니다. Ref 슬라이더로 투명도를 조절하세요.', 'ok');
    } else {
      for (const file of files) {
        const img = await readAsImage(file);
        await flushImageSave();
        const { project, created } = await api.addBoard(state.projectId, {
          afterUid: currentBoard().uid,
          board: { notes: `import: ${file.name}` },
        });
        await adoptProject(project, { selectUid: created[0] });
        editor.placeImage(img, 'reference', { clearFirst: true });
        await flushImageSave();
      }
      toast(`${files.length}장의 이미지를 보드로 추가했습니다`, 'ok');
    }
  } catch (err) {
    toast(`이미지를 불러올 수 없습니다: ${err.message}`, 'error');
  }
}

/* ========================================================================== */
/*  Links                                                                     */
/* ========================================================================== */

async function addLink(url) {
  const b = currentBoard();
  try {
    const info = await api.linkPreview(url);
    b.ext.links = [...(b.ext.links || []), { ...info, note: '' }];
    markProjectDirty();
    inspector.renderLinks();
    if (info.warning) toast(`링크 추가 (메타데이터 일부 없음: ${info.warning})`);
    return true;
  } catch (err) {
    toast(`링크를 추가할 수 없습니다: ${err.message}`, 'error');
    return false;
  }
}

function removeLink(i) {
  const b = currentBoard();
  b.ext.links.splice(i, 1);
  markProjectDirty();
  inspector.renderLinks();
}

/* ========================================================================== */
/*  AI                                                                        */
/* ========================================================================== */

async function generatePrompt() {
  const b = currentBoard();
  if ((b.ext.prompt || b.ext.videoPrompt) && !(await confirmDialog('기존 프롬프트를 덮어쓸까요?', { title: '프롬프트 생성' }))) return;
  await flushAll();
  try {
    const r = await api.aiPrompt({ projectId: state.projectId, uid: b.uid });
    b.ext = { ...b.ext, prompt: r.imagePrompt, videoPrompt: r.videoPrompt, negativePrompt: r.negativePrompt };
    if (b.ext.status === 'draft') b.ext.status = 'ready';
    markProjectDirty();
    inspector.render(b, state.project);
    timeline.updateCard(b);
    toast('보드 정보로 프롬프트를 만들었습니다 (토큰 사용 없음)', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function enhancePrompt() {
  const b = currentBoard();
  await flushAll();
  const btn = $('btn-enhance-prompt');
  btn.disabled = true;
  btn.textContent = '다듬는 중…';
  try {
    const r = await api.aiEnhance({ projectId: state.projectId, uid: b.uid });
    b.ext = { ...b.ext, prompt: r.imagePrompt, videoPrompt: r.videoPrompt, negativePrompt: r.negativePrompt };
    markProjectDirty();
    inspector.render(b, state.project);
    toast(`프롬프트를 다듬었습니다 (${r.model})`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI로 다듬기';
  }
}

async function copyPrompt() {
  const b = currentBoard();
  const text = `# ${b.shot}\n\n[Image prompt]\n${b.ext.prompt || ''}\n\n[Video prompt]\n${b.ext.videoPrompt || ''}\n\n[Negative]\n${b.ext.negativePrompt || ''}`;
  toast((await copyText(text)) ? '프롬프트를 복사했습니다' : '복사 실패', 'ok');
}

async function copyPayload() {
  const b = currentBoard();
  try {
    const r = await api.aiPrompt({ projectId: state.projectId, uid: b.uid });
    const payload = { ...r.payloads.higgsfield, prompt: b.ext.videoPrompt || r.videoPrompt };
    if (!payload.image_url) payload.image_url = `<public url of images/${boardImageName(b)}>`;
    toast((await copyText(JSON.stringify(payload, null, 2))) ? 'Higgsfield 요청 JSON을 복사했습니다' : '복사 실패', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function generateVideo() {
  const b = currentBoard();
  if (!boardHasImage(b)) return toast('먼저 보드에 그림이나 레퍼런스 이미지를 넣어 주세요', 'error');
  if (!b.ext.videoPrompt && !(await confirmDialog('Video prompt 가 비어 있습니다. 자동 생성된 프롬프트로 진행할까요?'))) return;
  await flushAll();
  try {
    const { board } = await api.aiVideo({ projectId: state.projectId, uid: b.uid });
    Object.assign(b, { ext: board.ext });
    inspector.render(b, state.project);
    timeline.updateCard(b);
    toast('영상 생성 요청을 보냈습니다. "상태 확인"으로 진행 상황을 확인하세요.', 'ok');
  } catch (err) {
    toast(err.message, 'error', 5000);
  }
}

async function pollJob(jobId) {
  const b = currentBoard();
  try {
    const { board } = await api.aiVideoPoll({ projectId: state.projectId, uid: b.uid, jobId });
    Object.assign(b, { ext: board.ext });
    inspector.render(b, state.project);
    timeline.updateCard(b);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ========================================================================== */
/*  Script import                                                             */
/* ========================================================================== */

function openScriptImport() {
  const ta = el('textarea', { placeholder: '대본, 시놉시스, 회의 메모… 정리되지 않은 텍스트도 괜찮습니다.' });
  const gran = el('select', {}, [
    el('option', { value: 'element', text: '문단/대사 단위 (기본)' }),
    el('option', { value: 'sentence', text: '문장 단위 (더 잘게)' }),
    el('option', { value: 'scene', text: '씬 단위 (씬 하나 = 보드 하나)' }),
  ]);
  const preview = el('div', { class: 'script-preview' });
  const sample = el('div', { class: 'script-sample', text: SAMPLE_SCRIPT });
  const useSample = el('button', { class: 'btn small', text: '예시 넣기' });
  useSample.addEventListener('click', () => {
    ta.value = SAMPLE_SCRIPT;
    doPreview();
  });
  const doPreview = debounce(async () => {
    if (!ta.value.trim()) return (preview.innerHTML = '');
    try {
      const r = await api.parseScript({ text: ta.value, granularity: gran.value });
      preview.innerHTML = '';
      preview.append(el('span', { class: 'pill', text: `→ 보드 ${r.boardCount}개` }));
      const ko = { scene: '씬', action: '액션', dialogue: '대사', transition: '전환', section: '섹션', synopsis: '시놉시스' };
      for (const [k, v] of Object.entries(r.summary)) preview.append(el('span', { class: 'pill', text: `${ko[k] || k} ${v}` }));
    } catch (err) {
      preview.textContent = err.message;
    }
  }, 300);
  ta.addEventListener('input', doPreview);
  gran.addEventListener('change', doPreview);

  const body = el('div', { class: 'script-grid' }, [
    el('div', {}, [ta, el('div', { class: 'row2', style: 'margin-top:8px' }, [el('label', { text: '나누는 단위' }, [gran])]), preview]),
    el('div', {}, [el('p', { class: 'hint', text: '인식 규칙: INT./EXT. 또는 S#1 / 씬 1 / #1 → 새 샷, "이름: 대사" → 대사 보드, 그 외 문단 → 액션 보드. 길이는 글자 수로 추정합니다.' }), sample, useSample]),
  ]);
  modal({
    title: '대본 / 텍스트 → 보드',
    body,
    size: 'wide',
    actions: [
      { label: '취소' },
      {
        label: '보드 만들기',
        primary: true,
        onClick: async (close) => {
          if (!ta.value.trim()) return false;
          await flushAll();
          try {
            const { project, created } = await api.importScript(state.projectId, { text: ta.value, granularity: gran.value, afterUid: currentBoard().uid });
            await adoptProject(project, { selectUid: created[0] });
            toast(`${created.length}개의 보드를 만들었습니다`, 'ok');
            close();
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        },
      },
    ],
  });
}

const SAMPLE_ANALYSIS = {
  video_id: 'brand_film_v3',
  title: '브랜드 필름 레퍼런스 분석',
  source: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  metadata: { fps: 24, width: 1920, height: 1080, duration: 32 },
  shots: [
    { shot_id: 'SH001', start_frame: 0, end_frame: 96, description: '도시 스카이라인 위로 해가 뜬다', camera: { shot_type: 'wide', movement: 'drone' }, tags: ['오프닝', '도시'], mood: '희망적', audio_events: ['BGM 시작'] },
    { shot_id: 'SH002', start_frame: 96, end_frame: 240, visual_description: '여성 창업자가 공유 오피스에서 노트북을 연다', objects: ['노트북', '커피잔'], camera: { shot_type: 'medium', movement: 'dolly in' }, transcript_ids: ['ASR_001'] },
    { shot_id: 'SH003', start_frame: 240, end_frame: 312, visual_description: '손가락이 키보드를 두드리는 클로즈업', camera: { shot_type: 'close_up', movement: 'static' }, tags: ['인서트'] },
    { shot_id: 'SH004', start_frame: 312, end_frame: 480, visual_description: '팀원들이 화이트보드 앞에서 토론한다', camera: { shot_type: 'full', movement: 'handheld' }, transcript_ids: ['ASR_002'] },
    { shot_id: 'SH005', start_frame: 480, end_frame: 768, visual_description: '제품 로고가 어두운 배경에서 떠오른다', camera: { shot_type: 'extreme_close_up', movement: 'zoom out' }, tags: ['엔딩', '로고'] },
  ],
  transcript: [
    { segment_id: 'ASR_001', start_time: 4.2, end_time: 9.5, speaker: 'NARRATOR', text: '시작은 언제나 작은 질문이었습니다.' },
    { segment_id: 'ASR_002', start_time: 13.0, end_time: 19.8, speaker: 'NARRATOR', text: '그 질문을 함께 붙드는 사람들이 모였을 때, 답은 형태를 갖추기 시작합니다.' },
  ],
};

function openAnalysisImport() {
  const ta = el('textarea', { placeholder: '여기에 붙여넣기 —\n· 영상 분석 JSON ({ video_id, shots: [...], transcript: [...] })\n· PySceneDetect CSV (scenedetect ... list-scenes)\n· SRT / WebVTT 자막 (Whisper 출력)\n\n또는 파일을 아래 영역에 드롭하세요.', spellcheck: 'false' });
  const fileBtn = el('button', { class: 'btn small', text: '파일 선택…' });
  const fileInput = el('input', { type: 'file', accept: '.json,.csv,.srt,.vtt,.txt,application/json,text/csv,text/plain', hidden: true });
  const drop = el('div', { class: 'import-drop' }, [el('span', { text: 'JSON · CSV · SRT · VTT 파일을 여기에 드롭' }), fileBtn, fileInput]);
  fileBtn.addEventListener('click', () => fileInput.click());
  const readFile = (f) => {
    if (!f) return;
    f.text().then((t) => {
      ta.value = t;
      doPreview();
    });
  };
  fileInput.addEventListener('change', () => readFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
  const useSample = el('button', { class: 'btn small', text: '예시 JSON 넣기' });
  useSample.addEventListener('click', () => { ta.value = JSON.stringify(SAMPLE_ANALYSIS, null, 2); doPreview(); });

  const optWb = el('input', { type: 'checkbox', checked: true });
  const optAfter = el('input', { type: 'checkbox', checked: true });
  const preview = el('div', { class: 'import-preview' }, [el('p', { class: 'hint', text: '붙여넣으면 어떤 보드가 만들어질지 미리 보여줍니다. 샷 타입(close_up, wide…)과 카메라 무브(pan, dolly…)는 보드 필드로 매핑되고, 자막은 시간이 겹치는 샷의 대사가 됩니다. 원본 영상 URL이 있으면 각 보드에 해당 시간으로 가는 링크가 붙습니다.' })]);
  let last = null;
  const doPreview = debounce(async () => {
    const text = ta.value.trim();
    if (!text) {
      last = null;
      preview.innerHTML = '';
      return;
    }
    try {
      const r = await api.previewAnalysis({ text, defaultBoardTiming: state.project.defaultBoardTiming });
      last = r;
      const sm = r.summary;
      preview.innerHTML = '';
      const stat = (n, label) => el('div', { class: 'stat' }, [el('b', { text: String(n) }), el('span', { text: label })]);
      preview.append(el('div', { class: 'import-summary' }, [
        stat(sm.boards, '보드 생성'), stat(sm.shots, `샷 (${sm.format})`), stat(sm.transcriptSegments, '자막 구간'),
        stat(sm.withShotType, '샷 타입 인식'), stat(sm.withCameraMove, '카메라 무브 인식'), stat(msToClock(sm.totalMs), '총 길이'),
      ]));
      const meta = [sm.title && `제목: ${sm.title}`, sm.videoId && `video_id: ${sm.videoId}`, sm.fps && `${sm.fps} fps`, sm.sourceUrl && `원본: ${sm.sourceUrl}`].filter(Boolean);
      if (meta.length) preview.append(el('p', { class: 'hint', text: meta.join(' · ') }));
      for (const w of r.warnings || []) preview.append(el('p', { class: 'import-warn', text: `⚠ ${w}` }));
      if (sm.truncated) preview.append(el('p', { class: 'import-warn', text: '⚠ 500개가 넘는 항목은 잘렸습니다' }));
      const rows = r.boards.slice(0, 60).map((b, i) => el('tr', {}, [
        el('td', { text: String(i + 1) }),
        el('td', { text: b.ext.source && b.ext.source.shotId ? b.ext.source.shotId : '' }),
        el('td', { text: msToClock(b.duration) }),
        el('td', { text: [b.ext.shotType, b.ext.cameraMove].filter(Boolean).join(' / ') }),
        el('td', { text: b.action, title: b.action }),
        el('td', { text: b.dialogue, title: b.dialogue }),
      ]));
      preview.append(el('div', { class: 'import-table' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['#', '샷', '길이', '샷/카메라', '액션', '대사'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows),
      ])]));
      if (r.boards.length > 60) preview.append(el('p', { class: 'hint', text: `… 외 ${r.boards.length - 60}개` }));
    } catch (err) {
      last = null;
      preview.innerHTML = '';
      preview.append(el('p', { class: 'import-warn', text: `인식 실패: ${err.message}` }));
    }
  }, 350);
  ta.addEventListener('input', doPreview);

  const body = el('div', { class: 'import-grid' }, [
    el('div', {}, [
      drop,
      ta,
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [useSample, el('a', { class: 'btn small ghost', href: '/docs/ANALYSIS_IMPORT.md', target: '_blank', text: '형식 문서 ↗' })]),
    ]),
    el('div', {}, [
      preview,
      el('div', { class: 'form-stack', style: 'margin-top:12px' }, [
        el('label', { class: 'check' }, [optAfter, el('span', { text: ' 현재 보드 뒤에 삽입 (해제하면 맨 뒤)' })]),
        el('br'),
        el('label', { class: 'check', style: 'margin-top:6px' }, [optWb, el('span', { text: ' 화이트보드에도 카드로 추가 (프레임 + 원본 영상 임베드)' })]),
      ]),
    ]),
  ]);
  modal({
    title: '영상 분석 결과 → 보드',
    body,
    size: 'wide',
    actions: [
      { label: '취소' },
      {
        label: '보드 만들기',
        primary: true,
        onClick: async (close) => {
          if (!ta.value.trim()) return false;
          if (!last) {
            toast('먼저 인식 가능한 분석 데이터를 넣어 주세요', 'error');
            return false;
          }
          await flushAll();
          try {
            const r = await api.importAnalysis(state.projectId, {
              text: ta.value,
              afterUid: optAfter.checked ? currentBoard().uid : undefined,
              addToWhiteboard: optWb.checked,
            });
            if (optWb.checked) state.wbLoadedFor = null; // reload the whiteboard next time it is shown
            await adoptProject(r.project, { selectUid: r.created[0] });
            close();
            toast(`${r.created.length}개의 보드를 만들었습니다${r.whiteboard ? ` · 화이트보드 카드 ${r.whiteboard.cards}개` : ''}`, 'ok');
            if (state.view === 'whiteboard') {
              await ensureWhiteboardLoaded();
              whiteboard.fitAll();
            }
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        },
      },
    ],
  });
}

const SAMPLE_SCRIPT = `S#1. 옥상 - 해질녘

도시의 스카이라인 위로 노을이 번진다. 민지가 난간에 기대어 서 있다.

민지: 여기서 보면 다 작아 보여.
준호: (다가오며) 그래서 올라온 거야?

민지가 대답 대신 손에 든 카메라를 들어 올린다.

CUT TO:

S#2. 골목 - 밤

빗물이 고인 골목. 네온 간판이 물웅덩이에 비친다. 자전거 한 대가 지나간다.`;

/* ========================================================================== */
/*  Export / settings / help                                                  */
/* ========================================================================== */

async function openExport() {
  await flushAll();
  const id = state.projectId;
  const items = [
    ['print', '인쇄 / PDF', '브라우저 인쇄 → PDF 저장. 보드 + 액션/대사/노트 시트', `/print.html?project=${encodeURIComponent(id)}`],
    ['zip', 'ZIP 번들', '프로젝트 파일 + 이미지 + CSV + 프롬프트(md/json). GitHub/공유용', api.exportUrl(id, 'zip')],
    ['csv', '샷 리스트 (CSV)', '엑셀/구글시트에서 바로 열리는 샷 리스트 (한글 BOM 포함)', api.exportUrl(id, 'csv')],
    ['md', '프롬프트 팩 (Markdown)', '보드별 이미지 + 프롬프트 + 레퍼런스 링크. GitHub 에서 그대로 읽힘', api.exportUrl(id, 'markdown')],
    ['json', '프롬프트 팩 (JSON)', '보드별 Higgsfield/범용 요청 페이로드 — 자동화 스크립트용', api.exportUrl(id, 'prompts')],
    ['sb', '.storyboarder 파일', '원작 Storyboarder 호환 JSON (images 폴더와 함께 사용)', api.exportUrl(id, 'storyboarder')],
  ];
  const list = el('div', { class: 'export-list' });
  for (const [key, title, desc, href] of items) {
    list.append(el('a', { href, target: key === 'print' ? '_blank' : undefined, download: key === 'print' ? undefined : '' }, [
      el('span', {}, [el('strong', { text: title }), el('br'), el('small', { text: desc })]),
      el('span', { class: 'muted', text: '↗' }),
    ]));
  }
  modal({ title: '내보내기', body: list });
}

async function openSettings() {
  const p = state.project;
  const title = el('input', { value: p.ext.title || '' });
  const fps = el('select', {}, [24, 25, 30, 60].map((v) => el('option', { value: String(v), text: String(v), selected: p.fps === v })));
  const timing = el('input', { type: 'number', value: p.defaultBoardTiming, min: 100, step: 100 });
  const style = el('textarea', { rows: 2 }, [p.ext.style || '']);
  const touch = el('input', { type: 'checkbox' });
  touch.checked = editor.touchDraw;
  let ai = state.meta.ai;
  try {
    ai = await api.aiStatus();
  } catch {
    /* keep cached */
  }
  const pill = (on, label) => el('span', { class: `pill ${on ? 'on' : 'off'}`, text: label });
  const status = el('div', { class: 'status-grid' }, [
    el('span', { text: '텍스트 AI' }), el('span', {}, [pill(ai.text.configured, ai.text.configured ? `${ai.text.model}` : '미설정'), ' ', el('small', { class: 'muted', text: ai.text.baseUrl || 'AI_TEXT_BASE_URL / AI_TEXT_API_KEY' })]),
    el('span', { text: '영상 생성' }), el('span', {}, [pill(ai.video.configured, ai.video.configured ? ai.video.endpoint : '미설정'), ' ', el('small', { class: 'muted', text: 'HF_API_KEY_ID / HF_API_KEY_SECRET / HF_ENDPOINT' })]),
    el('span', { text: '공개 URL' }), el('span', {}, [pill(!!ai.publicBaseUrl, ai.publicBaseUrl || 'PUBLIC_BASE_URL 미설정'), ' ', el('small', { class: 'muted', text: '영상 API 가 보드 이미지를 가져갈 주소 (터널)' })]),
  ]);
  const body = el('div', {}, [
    el('label', { text: '프로젝트 제목' }, [title]),
    el('div', { class: 'row2' }, [el('label', { text: 'FPS' }, [fps]), el('label', { text: '기본 보드 길이 (ms)' }, [timing])]),
    el('label', { text: '비주얼 스타일 (모든 프롬프트에 포함)' }, [style]),
    el('label', { class: 'check' }, [touch, ' 터치(손가락)로도 그리기 — 끄면 펜/마우스만 그려집니다']),
    el('p', { class: 'muted', text: `화면비 ${aspectLabel(p.aspectRatio)} · 이미지 ${surface.width}×${surface.height} · 폴더 projects/${state.projectId}` }),
    el('section', { class: 'insp-section' }, [el('h3', { text: 'AI 연결 상태 (.env 로 설정, 서버 재시작 필요)' }), status, el('p', { class: 'hint', text: '자세한 설정은 docs/AI_INTEGRATION.md 를 보세요.' })]),
    el('section', { class: 'insp-section' }, [
      el('h3', { text: 'Danger zone' }),
      el('button', { class: 'btn danger small', text: '프로젝트 삭제', onclick: async () => {
        const ok = await confirmDialog(`"${state.projectId}" 프로젝트와 모든 이미지를 삭제할까요? 되돌릴 수 없습니다.`, { title: '프로젝트 삭제', okLabel: '삭제', danger: true });
        if (!ok) return;
        await api.deleteProject(state.projectId);
        state.projectId = null;
        location.hash = '';
      } }),
    ]),
  ]);
  modal({
    title: '프로젝트 설정',
    body,
    actions: [
      { label: '취소' },
      {
        label: '저장',
        primary: true,
        onClick: () => {
          p.ext.title = title.value.trim();
          p.fps = Number(fps.value);
          p.defaultBoardTiming = Math.max(100, Number(timing.value) || 2000);
          p.ext.style = style.value.trim();
          editor.touchDraw = touch.checked;
          $('project-title').textContent = p.ext.title || state.projectId;
          markProjectDirty();
          timeline.render(p, state.current);
          inspector.render(currentBoard(), p);
          renderBoardInfo();
        },
      },
    ],
  });
}

function openHelp() {
  const rows = [
    ['1 – 6', '연한 연필 · 연필 · 펜 · 브러시 · 노트 펜 · 지우개'],
    ['[ / ]', '브러시 작게 / 크게'],
    ['Shift + 드래그', '직선'],
    ['Alt + 클릭', '스포이드 (캔버스 색 추출)'],
    ['Ctrl/⌘ + Z · Shift+Z / Y', '실행 취소 · 다시 실행'],
    ['Delete / Backspace', '현재 도구 레이어 지우기'],
    ['← / →', '이전 / 다음 보드'],
    ['N · D · Shift+Delete', '새 보드 · 복제 · 보드 삭제'],
    ['G · C · T · O', '그리드 · 센터 · 3분할 · 어니언 스킨'],
    ['Space', '재생'],
    ['Ctrl/⌘ + S', '지금 저장 (자동 저장도 됩니다)'],
    ['Ctrl/⌘ + 1 · 2', '보드 에디터 · 화이트보드 전환'],
    ['Esc', '창 닫기'],
  ];
  const wbRows = [
    ['Ctrl+V · 드래그 앤 드롭', '이미지/영상 파일, 이미지 주소, YouTube·Vimeo·웹 URL, 텍스트 → 노드'],
    ['휠 · Ctrl+휠 · Space+드래그', '이동 · 커서 기준 확대/축소 · 손 도구로 이동 (트랙패드 핀치 가능)'],
    ['V · H · N · T · F · C', '선택 · 손 · 노트 · 텍스트 · 프레임 · 연결선'],
    ['더블클릭', '빈 곳: 메모 / 노트·텍스트: 편집 / 임베드·영상: 재생 / 보드 카드: 보드 열기 / 이미지: 크게 보기'],
    ['Shift + 드래그 (모서리)', '비율 무시하고 크기 조절 (이미지·영상은 기본 비율 고정)'],
    ['Ctrl+A · Ctrl+D · Delete', '전체 선택 · 복제 · 삭제'],
    ['← ↑ → ↓ (+Shift)', '선택 항목 미세 이동'],
    ['+ / − · Ctrl+0 · Shift+1 · Shift+2', '확대/축소 · 100% · 전체 보기 · 선택 항목 보기'],
    ['Ctrl+F', '화이트보드 검색 (제목 · 메모 · 태그 · URL)'],
  ];
  const table = el('table', {}, rows.map(([k, v]) => el('tr', {}, [el('td', {}, [el('kbd', { text: k })]), el('td', { text: v })])));
  const wbTable = el('table', {}, wbRows.map(([k, v]) => el('tr', {}, [el('td', {}, [el('kbd', { text: k })]), el('td', { text: v })])));
  modal({
    title: '단축키',
    size: 'wide',
    body: el('div', {}, [
      el('h3', { text: '보드 에디터', style: 'margin:0 0 8px;font-size:13px' }), table,
      el('h3', { text: '화이트보드', style: 'margin:18px 0 8px;font-size:13px' }), wbTable,
      el('p', { class: 'hint', text: '같은 Wi-Fi 의 iPad/태블릿 브라우저에서 서버 주소로 접속하면 펜 필압이 적용된 채로 그릴 수 있습니다.' }),
    ]),
  });
}

function play() {
  if (!state.project) return;
  openPlayer(state.project, { imageUrl: (f, v) => api.imageUrl(state.projectId, f, v), startIndex: state.current });
}

/* ========================================================================== */
/*  Shortcuts                                                                 */
/* ========================================================================== */

function installShortcuts() {
  const toolKeys = { 1: 'light-pencil', 2: 'pencil', 3: 'pen', 4: 'brush', 5: 'note-pen', 6: 'eraser' };
  window.addEventListener('keydown', (e) => {
    if (!state.project || $('screen-editor').hidden) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      Promise.all([flushAll(), whiteboard.flush()]).then(() => toast('저장했습니다', 'ok'));
      return;
    }
    if (mod && !e.shiftKey && (e.key === '1' || e.key === '2') && !isModalOpen()) {
      e.preventDefault();
      setView(e.key === '1' ? 'boards' : 'whiteboard');
      return;
    }
    if (state.view === 'whiteboard') return; // the whiteboard has its own key handling
    if (typing || isModalOpen()) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? editor.redo() : editor.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      editor.redo();
      return;
    }
    if (mod) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); selectBoard(state.current - 1); break;
      case 'ArrowRight': e.preventDefault(); selectBoard(state.current + 1); break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (e.shiftKey) deleteBoard();
        else clearLayer();
        break;
      case ' ': e.preventDefault(); play(); break;
      case '[': editor.setSizeIndex(editor.sizeIndex - 1); break;
      case ']': editor.setSizeIndex(editor.sizeIndex + 1); break;
      case '?': openHelp(); break;
      default: {
        const k = e.key.toLowerCase();
        if (toolKeys[k]) editor.setTool(toolKeys[k]);
        else if (k === 'n') addBoard();
        else if (k === 'd') duplicateBoard();
        else if (k === 'g') editor.setGuide('grid');
        else if (k === 'c') editor.setGuide('center');
        else if (k === 't') editor.setGuide('thirds');
        else if (k === 'o') toggleOnion();
      }
    }
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#ff4d5e;padding:20px">초기화 실패: ${escapeHtml(err.message)}</pre>`);
});

// exposed for debugging / e2e tests
window.__sbn = { state, get surface() { return surface; }, get editor() { return editor; }, get whiteboard() { return whiteboard; }, flushAll, selectBoard, setView };
