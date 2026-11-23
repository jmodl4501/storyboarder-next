'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');

// 1x1 transparent PNG and a tiny JPEG as data URLs
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let server;
let base;
let dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-test-'));
  process.env.LINK_PREVIEW_OFFLINE = '1';
  delete process.env.HF_API_KEY_ID;
  delete process.env.AI_TEXT_API_KEY;
  const app = createApp({ projectsDir: dir });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : ct.includes('zip') ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const PID = '테스트-프로젝트';

test('health + meta', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  const m = await api('GET', '/api/meta');
  assert.ok(m.data.shotTypes.includes('CU'));
  assert.equal(m.data.ai.text.configured, false);
});

test('create / list / get project', async () => {
  const bad = await api('POST', '/api/projects', { name: '   ' });
  assert.equal(bad.status, 400);
  const r = await api('POST', '/api/projects', { name: '테스트 프로젝트', aspectRatio: 1.7777777777777777, fps: 25, style: 'anime' });
  assert.equal(r.status, 201);
  assert.equal(r.data.id, PID);
  assert.equal(r.data.project.boards.length, 1);
  assert.equal(r.data.project.fps, 25);
  assert.equal(r.data.project.ext.style, 'anime');
  assert.ok(fs.existsSync(path.join(dir, PID, `${PID}.storyboarder`)));
  assert.ok(fs.existsSync(path.join(dir, PID, 'images')));

  const dup = await api('POST', '/api/projects', { name: '테스트 프로젝트' });
  assert.equal(dup.status, 409);

  const list = await api('GET', '/api/projects');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].thumbnail, null); // no image yet -> no 404 prone url

  const get = await api('GET', `/api/projects/${encodeURIComponent(PID)}`);
  assert.equal(get.status, 200);
  assert.deepEqual(get.data.imageSize, [1600, 900]);
  const missing = await api('GET', '/api/projects/nope');
  assert.equal(missing.status, 404);
  const traversal = await api('GET', '/api/projects/..%2F..%2Fetc');
  assert.ok(traversal.status >= 400);
});

