'use strict';

/**
 * Project storage.  Layout (identical to the original Storyboarder):
 *
 *   projects/
 *     my-film/
 *       my-film.storyboarder      <- JSON
 *       images/
 *         board-1-ABCDE.png                (flattened composite, what we feed to AI)
 *         board-1-ABCDE-pencil.png ...     (one file per layer)
 *         board-1-ABCDE-thumbnail.jpg      (small preview used in the timeline)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const pkg = require('../../package.json');
const util = require('./util');
const boards = require('./boards');
const png = require('./png');
const whiteboard = require('./whiteboard');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'projects');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ProjectStore {
  constructor(rootDir = process.env.PROJECTS_DIR || DEFAULT_DIR) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  dirFor(id) {
    if (!id || id !== util.safeProjectId(id) || id.startsWith('.')) throw new HttpError(400, 'invalid project id');
    return path.join(this.rootDir, id);
  }

  imagesDir(id) {
    return path.join(this.dirFor(id), 'images');
  }

  /** Whiteboard uploads (images / videos / files) live next to the board images. */
  assetsDir(id) {
    return path.join(this.dirFor(id), 'assets');
  }

  async findBoardFile(id) {
    const dir = this.dirFor(id);
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      throw new HttpError(404, `project "${id}" not found`);
    }
    const preferred = `${id}.storyboarder`;
    if (entries.includes(preferred)) return path.join(dir, preferred);
    const any = entries.find((f) => f.endsWith('.storyboarder'));
    if (!any) throw new HttpError(404, `project "${id}" has no .storyboarder file`);
    return path.join(dir, any);
  }

  async list() {
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      try {
        const { data, file } = await this.load(ent.name);
        const stat = await fsp.stat(file);
        const first = data.boards.find((b) => b.layers && Object.keys(b.layers).length);
        out.push({
          id: ent.name,
          title: data.ext.title || ent.name,
          boardCount: data.boards.length,
          aspectRatio: data.aspectRatio,
          fps: data.fps,
          totalDuration: boards.totalDuration(data),
          updated: Math.max(stat.mtimeMs, data.ext.updated || 0),
          thumbnail: first ? `/projects/${encodeURIComponent(ent.name)}/images/${boards.boardFilenameForThumbnail(first)}?v=${first.lastEdited}` : null,
        });
      } catch (err) {
        // folders without a valid .storyboarder are skipped silently
      }
    }
    out.sort((a, b) => b.updated - a.updated);
    return out;
  }

  async exists(id) {
    try {
      await fsp.access(this.dirFor(id));
      return true;
    } catch {
      return false;
    }
  }

  async create({ name, aspectRatio, fps, defaultBoardTiming, style, title } = {}) {
    const id = util.safeProjectId(name);
    if (!id) throw new HttpError(400, 'project name is required');
    if (await this.exists(id)) throw new HttpError(409, `project "${id}" already exists`);
    const data = boards.normalizeProject({
      version: pkg.version,
      aspectRatio: Number(aspectRatio) || 16 / 9,
      fps: Number(fps) || 24,
      defaultBoardTiming: Number(defaultBoardTiming) || 2000,
      boards: [],
      ext: { ...boards.defaultProjectExt(), title: title || name, ...(style ? { style } : {}) },
    });
    data.boards.push(boards.createBoard(data));
    boards.updateSceneTiming(data);
    await fsp.mkdir(this.imagesDir(id), { recursive: true });
    await this.write(id, data);
    return { id, data };
  }

  async load(id) {
    const file = await this.findBoardFile(id);
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      throw new HttpError(500, `cannot parse ${path.basename(file)}: ${err.message}`);
    }
    const data = boards.normalizeProject(raw);
    // Files written by Storyboarder 1.x keep the drawing in `url` (no per-layer
    // files).  Flag those boards so the client knows the composite is loadable.
    const imgDir = path.join(path.dirname(file), 'images');
    await Promise.all(
      data.boards.map(async (b) => {
        const hasDrawing = boards.DRAWING_LAYERS.some((n) => b.layers[n] && b.layers[n].url);
        if (hasDrawing || !b.url) return;
        try {
          await fsp.access(path.join(imgDir, b.url));
          b._legacyMain = true;
        } catch {
          /* no composite yet: a fresh, empty board */
        }
      }),
    );
    return { id, file, data };
  }

  async write(id, data) {
    const dir = this.dirFor(id);
    await fsp.mkdir(path.join(dir, 'images'), { recursive: true });
    let file;
    try {
      file = await this.findBoardFile(id);
    } catch {
      file = path.join(dir, `${id}.storyboarder`);
    }
    data.ext = data.ext || {};
    data.ext.updated = Date.now();
    data.version = data.version || pkg.version;
    boards.updateSceneTiming(data);
    const tmp = `${file}.tmp`;
    const json = boards.toFileJson(data);
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, file);
    return data;
  }

  /**
   * Save the JSON sent by the client.  Image related fields (url, layers,
   * lastEdited) are owned by the server because images are uploaded through a
   * different endpoint; this prevents a stale PUT from dropping a layer that was
   * just written.
   */
  async saveFromClient(id, incoming) {
    const { data: onDisk } = await this.load(id);
    if (!incoming || !Array.isArray(incoming.boards)) throw new HttpError(400, 'boards[] is required');
    const diskByUid = new Map(onDisk.boards.map((b) => [b.uid, b]));
    const incomingExt = { ...(incoming.ext || {}) };
    delete incomingExt.whiteboard; // owned by the whiteboard endpoint (may be edited in another tab)
    const merged = boards.normalizeProject({
      ...onDisk,
      ...incoming,
      ext: { ...onDisk.ext, ...incomingExt },
      boards: incoming.boards.map((b) => {
        const prev = diskByUid.get(b.uid);
        if (!prev) return b;
        return {
          ...b,
          url: prev.url,
          layers: prev.layers,
          lastEdited: prev.lastEdited,
          ext: { ...(b.ext || {}), aiJobs: (b.ext && b.ext.aiJobs && b.ext.aiJobs.length) ? b.ext.aiJobs : (prev.ext.aiJobs || []) },
        };
      }),
    });
    // aspect ratio is fixed after creation (image files depend on it)
    merged.aspectRatio = onDisk.aspectRatio;
    return this.write(id, merged);
  }

  // ---- bulk board insertion (script import, analysis import) --------------

  /**
   * Insert board records (as produced by fountain.scriptToBoards / analysisImport.toBoards)
   * after `afterUid` (default: at the end).  A brand-new project's single empty
   * board is dropped when the import fills the project.
   */
  async insertBoards(id, records, { afterUid, replaceEmptyFirstBoard = true, mutate } = {}) {
    const { data } = await this.load(id);
    if (!records.length) throw new HttpError(400, 'nothing to insert');
    let index = afterUid ? data.boards.findIndex((b) => b.uid === afterUid) : data.boards.length - 1;
    if (index < 0) index = data.boards.length - 1;
    const created = [];
    const newBoards = records.map((r) => {
      const nb = boards.createBoard(data, r);
      data.boards.push(nb); // temporarily, so uid uniqueness accounts for it
      created.push(nb.uid);
      return nb;
    });
    data.boards.splice(data.boards.length - newBoards.length, newBoards.length);
    data.boards.splice(index + 1, 0, ...newBoards);
    if (replaceEmptyFirstBoard !== false && data.boards.length > newBoards.length) {
      const first = data.boards[0];
      const empty = !first.action && !first.dialogue && !first.notes && !Object.keys(first.layers || {}).length;
      if (empty && !created.includes(first.uid) && data.boards.length - 1 === newBoards.length) data.boards.shift();
    }
    if (typeof mutate === 'function') await mutate(data, created);
    await this.write(id, data);
    return { data, created };
  }

  // ---- whiteboard -------------------------------------------------------

  async getWhiteboard(id) {
    const { data } = await this.load(id);
    return whiteboard.normalizeWhiteboard(data.ext.whiteboard);
  }

  async saveWhiteboard(id, raw) {
    const { data } = await this.load(id);
    const wb = whiteboard.normalizeWhiteboard(raw);
    // board cards must point at boards that still exist
    const uids = new Set(data.boards.map((b) => b.uid));
    const dropped = new Set(wb.nodes.filter((n) => n.type === 'board' && !uids.has(n.uid)).map((n) => n.id));
    if (dropped.size) {
      wb.nodes = wb.nodes.filter((n) => !dropped.has(n.id));
      wb.edges = wb.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to));
    }
    data.ext.whiteboard = wb;
    await this.write(id, data);
    this.gcAssets(id, wb).catch(() => {});
    return wb;
  }

  // ---- assets -----------------------------------------------------------

  /**
   * Store an uploaded file under assets/<sha1-prefix>-<safe name>.  Identical
   * content is stored once.  Returns { name, url, size, mime }.
   */
  async saveAsset(id, originalName, buf, mime = '') {
    await this.findBoardFile(id); // 404 if missing
    if (!buf || !buf.length) throw new HttpError(400, 'empty upload');
    const dir = this.assetsDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const name = `${hash}-${util.safeAssetName(originalName, mime)}`;
    const file = path.join(dir, name);
    try {
      await fsp.access(file);
    } catch {
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
    }
    return { name, url: `/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`, size: buf.length, mime: mime || util.mimeFromName(name) };
  }

  async listAssets(id) {
    await this.findBoardFile(id);
    let names = [];
    try {
      names = await fsp.readdir(this.assetsDir(id));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (name.endsWith('.tmp') || name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(this.assetsDir(id), name));
      out.push({ name, url: `/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`, size: st.size, mime: util.mimeFromName(name), mtime: st.mtimeMs });
    }
    return out;
  }

  async deleteAsset(id, name) {
    if (!util.isSafeFilename(name)) throw new HttpError(400, 'bad asset name');
    await fsp.rm(path.join(this.assetsDir(id), name), { force: true });
  }

  /** Remove asset files no node references any more (only files older than 10 min, to dodge upload races). */
  async gcAssets(id, wb) {
    const keep = new Set(whiteboard.referencedAssets(wb, id));
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const a of await this.listAssets(id)) {
      if (!keep.has(a.name) && a.mtime < cutoff) await fsp.rm(path.join(this.assetsDir(id), a.name), { force: true });
    }
  }

  async remove(id) {
    const dir = this.dirFor(id);
    await this.findBoardFile(id); // 404 if missing
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // ---- board operations -------------------------------------------------

  async addBoard(id, { afterUid, count = 1, board: overrides } = {}) {
    const { data } = await this.load(id);
    let index = afterUid ? data.boards.findIndex((b) => b.uid === afterUid) : data.boards.length - 1;
    if (index < 0) index = data.boards.length - 1;
    const created = [];
    for (let i = 0; i < Math.min(50, Math.max(1, count)); i++) {
      const b = boards.createBoard(data, overrides || {});
      data.boards.splice(index + 1 + i, 0, b);
      created.push(b.uid);
    }
    await this.write(id, data);
    return { data, created };
  }

  async duplicateBoard(id, uid) {
    const { data } = await this.load(id);
    const index = data.boards.findIndex((b) => b.uid === uid);
    if (index < 0) throw new HttpError(404, 'board not found');
    const src = data.boards[index];
    const copy = boards.createBoard(data, {
      newShot: false,
      dialogue: src.dialogue,
      action: src.action,
      notes: src.notes,
      duration: src.duration,
      lineMileage: src.lineMileage,
      ext: JSON.parse(JSON.stringify({ ...src.ext, aiJobs: [], status: 'draft' })),
    });
    const imgDir = this.imagesDir(id);
    copy.layers = {};
    for (const [name, layer] of Object.entries(src.layers || {})) {
      if (!layer || !layer.url) continue;
      const target = boards.boardFilenameForLayer(copy, name);
      if (await copyIfExists(path.join(imgDir, layer.url), path.join(imgDir, target))) {
        copy.layers[name] = { ...layer, url: target };
        delete copy.layers[name].thumbnail;
      }
    }
    if (src._legacyMain) {
      // pre-1.6 main image: copy it as the duplicate's fill layer (= migrated form)
      const target = boards.boardFilenameForLayer(copy, 'fill');
      if (await copyIfExists(path.join(imgDir, src.url), path.join(imgDir, target))) copy.layers.fill = { url: target };
    }
    await copyIfExists(
      path.join(imgDir, boards.boardFilenameForThumbnail(src)),
      path.join(imgDir, boards.boardFilenameForThumbnail(copy)),
    );
    await copyIfExists(
      path.join(imgDir, boards.boardFilenameForPosterFrame(src)),
      path.join(imgDir, boards.boardFilenameForPosterFrame(copy)),
    );
    data.boards.splice(index + 1, 0, copy);
    await this.write(id, data);
    return { data, created: copy.uid };
  }

  async deleteBoard(id, uid) {
    const { data } = await this.load(id);
    const index = data.boards.findIndex((b) => b.uid === uid);
    if (index < 0) throw new HttpError(404, 'board not found');
    const [removed] = data.boards.splice(index, 1);
    if (data.boards.length === 0) data.boards.push(boards.createBoard(data));
    const imgDir = this.imagesDir(id);
    for (const f of boards.referencedFiles(removed)) {
      await fsp.rm(path.join(imgDir, f), { force: true });
    }
    await this.write(id, data);
    return { data, index: Math.min(index, data.boards.length - 1) };
  }

  async reorderBoards(id, order) {
    const { data } = await this.load(id);
    if (!Array.isArray(order)) throw new HttpError(400, 'order[] required');
    const byUid = new Map(data.boards.map((b) => [b.uid, b]));
    const seen = new Set();
    const next = [];
    for (const uid of order) {
      const b = byUid.get(uid);
      if (b && !seen.has(uid)) {
        next.push(b);
        seen.add(uid);
      }
    }
    for (const b of data.boards) if (!seen.has(b.uid)) next.push(b);
    data.boards = next;
    await this.write(id, data);
    return data;
  }

  // ---- images -----------------------------------------------------------

  /**
   * payload = {
   *   layers: { pencil: 'data:image/png;base64,...', ... },   // dirty layers only
   *   clearedLayers: ['tone'],                                // layers that became empty
   *   composite: 'data:image/png;base64,...',                 // flattened board (no notes)
   *   thumbnail: 'data:image/jpeg;base64,...',
   *   lineMileage: 123.4,
   *   layerOpacity: { reference: 0.5 }
   * }
   */
  async saveBoardImages(id, uid, payload = {}) {
    const { data } = await this.load(id);
    const board = data.boards.find((b) => b.uid === uid);
    if (!board) throw new HttpError(404, 'board not found');
    const imgDir = this.imagesDir(id);
    await fsp.mkdir(imgDir, { recursive: true });

    board.layers = board.layers || {};
    for (const [name, dataUrl] of Object.entries(payload.layers || {})) {
      if (!boards.LAYER_ORDER.includes(name)) throw new HttpError(400, `unknown layer "${name}"`);
      const filename = boards.boardFilenameForLayer(board, name);
      await fsp.writeFile(path.join(imgDir, filename), await png.optimizeAsync(decodeDataUrl(dataUrl, 'image/png')));
      board.layers[name] = { ...(board.layers[name] || {}), url: filename };
    }
    for (const name of payload.clearedLayers || []) {
      if (board.layers[name] && board.layers[name].url) {
        await fsp.rm(path.join(imgDir, board.layers[name].url), { force: true });
      }
      delete board.layers[name];
    }
    for (const [name, opacity] of Object.entries(payload.layerOpacity || {})) {
      if (board.layers[name]) board.layers[name].opacity = util.clamp(Number(opacity) || 1, 0, 1);
    }
    if (board.layers.fill && board.layers.fill.url && board.url) {
      // A pre-1.6 "main" image that has just been migrated into the fill layer
      // (see surface.loadBoard) – drop the old file, exactly like the original app.
      await fsp.rm(path.join(imgDir, board.url), { force: true });
      delete board._legacyMain;
    }
    if (payload.composite) {
      // Flattened board = the original's "posterframe" (JPEG). Never written to
      // board.url itself: that file's existence marks a pre-1.6 project.
      const { mime, buf } = decodeDataUrl(payload.composite, 'image/jpeg', { withMime: true });
      if (mime !== 'image/jpeg') throw new HttpError(400, 'composite must be a JPEG data URL');
      await fsp.writeFile(path.join(imgDir, boards.boardFilenameForPosterFrame(board)), buf);
    }
    if (payload.thumbnail) {
      const { mime, buf } = decodeDataUrl(payload.thumbnail, 'image/png', { withMime: true });
      if (mime !== 'image/png') throw new HttpError(400, 'thumbnail must be a PNG data URL');
      await fsp.writeFile(path.join(imgDir, boards.boardFilenameForThumbnail(board)), await png.optimizeAsync(buf, { stripAlpha: true }));
    }
    if (typeof payload.lineMileage === 'number') board.lineMileage = payload.lineMileage;
    board.lastEdited = Date.now();
    await this.write(id, data);
    return board;
  }

  async imageFileExists(id, filename) {
    if (!util.isSafeFilename(filename)) return false;
    try {
      await fsp.access(path.join(this.imagesDir(id), filename));
      return true;
    } catch {
      return false;
    }
  }

  async readImage(id, filename) {
    if (!util.isSafeFilename(filename)) throw new HttpError(400, 'bad filename');
    return fsp.readFile(path.join(this.imagesDir(id), filename));
  }
}

async function copyIfExists(src, dst) {
  try {
    await fsp.copyFile(src, dst);
    return true;
  } catch {
    return false;
  }
}

function decodeDataUrl(dataUrl, expectedType, { withMime = false } = {}) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'expected a base64 data URL');
  const mime = m[1].toLowerCase();
  if (expectedType && !mime.startsWith('image/')) throw new HttpError(400, 'expected an image data URL');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new HttpError(400, 'empty image');
  if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, 'image too large');
  return withMime ? { mime, buf } : buf;
}

module.exports = { ProjectStore, HttpError, decodeDataUrl };
