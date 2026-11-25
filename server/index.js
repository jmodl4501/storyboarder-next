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
const sceneImport = require('./lib/sceneImport');
const videoFetch = require('./lib/videoFetch');
const whiteboard = require('./lib/whiteboard');
const util = require('./lib/util');
const pkg = require('../package.json');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

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
  // downloaded videos waiting to be analysed in the browser (see lib/videoFetch.js)
  app.use('/cache/video', express.static(videoFetch.cacheRoot(), { dotfiles: 'deny', etag: true, index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=3600') }));

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

  app.post('/api/projects/:id/boards/:uid/reference', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
    const mime = String(req.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw new HttpError(415, `unsupported reference image type "${mime || 'unknown'}"`);
    const board = await store.saveBoardReference(req.params.id, req.params.uid, req.body, mime);
    res.status(201).json({ board });
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

  /** Size limit per asset: videos get their own (bigger) budget. */
  const assetLimitFor = (mime, name) => (/^video\//.test(mime) || videoFetch.VIDEO_EXT.has(String(name || '').split('.').pop().toLowerCase()) ? videoFetch.maxVideoBytes() : ASSET_MAX_BYTES);

  /** Stream a request body to a temp file with a byte cap. Returns { file, size }. */
  async function streamToTemp(req, maxBytes) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbn-upload-'));
    const file = path.join(dir, 'upload.bin');
    let size = 0;
    const ws = fs.createWriteStream(file);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw new HttpError(413, `asset larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
        if (!ws.write(chunk)) await new Promise((res) => ws.once('drain', res));
      }
    } catch (err) {
      ws.destroy();
      await fsp.rm(dir, { recursive: true, force: true });
      throw err;
    }
    await new Promise((res) => ws.end(res));
    return { file, size, cleanup: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) };
  }

  // JSON: { name, mime, dataUrl }  — or raw bytes (any non-JSON Content-Type, streamed to disk) with ?name=&mime=
  app.post('/api/projects/:id/assets', wrap(async (req, res) => {
    if (req.is('application/json')) {
      const body = req.body || {};
      const name = String(body.name || 'upload');
      let mime = String(body.mime || '');
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(body.dataUrl || ''));
      if (!m) throw new HttpError(400, 'dataUrl (data:...;base64,...) is required');
      if (!mime) mime = m[1] || '';
      const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
      if (buf.length > assetLimitFor(mime, name)) throw new HttpError(413, `asset larger than ${Math.round(assetLimitFor(mime, name) / 1024 / 1024)} MB`);
      const safeName = util.safeAssetName(name, mime);
      const ext = safeName.split('.').pop();
      if (!ASSET_EXT.has(ext)) throw new HttpError(415, `unsupported asset type ".${ext}"`);
      const asset = await store.saveAsset(req.params.id, safeName, buf, mime || util.mimeFromName(safeName));
      res.status(201).json({ asset });
      return;
    }
    const name = String(req.query.name || 'upload');
    const mime = String(req.query.mime || req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const safeName = util.safeAssetName(name, mime);
    const ext = safeName.split('.').pop();
    if (!ASSET_EXT.has(ext)) throw new HttpError(415, `unsupported asset type ".${ext}"`);
    await store.findBoardFile(req.params.id);
    const tmp = await streamToTemp(req, assetLimitFor(mime, safeName));
    try {
      if (!tmp.size) throw new HttpError(400, 'empty upload');
      const asset = await store.saveAssetFile(req.params.id, safeName, tmp.file, mime || util.mimeFromName(safeName));
      res.status(201).json({ asset });
    } finally {
      tmp.cleanup();
    }
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

  // ---- video → scene storyboard ------------------------------------------
  app.get('/api/video/capabilities', wrap(async (req, res) => {
    const caps = await videoFetch.capabilities();
    res.json({ ytdlp: { available: caps.ytdlp.available, version: caps.ytdlp.version }, ffmpeg: { available: caps.ffmpeg.available }, maxMb: caps.maxMb, vision: ai.status().text });
  }));

  /** Bring a video to the server (direct URL or yt-dlp) so the browser can read its frames. 202 + job polling. */
  app.post('/api/projects/:id/video/fetch', wrap(async (req, res) => {
    await store.findBoardFile(req.params.id);
    const { url, quality } = req.body || {};
    const job = await videoFetch.startFetch({ projectId: req.params.id, url, quality });
    res.status(202).json({ job });
  }));

  app.get('/api/video/jobs/:id', wrap(async (req, res) => {
    const job = videoFetch.getJob(req.params.id);
    if (!job) throw new HttpError(404, 'no such job');
    res.json({ job });
  }));

  app.delete('/api/video/jobs/:id', wrap(async (req, res) => {
    res.json({ ok: await videoFetch.removeJob(req.params.id) });
  }));

  /** Ask the vision model to caption scene key frames (≤ 10 per call). */
  app.post('/api/ai/describe-scenes', wrap(async (req, res) => {
    const body = req.body || {};
    const scenes = Array.isArray(body.scenes) ? body.scenes.slice(0, 10) : [];
    if (!scenes.length) throw new HttpError(400, 'scenes[] is required');
    for (const s of scenes) {
      if (s.image && (typeof s.image !== 'string' || !s.image.startsWith('data:image/') || s.image.length > 900000)) throw new HttpError(400, 'scene.image must be a data URL under ~650 KB');
    }
    res.json(await ai.describeScenes({ scenes, title: body.title, style: body.style, context: body.context }));
  }));

  /** Create boards from browser-detected scenes (images are uploaded afterwards per board). */
  app.post('/api/projects/:id/import/scenes', wrap(async (req, res) => {
    const body = req.body || {};
    const { data: current } = await store.load(req.params.id);
    const { boards: out, summary, source } = sceneImport.toBoards({ scenes: body.scenes, source: body.source }, { defaultBoardTiming: current.defaultBoardTiming });
    if (!out.length) throw new HttpError(400, 'no scenes to import');
    // optionally keep the downloaded video as a project asset
    let asset = null;
    if (body.keepVideo && body.cacheJob) {
      const jf = videoFetch.jobFile(String(body.cacheJob));
      if (!jf) throw new HttpError(410, 'the downloaded video is no longer available — fetch it again');
      const ext = jf.name.split('.').pop();
      const stem = String(source.title || '').replace(/\.[A-Za-z0-9]{1,8}$/, ''); // direct URLs carry the file name as title
      asset = await store.saveAssetFile(req.params.id, stem ? `${stem}.${ext}` : jf.name, jf.file, jf.mime);
    } else if (body.keepVideo && source.asset) {
      asset = { url: source.asset, name: decodeURIComponent(source.asset.split('/').pop()), mime: util.mimeFromName(source.asset) };
    }
    if (asset) for (const b of out) b.ext.source.asset = asset.url;
    let wbResult = null;
    const { data, created } = await store.insertBoards(req.params.id, out, {
      afterUid: body.afterUid,
      replaceEmptyFirstBoard: body.replaceEmptyFirstBoard,
      mutate: (d, uids) => {
        if (source.title && !d.ext.title) d.ext.title = source.title;
        d.ext.imports = Array.isArray(d.ext.imports) ? d.ext.imports : [];
        d.ext.imports.push({ at: util.nowIso(), kind: 'video-scenes', source: source.kind, videoId: source.videoId, boards: uids.length, sourceUrl: source.url, file: source.fileName, asset: asset ? asset.url : '', mode: String(body.mode || ''), withAi: summary.withAi });
        if (body.addToWhiteboard) {
          const wb = whiteboard.normalizeWhiteboard(d.ext.whiteboard);
          wbResult = whiteboard.addBoardCards(wb, {
            title: source.title || source.fileName || source.videoId || '영상 장면',
            uids,
            aspectRatio: d.aspectRatio,
            notes: Object.fromEntries(out.map((b, i) => [uids[i], b.action || ''])),
          });
          const link = (out.find((b) => b.ext.links && b.ext.links.length) || { ext: { links: [] } }).ext.links[0];
          if (asset) {
            wb.nodes.push(whiteboard.normalizeNode({ type: 'video', x: wbResult.frame.x, y: wbResult.frame.y - 300, w: 440, h: 260, src: asset.url, name: asset.name, note: source.title || '' }));
          } else if (link && link.embedUrl) {
            wb.nodes.push(whiteboard.normalizeNode({ type: 'embed', x: wbResult.frame.x, y: wbResult.frame.y - 300, w: 440, h: 260, url: source.url, embedUrl: link.embedUrl.replace(/[?&]start=\d+/, ''), title: link.title || source.title || source.url, thumbnail: link.thumbnail || '', provider: link.provider || 'web' }));
          }
          d.ext.whiteboard = wb;
        }
      },
    });
    res.status(201).json({ project: data, created, summary, asset, whiteboard: wbResult ? { frame: wbResult.frame.id, cards: wbResult.cards.length } : null });
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