test('board operations: add, duplicate, reorder, delete', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const first = (await api('GET', p)).data.project.boards[0];
  const add = await api('POST', `${p}/boards`, { afterUid: first.uid, count: 2 });
  assert.equal(add.status, 201);
  assert.equal(add.data.project.boards.length, 3);
  assert.equal(add.data.created.length, 2);

  // upload an image to the first board then duplicate it -> files are copied
  const up = await api('POST', `${p}/boards/${first.uid}/image`, { layers: { pencil: PNG }, composite: JPG, thumbnail: PNG, lineMileage: 12.5 });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.board.layers.pencil.url, first.url.replace('.png', '-pencil.png'));
  // original-app compatible naming: posterframe.jpg + thumbnail.png, and NO file at board.url
  assert.ok(fs.existsSync(path.join(dir, PID, 'images', first.url.replace('.png', '-posterframe.jpg'))));
  assert.ok(fs.existsSync(path.join(dir, PID, 'images', first.url.replace('.png', '-thumbnail.png'))));
  assert.ok(!fs.existsSync(path.join(dir, PID, 'images', first.url)), 'board.url file must not exist (would trigger migration in Storyboarder 1.6+)');
  const badComposite = await api('POST', `${p}/boards/${first.uid}/image`, { composite: PNG });
  assert.equal(badComposite.status, 400);
  const badThumb = await api('POST', `${p}/boards/${first.uid}/image`, { thumbnail: JPG });
  assert.equal(badThumb.status, 400);

  const dupe = await api('POST', `${p}/boards/${first.uid}/duplicate`, {});
  assert.equal(dupe.status, 201);
  const copy = dupe.data.project.boards[1];
  assert.equal(copy.lineMileage, 12.5);
  assert.ok(copy.layers.pencil.url.endsWith(`-${copy.uid}-pencil.png`));
  assert.ok(fs.existsSync(path.join(dir, PID, 'images', copy.layers.pencil.url)));

  const uids = dupe.data.project.boards.map((b) => b.uid);
  const reversed = [...uids].reverse();
  const re = await api('POST', `${p}/boards/reorder`, { order: reversed });
  assert.deepEqual(re.data.project.boards.map((b) => b.uid), reversed);
  assert.deepEqual(re.data.project.boards.map((b) => b.shot), ['1A', '2A', '3A', '4A']);

  const del = await api('DELETE', `${p}/boards/${copy.uid}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.project.boards.length, 3);
  assert.ok(!fs.existsSync(path.join(dir, PID, 'images', copy.layers.pencil.url)), 'files of deleted board are removed');

  // image upload validation
  const badLayer = await api('POST', `${p}/boards/${first.uid}/image`, { layers: { bogus: PNG } });
  assert.equal(badLayer.status, 400);
  const badData = await api('POST', `${p}/boards/${first.uid}/image`, { layers: { ink: 'nope' } });
  assert.equal(badData.status, 400);
});

test('PUT merges text fields but keeps server-owned image metadata', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const { project } = (await api('GET', p)).data;
  const withImage = project.boards.find((b) => b.layers.pencil);
  assert.ok(withImage);
  const stale = JSON.parse(JSON.stringify(project));
  const target = stale.boards.find((b) => b.uid === withImage.uid);
  target.layers = {}; // stale client state
  target.action = '새 액션';
  target.newShot = true;
  target.ext.shotType = 'CU';
  target.ext.links = [{ url: 'https://example.com', title: 'ref' }];
  stale.ext.title = '바뀐 제목';
  stale.aspectRatio = 1; // must be ignored
  const put = await api('PUT', p, stale);
  assert.equal(put.status, 200);
  const saved = put.data.project.boards.find((b) => b.uid === withImage.uid);
  assert.equal(saved.action, '새 액션');
  assert.equal(saved.ext.shotType, 'CU');
  assert.equal(saved.ext.links[0].title, 'ref');
  assert.equal(saved.layers.pencil.url, withImage.layers.pencil.url, 'layers must survive a stale PUT');
  assert.equal(put.data.project.ext.title, '바뀐 제목');
  assert.equal(put.data.project.aspectRatio, 1.7777777777777777);
  // boards: [c, b, first(newShot)] -> 1A, 1B, 2A
  assert.deepEqual(put.data.project.boards.map((b) => b.shot), ['1A', '1B', '2A']);

  const invalid = await api('PUT', p, { nope: true });
  assert.equal(invalid.status, 400);
});

test('script import creates boards', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const parse = await api('POST', '/api/script/parse', { text: 'S#1. 집\n\n민지: 안녕.\n\n준호가 웃는다.', granularity: 'element' });
  assert.equal(parse.data.boardCount, 3);
  assert.deepEqual(parse.data.summary, { scene: 1, dialogue: 1, action: 1 });
  const before = (await api('GET', p)).data.project.boards.length;
  const imp = await api('POST', `${p}/script`, { text: 'S#1. 집\n\n민지: 안녕.\n\n준호가 웃는다.', granularity: 'element' });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.created.length, 3);
  assert.equal(imp.data.project.boards.length, before + 3);
  const empty = await api('POST', `${p}/script`, { text: '' });
  assert.equal(empty.status, 400);
});

test('link preview endpoint (offline)', async () => {
  const r = await api('GET', '/api/link-preview?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'));
  assert.equal(r.status, 200);
  assert.equal(r.data.provider, 'youtube');
  assert.equal(r.data.startSeconds, 42);
  const bad = await api('POST', '/api/link-preview', { url: 'http://127.0.0.1/secret' });
  assert.equal(bad.status, 400);
});

test('ai endpoints: prompt works offline, enhance/video report not configured', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const { project } = (await api('GET', p)).data;
  const b = project.boards[0];
  const r = await api('POST', '/api/ai/prompt', { projectId: PID, uid: b.uid });
  assert.equal(r.status, 200);
  assert.ok(r.data.imagePrompt.length > 20);
  assert.ok(r.data.payloads.higgsfield);
  const inline = await api('POST', '/api/ai/prompt', { board: { action: 'a cat', ext: { shotType: 'CU' } }, project: { aspectRatio: 1, ext: {} } });
  assert.match(inline.data.imagePrompt, /Close-up of a cat/);
  const enh = await api('POST', '/api/ai/enhance', { projectId: PID, uid: b.uid });
  assert.equal(enh.status, 503);
  const vid = await api('POST', '/api/ai/video', { projectId: PID, uid: b.uid });
  assert.ok([400, 503].includes(vid.status));
  const st = await api('GET', '/api/ai/status');
  assert.equal(st.data.video.configured, false);
});

test('exports: csv, markdown, prompts, storyboarder, zip', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}/export`;
  const csvRes = await fetch(`${base}${p}/csv`);
  assert.equal(csvRes.status, 200);
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const csv = { data: csvBytes.toString('utf8').slice(1) };
  assert.ok(csv.data.startsWith('number,shot'));
  assert.match(csv.data, /새 액션/);
  const md = await api('GET', `${p}/markdown`);
  assert.match(md.data, /^# 바뀐 제목/);
  assert.match(md.data, /Video prompt/);
  const pack = await api('GET', `${p}/prompts`);
  assert.equal(pack.data.project.title, '바뀐 제목');
  assert.ok(pack.data.boards[0].payloads.higgsfield);
  const sb = await api('GET', `${p}/storyboarder`);
  const sbData = typeof sb.data === 'string' ? JSON.parse(sb.data) : sb.data;
  assert.equal(sbData.boards.length, pack.data.boards.length);
  assert.match(sb.headers.get('content-disposition') || '', /\.storyboarder/);
  const zip = await api('GET', `${p}/zip`);
  assert.equal(zip.status, 200);
  assert.ok(Buffer.isBuffer(zip.data));
  assert.equal(zip.data.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.data.length > 500);
  const nope = await api('GET', `${p}/docx`);
  assert.equal(nope.status, 404);
});

