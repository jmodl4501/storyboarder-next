// Client-side helpers (mirrors server/lib/util.js + boards.js where needed)

export const LAYER_ORDER = ['reference', 'fill', 'tone', 'pencil', 'ink', 'notes'];
export const DRAWING_LAYERS = ['fill', 'tone', 'pencil', 'ink'];

export function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function msToTimecode(ms, fps = 24) {
  const totalFrames = Math.round((Math.max(0, ms) / 1000) * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(frames)}`;
}

export function msToClock(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function boardDuration(project, board) {
  return board.duration != null && board.duration !== '' ? Number(board.duration) : Number(project.defaultBoardTiming) || 2000;
}

/** Same numbering rules as the server (and the original Storyboarder). */
export function updateSceneTiming(project) {
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
      } else subShot++;
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

export function totalDuration(project) {
  return (project.boards || []).reduce((s, b) => s + boardDuration(project, b), 0);
}

export function boardImageSize(project) {
  const ar = Number(project.aspectRatio) || 16 / 9;
  return ar >= 1 ? [Math.round(900 * ar), 900] : [900, Math.round(900 / ar)];
}

export function debounce(fn, wait) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
  d.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  d.pending = () => t !== null;
  return d;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function fmtSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad(s)}`;
}

/** true when the board has any image file we can show (per-layer files or a legacy composite). */
export function boardHasImage(board) {
  return !!(board && ((board.layers && Object.keys(board.layers).length) || board._legacyMain));
}

export function thumbnailName(board) {
  return String(board.url || '').replace(/\.png$/i, '') + '-thumbnail.png';
}

/** Flattened board image (original Storyboarder "posterframe"); legacy 1.x files keep it in `url`. */
export function boardImageName(board) {
  if (board._legacyMain) return board.url;
  return String(board.url || '').replace(/\.png$/i, '') + '-posterframe.jpg';
}

export function aspectLabel(ar) {
  const table = [[16 / 9, '16:9'], [2.39, '2.39:1'], [2.35, '2.35:1'], [1.85, '1.85:1'], [4 / 3, '4:3'], [1, '1:1'], [9 / 16, '9:16'], [0.8, '4:5']];
  for (const [v, l] of table) if (Math.abs(v - ar) < 0.02) return l;
  return `${Number(ar).toFixed(2)}:1`;
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
