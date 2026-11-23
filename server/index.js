'use strict';

const path = require('path');
const express = require('express');
const { loadEnv } = require('./lib/env');
const { ProjectStore, HttpError } = require('./lib/projects');
const boards = require('./lib/boards');
const fountain = require('./lib/fountain');
const linkPreview = require('./lib/linkPreview');
const promptBuilder = require('./lib/promptBuilder');
const exporters = require('./lib/exporters');
const ai = require('./lib/ai');
const analysisImport = require('./lib/analysisImport');
const whiteboard = require('./lib/whiteboard');
const util = require('./lib/util');
const pkg = require('../package.json');

/** Whiteboard uploads: media the browser can render inline + a few document types. */
const ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'm4a', 'ogg', 'pdf', 'json', 'txt', 'md', 'csv']);
const ASSET_MAX_BYTES = 60 * 1024 * 1024;

loadEnv();

/**
 * Build the express app.  Exported so tests can spin up an instance on a
 * random port with a temporary projects directory.
 */
function createApp({ projectsDir } = {}) {
  const store = new ProjectStore(projectsDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '80mb' }));

  // static front-end + project images
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', etag: true }));
  app.use('/docs', express.static(path.join(__dirname, '..', 'docs'), { index: false, dotfiles: 'deny', setHeaders: (res, file) => { if (file.endsWith('.md')) res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); } }));
  app.use(
    '/projects',
    express.static(store.rootDir, {
      dotfiles: 'deny',
      etag: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/health', (req, res) => res.json({ ok: true, name: pkg.name, version: pkg.version, projectsDir: store.rootDir }));

  app.get('/api/meta', (req, res) =>
    res.json({
      version: pkg.version,
      shotTypes: boards.SHOT_TYPES,
      cameraMoves: boards.CAMERA_MOVES,
      boardStatus: boards.BOARD_STATUS,
      layers: boards.LAYER_ORDER,
      shotTypeLabelsKo: promptBuilder.SHOT_TYPE_LABELS_KO,
      cameraMoveLabelsKo: promptBuilder.CAMERA_MOVE_LABELS_KO,
      ai: ai.status(),
    }),
  );

  // ---- projects ---------------------------------------------------------
  app.get('/api/projects', wrap(async (req, res) => res.json(await store.list())));

  app.post('/api/projects', wrap(async (req, res) => {
    const { id, data } = await store.create(req.body || {});
    res.status(201).json({ id, project: data });
  }));

  app.get('/api/projects/:id', wrap(async (req, res) => {
    const { id, data } = await store.load(req.params.id);
    res.json({ id, project: data, imageSize: boards.boardFileImageSize(data) });
  }));

  app.put('/api/projects/:id', wrap(async (req, res) => {
    const data = await store.saveFromClient(req.params.id, req.body);
    res.json({ id: req.params.id, project: data });
  }));

  app.delete('/api/projects/:id', wrap(async (req, res) => {
    await store.remove(req.params.id);
    res.json({ ok: true });
  }));

  // ---- boards -----------------------------------------------------------
  app.post('/api/projects/:id/boards', wrap(async (req, res) => {
    const { data, created } = await store.addBoard(req.params.id, req.body || {});
    res.status(201).json({ project: data, created });
  }));

  app.post('/api/projects/:id/boards/reorder', wrap(async (req, res) => {
    const data = await store.reorderBoards(req.params.id, (req.body || {}).order);
    res.json({ project: data });
  }));

  app.post('/api/projects/:id/boards/:uid/duplicate', wrap(async (req, res) => {
    const { data, created } = await store.duplicateBoard(req.params.id, req.params.uid);
    res.status(201).json({ project: data, created });
  }));

  app.delete('/api/projects/:id/boards/:uid', wrap(async (req, res) => {
    const { data, index } = await store.deleteBoard(req.params.id, req.params.uid);
    res.json({ project: data, index });
  }));

  app.post('/api/projects/:id/boards/:uid/image', wrap(async (req, res) => {
    const board = await store.saveBoardImages(req.params.id, req.params.uid, req.body || {});
    res.json({ board });
  }));

  // ---- script import ----------------------------------------------------
  app.post('/api/script/parse', (req, res) => {
    const { text, granularity, defaultBoardTiming } = req.body || {};
    const result = fountain.scriptToBoards(text || '', { granularity, defaultBoardTiming });
    res.json({ meta: result.meta, summary: fountain.summarize(result.elements), boardCount: result.boards.length, boards: result.boards.slice(0, 200) });
  });

  app.post('/api/projects/:id/script', wrap(async (req, res) => {
    const { text, granularity, afterUid, replaceEmptyFirstBoard } = req.body || {};
    const { data: current } = await store.load(req.params.id);
    const result = fountain.scriptToBoards(text || '', { granularity, defaultBoardTiming: current.defaultBoardTiming });
    if (!result.boards.length) throw new HttpError(400, 'no boards could be created from the text');
    const { data, created } = await store.insertBoards(req.params.id, result.boards, {
      afterUid,
      replaceEmptyFirstBoard,
      mutate: (d) => {
        if (result.meta.title && !d.ext.title) d.ext.title = result.meta.title;
      },
    });
    res.status(201).json({ project: data, created, summary: fountain.summarize(result.elements), meta: result.meta });
  }));

  // ---- video analysis import (shots / transcript / scene lists) ---------
  const analysisInput = (body) => {
    const { text, data } = body || {};
    if (data !== undefined && data !== null && typeof data === 'object') return data;
    if (typeof text === 'string' && text.trim()) return text;
    throw new HttpError(400, 'text (string) or data (object) is required');
  };

  app.post('/api/import/analysis/preview', wrap(async (req, res) => {
    const parsed = analysisImport.parse(analysisInput(req.body));
    const { boards: out, summary } = analysisImport.toBoards(parsed, { defaultBoardTiming: (req.body || {}).defaultBoardTiming });
    res.json({ summary, warnings: parsed.warnings, boards: out.slice(0, 200) });
  }));

  app.post('/api/projects/:id/import/analysis', wrap(async (req, res) => {
    const body = req.body || {};
    const { data: current } = await store.load(req.params.id);
    const parsed = analysisImport.parse(analysisInput(body));
    const { boards: out, summary } = analysisImport.toBoards(parsed, { defaultBoardTiming: current.defaultBoardTiming });
    if (!out.length) throw new HttpError(400, 'no boards could be created from the analysis');
    let wbResult = null;
    const { data, created } = await store.insertBoards(req.params.id, out, {
      afterUid: body.afterUid,
      replaceEmptyFirstBoard: body.replaceEmptyFirstBoard,
      mutate: (d, uids) => {
        if (summary.title && !d.ext.title) d.ext.title = summary.title;
        d.ext.imports = Array.isArray(d.ext.imports) ? d.ext.imports : [];
        d.ext.imports.push({ at: util.nowIso(), kind: 'analysis', format: summary.format, videoId: summary.videoId, boards: uids.length, sourceUrl: summary.sourceUrl, sourcePath: summary.sourcePath });
        if (body.addToWhiteboard) {
          const wb = whiteboard.normalizeWhiteboard(d.ext.whiteboard);
          wbResult = whiteboard.addBoardCards(wb, {
            title: summary.title || summary.videoId || 'Imported shots',
            uids,
            aspectRatio: d.aspectRatio,
            notes: Object.fromEntries(out.map((b, i) => [uids[i], b.notes || ''])),
          });
          if (summary.sourceUrl) {
            const link = (out.find((b) => b.ext && b.ext.links && b.ext.links.length) || { ext: { links: [] } }).ext.links[0];
            if (link) {
              wb.nodes.push(whiteboard.normalizeNode({
                type: link.embedUrl ? 'embed' : 'link',
                x: wbResult.frame.x,
                y: wbResult.frame.y - 260,
                w: 400,
                h: 225,
                url: summary.sourceUrl,
                embedUrl: link.embedUrl ? link.embedUrl.replace(/[?&]start=\d+/, '') : '',
                title: link.title || summary.title || summary.sourceUrl,
                thumbnail: link.thumbnail || '',
                provider: link.provider || 'web',
              }));
            }
          }
          d.ext.whiteboard = wb;
        }
      },
    });
    res.status(201).json({ project: data, created, summary, warnings: parsed.warnings, whiteboard: wbResult ? { frame: wbResult.frame.id, cards: wbResult.cards.length } : null });
  }));

  // ---- whiteboard -------------------------------------------------------
  app.get('/api/projects/:id/whiteboard', wrap(async (req, res) => {
    res.json({ whiteboard: await store.getWhiteboard(req.params.id) });
  }));

  app.put('/api/projects/:id/whiteboard', wrap(async (req, res) => {
    const body = req.body || {};
    const raw = body.whiteboard || body;
    if (!raw || !Array.isArray(raw.nodes)) throw new HttpError(400, 'whiteboard.nodes[] is required');
    res.json({ whiteboard: await store.saveWhiteboard(req.params.id, raw) });
  }));

  /** Add the given boards (default: all) as cards inside a new frame on the whiteboard. */
  app.post('/api/projects/:id/whiteboard/boards', wrap(async (req, res) => {
    const { uids, title, cols, origin } = req.body || {};
    const { data } = await store.load(req.params.id);
    const existing = data.boards.map((b) => b.uid);
    const wanted = Array.isArray(uids) && uids.length ? uids.filter((u) => existing.includes(u)) : existing;
    if (!wanted.length) throw new HttpError(400, 'no boards to add');
    const wb = whiteboard.normalizeWhiteboard(data.ext.whiteboard);
    const result = whiteboard.addBoardCards(wb, { title: title || data.ext.title || req.params.id, uids: wanted, aspectRatio: data.aspectRatio, cols, origin });
    data.ext.whiteboard = wb;
    await store.write(req.params.id, data);
    res.status(201).json({ whiteboard: wb, frame: result.frame, cards: result.cards });
  }));

  // ---- whiteboard assets (uploaded images / videos / files) ---------------
  app.get('/api/projects/:id/assets', wrap(async (req, res) => {
    res.json({ assets: await store.listAssets(req.params.id) });
  }));

  // JSON: { name, mime, dataUrl }  — or raw bytes with ?name=&mime= (Content-Type: application/octet-stream)
  app.post('/api/projects/:id/assets', express.raw({ type: ['image/*', 'video/*', 'audio/*', 'application/octet-stream', 'application/pdf'], limit: '80mb' }), wrap(async (req, res) => {
    let name;
    let mime;
    let buf;
    if (Buffer.isBuffer(req.body)) {
      name = String(req.query.name || 'upload');
      mime = String(req.query.mime || req.headers['content-type'] || '').split(';')[0].trim();
      buf = req.body;
    } else {
      const body = req.body || {};
      name = String(body.name || 'upload');
      mime = String(body.mime || '');
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(body.dataUrl || ''));
      if (!m) throw new HttpError(400, 'dataUrl (data:...;base64,...) is required');
      if (!mime) mime = m[1] || '';
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    }
    if (buf.length > ASSET_MAX_BYTES) throw new HttpError(413, `asset larger than ${ASSET_MAX_BYTES / 1024 / 1024} MB`);
    const safeName = util.safeAssetName(name, mime);
    const ext = safeName.split('.').pop();
    if (!ASSET_EXT.has(ext)) throw new HttpError(415, `unsupported asset type ".${ext}"`);
    const asset = await store.saveAsset(req.params.id, safeName, buf, mime || util.mimeFromName(safeName));
    res.status(201).json({ asset });
  }));

  /** Download a remote image/video into the project's assets (so references survive link rot and can be drawn with). */
  app.post('/api/projects/:id/assets/from-url', wrap(async (req, res) => {
    const raw = String((req.body || {}).url || '').trim();
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, 'invalid url');
    }
    if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'only http(s) urls are supported');
    if (linkPreview.isPrivateHost(url.hostname)) throw new HttpError(400, 'private hosts are not allowed');
    await store.findBoardFile(req.params.id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; StoryboarderNext/1.0)', accept: 'image/*,video/*;q=0.9,*/*;q=0.5' } });
    } catch (err) {
      clearTimeout(timer);
      throw new HttpError(502, `download failed: ${err.message}`);
    }
    if (!r.ok) {
      clearTimeout(timer);
      throw new HttpError(502, `download failed: HTTP ${r.status}`);
    }
    const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^(image|video)\//.test(mime)) {
      clearTimeout(timer);
      throw new HttpError(415, `not an image/video (${mime || 'unknown type'})`);
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > ASSET_MAX_BYTES) {
      clearTimeout(timer);
      throw new HttpError(413, 'remote file too large');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > ASSET_MAX_BYTES) {
        clearTimeout(timer);
        throw new HttpError(413, 'remote file too large');
      }
      chunks.push(chunk);
    }
    clearTimeout(timer);
    const name = util.safeAssetName(decodeURIComponent(url.pathname.split('/').pop() || 'remote'), mime);
    const ext = name.split('.').pop();
    if (!ASSET_EXT.has(ext)) throw new HttpError(415, `unsupported asset type ".${ext}"`);
    const asset = await store.saveAsset(req.params.id, name, Buffer.concat(chunks), mime);
    res.status(201).json({ asset: { ...asset, sourceUrl: url.toString() } });
  }));

  app.delete('/api/projects/:id/assets/:name', wrap(async (req, res) => {
    await store.deleteAsset(req.params.id, req.params.name);
    res.json({ ok: true });
  }));

  // ---- link preview -----------------------------------------------------
  app.get('/api/link-preview', wrap(async (req, res) => {
    const data = await linkPreview.preview(req.query.url);
    res.json(data);
  }));
  app.post('/api/link-preview', wrap(async (req, res) => {
    const data = await linkPreview.preview((req.body || {}).url);
    res.json(data);
  }));

  // ---- AI ---------------------------------------------------------------
  app.get('/api/ai/status', (req, res) => res.json(ai.status()));

  const loadBoard = async (projectId, uid) => {
    const { data } = await store.load(projectId);
    const board = data.boards.find((b) => b.uid === uid);
    if (!board) throw new HttpError(404, 'board not found');
    return { project: data, board };
  };

  app.post('/api/ai/prompt', wrap(async (req, res) => {
    const { projectId, uid, board: inlineBoard, project: inlineProject, style } = req.body || {};
    let board = inlineBoard;
    let project = inlineProject;
    if (projectId && uid) ({ project, board } = await loadBoard(projectId, uid));
    if (!board || !project) throw new HttpError(400, 'projectId+uid or board+project required');
    const imageUrl = projectId ? ai.publicImageUrl(projectId, board) : null;
    res.json(promptBuilder.buildPrompt(board, project, { style, imageUrl }));
  }));

  app.post('/api/ai/enhance', wrap(async (req, res) => {
    const { projectId, uid, instructions } = req.body || {};
    const { project, board } = await loadBoard(projectId, uid);
    const result = await ai.enhance({ board, project, instructions });
    res.json(result);
  }));

  app.post('/api/ai/video', wrap(async (req, res) => {
    const { projectId, uid, endpoint, imageUrl, prompt, extra } = req.body || {};
    const { project, board } = await loadBoard(projectId, uid);
    const { job, raw } = await ai.submitVideo({ projectId, board, project, endpoint, imageUrl, prompt, extra });
    board.ext.aiJobs = [job, ...(board.ext.aiJobs || [])].slice(0, 20);
    board.ext.status = 'generating';
    await store.write(projectId, project);
    res.status(202).json({ job, raw, board });
  }));

  app.post('/api/ai/video/poll', wrap(async (req, res) => {
    const { projectId, uid, jobId } = req.body || {};
    const { project, board } = await loadBoard(projectId, uid);
    const job = (board.ext.aiJobs || []).find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, 'job not found');
    const { job: next, raw } = await ai.pollVideo(job);
    board.ext.aiJobs = board.ext.aiJobs.map((j) => (j.id === jobId ? next : j));
    if (next.videoUrl) board.ext.status = 'generated';
    else if (next.status === 'failed' || next.error) board.ext.status = 'ready';
    await store.write(projectId, project);
    res.json({ job: next, raw, board });
  }));

  // ---- exports ----------------------------------------------------------
  app.get('/api/projects/:id/export/:format', wrap(async (req, res) => {
    const { id, data, file } = await store.load(req.params.id);
    const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_');
    switch (req.params.format) {
      case 'csv':
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-shotlist.csv"`);
        return res.send(exporters.toCSV(data));
      case 'markdown':
      case 'md':
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-prompts.md"`);
        return res.send(exporters.toMarkdown(data, { id }));
      case 'prompts':
      case 'prompts.json':
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-prompts.json"`);
        return res.json(exporters.toPromptPack(data, { id, publicBaseUrl: process.env.PUBLIC_BASE_URL }));
      case 'json':
      case 'storyboarder':
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}.storyboarder"`);
        return res.send(boards.toFileJson(data));
      case 'zip': {
        const zip = await exporters.buildZipBundle(data, { id, imagesDir: store.imagesDir(id), assetsDir: store.assetsDir(id), fileName: path.basename(file) });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-storyboard.zip"`);
        return res.send(zip);
      }
      default:
        throw new HttpError(404, `unknown export format "${req.params.format}"`);
    }
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'internal error', details: err.details });
  });

  app.locals.store = store;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.listen(port, host, () => {
    console.log(`Storyboarder Next v${pkg.version}`);
    console.log(`  local:    http://localhost:${port}`);
    console.log(`  network:  http://${host}:${port}  (iPad 등 같은 네트워크의 기기에서 접속 가능)`);
    console.log(`  projects: ${app.locals.store.rootDir}`);
    const s = ai.status();
    console.log(`  AI text provider: ${s.text.configured ? s.text.model : 'not configured'} · video: ${s.video.configured ? s.video.endpoint : 'not configured'}`);
  });
}

module.exports = { createApp };