test('legacy (pre-1.6) project: main image is flagged, then migrated into the fill layer', async () => {
  // Simulate a folder written by Storyboarder 1.x: board.url exists, no layer files.
  const LID = 'legacy-scene';
  const folder = path.join(dir, LID);
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
  const pngBytes = Buffer.from(PNG.split(',')[1], 'base64');
  fs.writeFileSync(path.join(folder, 'images', 'board-1-LEGAC.png'), pngBytes);
  fs.writeFileSync(
    path.join(folder, `${LID}.storyboarder`),
    JSON.stringify({
      version: '1.5.0',
      aspectRatio: 1.7777777777777777,
      fps: 24,
      defaultBoardTiming: 2000,
      boards: [{ uid: 'LEGAC', url: 'board-1-LEGAC.png', newShot: false, lastEdited: 1, layers: {}, number: 1, shot: '1A', time: 0 }],
    }),
  );
  const got = await api('GET', `/api/projects/${LID}`);
  assert.equal(got.status, 200);
  const b = got.data.project.boards[0];
  assert.equal(b._legacyMain, true, 'legacy main image must be flagged for the client');

  // exports point at the legacy file (there is no posterframe yet)
  const pack = await api('GET', `/api/projects/${LID}/export/prompts`);
  assert.equal(pack.data.boards[0].image, 'images/board-1-LEGAC.png');

  // The client loads the legacy image into the fill layer and saves it back.
  const up = await api('POST', `/api/projects/${LID}/boards/LEGAC/image`, { layers: { fill: PNG }, composite: JPG, thumbnail: PNG });
  assert.equal(up.status, 200);
  assert.equal(up.data.board.layers.fill.url, 'board-1-LEGAC-fill.png');
  assert.ok(fs.existsSync(path.join(folder, 'images', 'board-1-LEGAC-fill.png')));
  assert.ok(!fs.existsSync(path.join(folder, 'images', 'board-1-LEGAC.png')), 'old main file removed after migration');
  assert.ok(fs.existsSync(path.join(folder, 'images', 'board-1-LEGAC-posterframe.jpg')));

  const again = await api('GET', `/api/projects/${LID}`);
  assert.equal(again.data.project.boards[0]._legacyMain, undefined);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, `${LID}.storyboarder`), 'utf8'));
  assert.ok(!JSON.stringify(saved).includes('_legacyMain'), 'runtime flags never reach the file');
  const pack2 = await api('GET', `/api/projects/${LID}/export/prompts`);
  assert.equal(pack2.data.boards[0].image, 'images/board-1-LEGAC-posterframe.jpg');
  assert.equal((await api('DELETE', `/api/projects/${LID}`)).status, 200);
});

