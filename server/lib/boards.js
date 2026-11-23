'use strict';

/**
 * Board / project model helpers.
 *
 * The on-disk format is a superset of the original Storyboarder ".storyboarder"
 * JSON file.  All original fields keep their original meaning; everything that
 * is new in Storyboarder Next lives under `board.ext` / `project.ext` so the
 * file can still be opened by the original application.
 */

const { uidGen } = require('./util');

const LAYER_ORDER = ['reference', 'fill', 'tone', 'pencil', 'ink', 'notes'];
const DRAWING_LAYERS = ['fill', 'tone', 'pencil', 'ink'];

const SHOT_TYPES = [
  'EWS', 'WS', 'FS', 'MS', 'MCU', 'CU', 'ECU', 'OTS', 'POV', 'TWO', 'INSERT', 'LOW', 'HIGH', 'BIRD', 'DUTCH',
];

const CAMERA_MOVES = [
  'static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'dolly-in', 'dolly-out', 'truck-left',
  'truck-right', 'crane-up', 'crane-down', 'handheld', 'zoom-in', 'zoom-out', 'orbit', 'rack-focus',
  'follow', 'whip-pan',
];

const BOARD_STATUS = ['draft', 'ready', 'generating', 'generated', 'approved'];

function defaultBoardExt() {
  return {
    shotType: '',
    cameraMove: '',
    links: [],
    prompt: '',
    videoPrompt: '',
    negativePrompt: '',
    status: 'draft',
    tags: [],
    aiJobs: [],
  };
}

function defaultProjectExt() {
  return {
    title: '',
    style: 'cinematic, natural light, 35mm film look, muted colors',
    generator: 'storyboarder-next',
    created: Date.now(),
    updated: Date.now(),
    aiTarget: 'higgsfield',
  };
}

/** Original Storyboarder image size rule: 900px on the short side. */
function boardFileImageSize(project) {
  const ar = Number(project.aspectRatio) || 16 / 9;
  return ar >= 1 ? [Math.round(900 * ar), 900] : [900, Math.round(900 / ar)];
}

function uniqueUid(project) {
  const used = new Set((project.boards || []).map((b) => b.uid));
  let uid = uidGen(5);
  while (used.has(uid)) uid = uidGen(5);
  return uid;
}

function createBoard(project, overrides = {}) {
  const uid = overrides.uid || uniqueUid(project);
  const n = (project.boards || []).length + 1;
  const board = {
    uid,
    url: `board-${n}-${uid}.png`,
    newShot: false,
    lastEdited: Date.now(),
    layers: {},
    number: n,
    shot: `${n}A`,
    time: 0,
    lineMileage: 0,
    dialogue: '',
    action: '',
    notes: '',
    ext: defaultBoardExt(),
  };
  const { ext, ...rest } = overrides;
  Object.assign(board, rest, { uid, url: board.url });
  if (ext) board.ext = { ...board.ext, ...ext };
  return board;
}

function boardDuration(project, board) {
  return board.duration != null && board.duration !== ''
    ? Number(board.duration)
    : Number(project.defaultBoardTiming) || 2000;
}

/**
 * Port of Storyboarder's `updateSceneTiming`:
 * - when at least one board is flagged `newShot`, boards are grouped into shots
 *   (1A, 1B, 2A ...), otherwise every board is its own shot (1A, 2A, 3A ...).
 * - `time` is the cumulative start time in ms.
 */
function updateSceneTiming(project) {
  const boards = project.boards || [];
  const hasShots = boards.some((b) => b.newShot);
  let currentShot = 0;
  let subShot = 0;
  let boardNumber = 1;
  let currentTime = 0;

  for (const board of boards) {
    if (hasShots) {
      if (board.newShot || currentShot === 0) {
        currentShot++;
        subShot = 0;
      } else {
        subShot++;
      }
      let substr = String.fromCharCode(97 + (subShot % 26)).toUpperCase();
      if (Math.ceil(subShot / 25) - 1 > 0) substr += Math.ceil(subShot / 25);
      board.shot = currentShot + substr;
      board.number = boardNumber;
    } else {
      board.number = boardNumber;
      board.shot = boardNumber + 'A';
    }
    boardNumber++;
    board.time = currentTime;
    currentTime += boardDuration(project, board);
  }
  return project;
}

function totalDuration(project) {
  return (project.boards || []).reduce((sum, b) => sum + boardDuration(project, b), 0);
}