test('analysis import: preview + import (JSON → boards, whiteboard cards, provenance)', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const analysis = {
    video_id: 'VID1', title: '분석 영상', source: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, metadata: { fps: 30 },
    shots: [
      { shot_id: 'SH001', start_frame: 0, end_frame: 90, description: '도시 전경', camera: { shot_type: 'wide', movement: 'drone' } },
      { shot_id: 'SH002', start_frame: 90, end_frame: 240, visual_description: '인터뷰', camera: { shot_type: 'medium', movement: 'static' }, transcript_ids: ['T1'] },
    ],
    transcript: [{ segment_id: 'T1', start_time: 3.2, end_time: 7, speaker: 'A', text: '안녕하세요' }],
  };
  const pv = await api('POST', '/api/import/analysis/preview', { data: analysis });
  assert.equal(pv.status, 200);
  assert.equal(pv.data.summary.boards, 2);
  assert.equal(pv.data.boards[0].ext.shotType, 'WS');
  const pvText = await api('POST', '/api/import/analysis/preview', { text: JSON.stringify(analysis) });
  assert.equal(pvText.data.summary.format, 'json');
  const bad = await api('POST', '/api/import/analysis/preview', { text: 'not analysis data at all' });
  assert.equal(bad.status, 400);
  const missing = await api('POST', '/api/import/analysis/preview', {});
  assert.equal(missing.status, 400);

  const before = (await api('GET', p)).data.project.boards.length;
  const imp = await api('POST', `${p}/import/analysis`, { data: analysis, addToWhiteboard: true });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.created.length, 2);
  assert.equal(imp.data.project.boards.length, before + 2);
  assert.equal(imp.data.whiteboard.cards, 2);
  const b = imp.data.project.boards.find((x) => x.uid === imp.data.created[1]);
  assert.equal(b.dialogue, 'A: 안녕하세요');
  assert.equal(b.ext.cameraMove, 'static');
  assert.equal(b.ext.source.shotId, 'SH002');
  assert.equal(b.ext.links[0].provider, 'youtube');
  assert.equal(imp.data.project.ext.imports.length, 1);
  assert.equal(imp.data.project.ext.imports[0].videoId, 'VID1');
  const types = imp.data.project.ext.whiteboard.nodes.map((n) => n.type);
  assert.deepEqual(types, ['frame', 'board', 'board', 'embed']);

  const csv = 'Scene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames),Length (timecode),Length (seconds)\n1,1,00:00:00.000,0.000,72,00:00:03.000,3.000,72,00:00:03.000,3.000\n';
  const csvImp = await api('POST', `${p}/import/analysis`, { text: csv });
  assert.equal(csvImp.status, 201);
  assert.equal(csvImp.data.summary.format, 'scenedetect-csv');
  assert.equal(csvImp.data.created.length, 1);
});

test('whiteboard: get / put (normalized, board cards validated) / add boards / survives project PUT', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const g = await api('GET', `${p}/whiteboard`);
  assert.equal(g.status, 200);
  const wb = g.data.whiteboard;
  assert.ok(Array.isArray(wb.nodes) && wb.nodes.length >= 4);
  const nBefore = wb.nodes.length;
  wb.nodes.push({ id: 'nnote01', type: 'note', x: 10, y: 10, text: '메모', color: '#BDE0FE' });
  wb.nodes.push({ id: 'nbad', type: 'board', uid: 'NOPE!', x: 0, y: 0 });
  wb.nodes.push({ id: 'nweird', type: 'hologram', x: 0, y: 0 });
  wb.edges.push({ id: 'e1', from: 'nnote01', to: wb.nodes[0].id, label: '참고' });
  wb.edges.push({ id: 'e2', from: 'nnote01', to: 'nbad' });
  const put = await api('PUT', `${p}/whiteboard`, { whiteboard: wb });
  assert.equal(put.status, 200);
  assert.equal(put.data.whiteboard.nodes.length, nBefore + 1);
  assert.ok(!put.data.whiteboard.nodes.some((n) => n.id === 'nbad' || n.id === 'nweird'));
  assert.equal(put.data.whiteboard.edges.length, 1);
  const invalid = await api('PUT', `${p}/whiteboard`, { whiteboard: { nodes: 'x' } });
  assert.equal(invalid.status, 400);

  // a project PUT with a stale/empty ext.whiteboard must not clobber it
  const proj = (await api('GET', p)).data.project;
  proj.ext.whiteboard = { nodes: [], edges: [] };
  proj.ext.title = '제목 변경';
  const saved = await api('PUT', p, proj);
  assert.equal(saved.data.project.ext.title, '제목 변경');
  assert.equal(saved.data.project.ext.whiteboard.nodes.length, nBefore + 1);

  const add = await api('POST', `${p}/whiteboard/boards`, { title: '전체', cols: 4 });
  assert.equal(add.status, 201);
  assert.equal(add.data.cards.length, proj.boards.length);
  assert.equal(add.data.frame.title, '전체');
  const none = await api('POST', `${p}/whiteboard/boards`, { uids: ['ZZZZZ'] });
  assert.equal(none.status, 400);
});

test('assets: upload (json + raw), list, serve, type guard, delete, zip bundle, from-url guard', async () => {
  const p = `/api/projects/${encodeURIComponent(PID)}`;
  const up = await api('POST', `${p}/assets`, { name: '레퍼런스 사진.png', dataUrl: PNG });
  assert.equal(up.status, 201);
  assert.match(up.data.asset.name, /^[0-9a-f]{10}-.+\.png$/);
  assert.equal(up.data.asset.mime, 'image/png');
  const again = await api('POST', `${p}/assets`, { name: 'same.png', dataUrl: PNG });
  assert.equal(again.data.asset.name.slice(0, 10), up.data.asset.name.slice(0, 10)); // content-addressed prefix
  const raw = await fetch(`${base}${p}/assets?name=clip.webm`, { method: 'POST', headers: { 'content-type': 'video/webm' }, body: Buffer.from('not really a video') });
  assert.equal(raw.status, 201);
  const rawAsset = (await raw.json()).asset;
  assert.ok(rawAsset.name.endsWith('-clip.webm'));
  const exe = await api('POST', `${p}/assets`, { name: 'evil.exe', dataUrl: 'data:application/octet-stream;base64,AAAA' });
  assert.equal(exe.status, 415);
  const noData = await api('POST', `${p}/assets`, { name: 'x.png' });
  assert.equal(noData.status, 400);

  const served = await fetch(base + up.data.asset.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  const list = await api('GET', `${p}/assets`);
  assert.equal(list.data.assets.length, 3);

  // reference the asset from the whiteboard → it is bundled in the zip together with whiteboard.md
  const wb = (await api('GET', `${p}/whiteboard`)).data.whiteboard;
  wb.nodes.push({ type: 'image', x: 0, y: 0, src: up.data.asset.url });
  await api('PUT', `${p}/whiteboard`, { whiteboard: wb });
  const zip = await api('GET', `${p}/export/zip`);
  assert.equal(zip.status, 200);
  const txt = zip.data.toString('latin1');
  assert.ok(txt.includes(`${PID}/whiteboard.md`.normalize('NFC')) || txt.includes('whiteboard.md'));
  assert.ok(txt.includes(`assets/${up.data.asset.name}`));

  const del = await api('DELETE', `${p}/assets/${rawAsset.name}`);
  assert.equal(del.status, 200);
  const traversal = await api('DELETE', `${p}/assets/..%2F..%2Fx`);
  assert.equal(traversal.status, 400);
  assert.equal((await api('GET', `${p}/assets`)).data.assets.length, 2);

  const priv = await api('POST', `${p}/assets/from-url`, { url: 'http://127.0.0.1:1/x.png' });
  assert.equal(priv.status, 400);
  const badUrl = await api('POST', `${p}/assets/from-url`, { url: 'ftp://example.com/x.png' });
  assert.equal(badUrl.status, 400);
});

test('static front-end files are served', async () => {
  for (const f of ['/', '/print.html', '/js/app.js', '/js/surface.js', '/css/app.css']) {
    const res = await fetch(base + f);
    assert.equal(res.status, 200, f);
  }
  const img = await fetch(`${base}/projects/${encodeURIComponent(PID)}/images/does-not-exist.png`);
  assert.equal(img.status, 404);
});

test('delete project', async () => {
  const r = await api('DELETE', `/api/projects/${encodeURIComponent(PID)}`);
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, PID)));
  const list = await api('GET', '/api/projects');
  assert.equal(list.data.length, 0);
});