function normalizeBoard(board, project) {
  const b = { ...board };
  if (!b.uid) b.uid = uniqueUid(project);
  if (!b.url) b.url = `board-${(project.boards || []).length + 1}-${b.uid}.png`;
  if (typeof b.newShot !== 'boolean') b.newShot = !!b.newShot;
  if (!b.layers || typeof b.layers !== 'object') b.layers = {};
  if (typeof b.dialogue !== 'string') b.dialogue = b.dialogue ? String(b.dialogue) : '';
  if (typeof b.action !== 'string') b.action = b.action ? String(b.action) : '';
  if (typeof b.notes !== 'string') b.notes = b.notes ? String(b.notes) : '';
  if (b.duration === '' || b.duration === null) delete b.duration;
  if (b.duration != null) b.duration = Number(b.duration);
  if (!b.lastEdited) b.lastEdited = Date.now();
  if (typeof b.lineMileage !== 'number') b.lineMileage = Number(b.lineMileage) || 0;
  b.ext = { ...defaultBoardExt(), ...(b.ext || {}) };
  if (!Array.isArray(b.ext.links)) b.ext.links = [];
  if (!Array.isArray(b.ext.tags)) b.ext.tags = [];
  if (!Array.isArray(b.ext.aiJobs)) b.ext.aiJobs = [];
  return b;
}

function normalizeProject(data) {
  const p = { ...(data || {}) };
  if (!p.version) p.version = '0.0.0';
  p.aspectRatio = Number(p.aspectRatio) || 16 / 9;
  p.fps = Number(p.fps) || 24;
  p.defaultBoardTiming = Number(p.defaultBoardTiming) || 2000;
  if (!Array.isArray(p.boards)) p.boards = [];
  p.ext = { ...defaultProjectExt(), ...(p.ext || {}) };
  p.boards = p.boards.map((b) => normalizeBoard(b, p));
  updateSceneTiming(p);
  return p;
}

// File naming follows the original Storyboarder (>= 1.6 "layers" format):
//   board-<n>-<UID>.png              name base only — the file itself must NOT
//                                    exist, or the original app treats the project
//                                    as a pre-1.6 file and migrates it (moves it
//                                    into the fill layer).
//   board-<n>-<UID>-<layer>.png      one PNG per layer
//   board-<n>-<UID>-thumbnail.png    timeline thumbnail
//   board-<n>-<UID>-posterframe.jpg  flattened board (what we hand to AI / exports)
const stripPng = (url) => String(url || '').replace(/\.png$/i, '');
const boardFilenameForLayer = (board, layer) => `${stripPng(board.url)}-${layer}.png`;
const boardFilenameForThumbnail = (board) => `${stripPng(board.url)}-thumbnail.png`;
const boardFilenameForPosterFrame = (board) => `${stripPng(board.url)}-posterframe.jpg`;

/** The flattened image to show/export for a board: posterframe, or the legacy main file. */
const boardImageFilename = (board) => (board._legacyMain ? board.url : boardFilenameForPosterFrame(board));

/** Every image file a board references (used for duplicate / delete / export). */
function referencedFiles(board) {
  const files = new Set();
  if (board.url) files.add(board.url);
  files.add(boardFilenameForThumbnail(board));
  files.add(boardFilenameForPosterFrame(board));
  for (const [, layer] of Object.entries(board.layers || {})) {
    if (layer && layer.url) files.add(layer.url);
    if (layer && layer.thumbnail) files.add(layer.thumbnail);
  }
  return [...files];
}

/** Project JSON as written to disk: runtime-only `_` keys are dropped. */
function toFileJson(project, indent = 2) {
  return JSON.stringify(project, (key, value) => (key.startsWith('_') ? undefined : value), indent);
}

module.exports = {
  toFileJson,
  boardFilenameForPosterFrame,
  boardImageFilename,
  LAYER_ORDER,
  DRAWING_LAYERS,
  SHOT_TYPES,
  CAMERA_MOVES,
  BOARD_STATUS,
  defaultBoardExt,
  defaultProjectExt,
  boardFileImageSize,
  uniqueUid,
  createBoard,
  boardDuration,
  updateSceneTiming,
  totalDuration,
  normalizeBoard,
  normalizeProject,
  boardFilenameForLayer,
  boardFilenameForThumbnail,
  referencedFiles,
};
