'use strict';

/**
 * End-to-end smoke test with Playwright (optional, not part of `npm test`).
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:e2e            # starts its own server on a random port with a temp projects dir
 *
 * Screenshots are written to tests/e2e/output/.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const { createApp } = require('../../server/index');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-e2e-'));
  process.env.LINK_PREVIEW_OFFLINE = process.env.LINK_PREVIEW_OFFLINE || '1';
  const app = createApp({ projectsDir });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('server', base, 'projects', projectsDir);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console.error] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`);
  });

  const step = async (name, fn) => {
    process.stdout.write(`- ${name} ... `);
    await fn();
    console.log('ok');
  };

  // ---- home + create project
  await page.goto(base, { waitUntil: 'networkidle' });
  await step('home renders', async () => {
    assert.ok(await page.isVisible('#new-project-form'));
    await page.screenshot({ path: path.join(OUT, '01-home.png') });
  });
  await step('create project', async () => {
    await page.fill('#new-project-form input[name=name]', 'E2E 테스트');
    await page.click('#new-project-form button[type=submit]');
    await page.waitForSelector('#screen-editor:not([hidden])');
    await page.waitForFunction(() => window.__sbn && window.__sbn.state.project);
    assert.strictEqual(await page.evaluate(() => window.__sbn.state.project.boards.length), 1);
  });

  // ---- drawing
  const drawStroke = async (points, opts = {}) => {
    const box = await page.locator('#board-canvas').boundingBox();
    const [x0, y0] = points[0];
    await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: opts.steps || 8 });
    await page.mouse.up();
  };
  await step('draw with pencil / pen / brush', async () => {
    await page.keyboard.press('2');
    await drawStroke([[0.2, 0.3], [0.4, 0.5], [0.6, 0.3], [0.8, 0.6]]);
    await page.keyboard.press('3');
    await drawStroke([[0.1, 0.8], [0.9, 0.8]]);
    await page.keyboard.press('4');
    await drawStroke([[0.3, 0.2], [0.7, 0.7]]);
    await page.keyboard.press('5');
    await drawStroke([[0.15, 0.15], [0.3, 0.25]]);
    const content = await page.evaluate(() => Object.fromEntries(Object.entries(window.__sbn.surface.layers).map(([k, v]) => [k, v.hasContent])));
    assert.ok(content.pencil && content.ink && content.tone && content.notes, JSON.stringify(content));
  });
  await step('undo / redo', async () => {
    assert.ok(await page.evaluate(() => window.__sbn.editor.canUndo()));
    await page.keyboard.press('Control+z');
    assert.ok(await page.evaluate(() => window.__sbn.editor.canRedo()));
    await page.keyboard.press('Control+Shift+z');
    assert.ok(!(await page.evaluate(() => window.__sbn.editor.canRedo())));
  });
  await step('autosave writes layer files + posterframe + thumbnail', async () => {
    await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved', null, { timeout: 15000 });
    const b = await page.evaluate(() => window.__sbn.state.project.boards[0]);
    const imgDir = path.join(projectsDir, 'E2E-테스트', 'images');
    for (const name of ['pencil', 'ink', 'tone', 'notes']) {
      assert.ok(b.layers[name], `layer ${name} missing in board json`);
      assert.ok(fs.existsSync(path.join(imgDir, b.layers[name].url)), `file ${b.layers[name].url} missing`);
    }
    const poster = path.join(imgDir, b.url.replace('.png', '-posterframe.jpg'));
    assert.ok(fs.existsSync(poster), 'posterframe missing');
    assert.ok(fs.existsSync(path.join(imgDir, b.url.replace('.png', '-thumbnail.png'))), 'thumbnail missing');
    assert.ok(!fs.existsSync(path.join(imgDir, b.url)), 'no file may exist at board.url (Storyboarder 1.6+ migration trigger)');
    const stat = fs.statSync(poster);
    assert.ok(stat.size > 1000, 'posterframe too small');
    // JPEG magic + PNG magic
    assert.equal(fs.readFileSync(poster).readUInt16BE(0), 0xffd8, 'posterframe is not a JPEG');
    assert.equal(fs.readFileSync(path.join(imgDir, b.layers.pencil.url)).readUInt32BE(0), 0x89504e47, 'layer is not a PNG');
    await page.screenshot({ path: path.join(OUT, '02-drawn.png') });
  });

  // ---- metadata + boards
  await step('edit metadata (autosaved)', async () => {
    await page.fill('#f-action', '민지가 옥상 난간에 기대어 도시를 내려다본다');
    await page.fill('#f-dialogue', '민지: 여기서 보면 다 작아 보여.');
    await page.selectOption('#f-shotType', 'MS');
    await page.selectOption('#f-cameraMove', 'dolly-in');
    await page.fill('#f-duration', '3500');
    await page.press('#f-duration', 'Tab');
    await page.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved', null, { timeout: 15000 });
    const json = JSON.parse(fs.readFileSync(path.join(projectsDir, 'E2E-테스트', 'E2E-테스트.storyboarder'), 'utf8'));
    assert.strictEqual(json.boards[0].action, '민지가 옥상 난간에 기대어 도시를 내려다본다');
    assert.strictEqual(json.boards[0].duration, 3500);
    assert.strictEqual(json.boards[0].ext.shotType, 'MS');
    assert.ok(json.boards[0].layers.pencil, 'PUT must not drop layer info');
  });
  await step('new board (N), duplicate (D), navigate', async () => {
    await page.click('#stage');
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__sbn.state.project.boards.length === 2);
    assert.strictEqual(await page.evaluate(() => window.__sbn.state.current), 1);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.__sbn.state.current === 0);
    await page.keyboard.press('d');
    await page.waitForFunction(() => window.__sbn.state.project.boards.length === 3);
    const boards = await page.evaluate(() => window.__sbn.state.project.boards.map((b) => ({ shot: b.shot, layers: Object.keys(b.layers), action: b.action })));
    assert.deepStrictEqual(boards.map((b) => b.shot), ['1A', '2A', '3A']);
    assert.ok(boards[1].layers.includes('pencil'), 'duplicate should copy layers');
    assert.strictEqual(boards[1].action, boards[0].action);
  });
  await step('new shot numbering', async () => {
    await page.check('#f-newShot');
    await page.waitForFunction(() => window.__sbn.state.project.boards[1].shot === '2A');
    const shots = await page.evaluate(() => window.__sbn.state.project.boards.map((b) => b.shot));
    assert.deepStrictEqual(shots, ['1A', '2A', '2B']);
  });

  // ---- script import
  await step('script import modal', async () => {
    await page.click('#btn-import-menu');
    await page.click('#btn-script');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("예시 넣기")');
    await page.waitForSelector('.script-preview .pill');
    await page.screenshot({ path: path.join(OUT, '03-script.png') });
    await page.click('.modal-foot button.primary');
    await page.waitForFunction(() => window.__sbn.state.project.boards.length > 5);
    const n = await page.evaluate(() => window.__sbn.state.project.boards.length);
    assert.ok(n >= 9, `expected >= 9 boards, got ${n}`);
  });

  // ---- links + prompt
  await step('reference link (youtube, offline metadata)', async () => {
    await page.fill('#link-url', 'https://youtu.be/dQw4w9WgXcQ?t=1m30s');
    await page.click('#link-form button');
    await page.waitForSelector('.link-item');
    const link = await page.evaluate(() => window.__sbn.state.project.boards[window.__sbn.state.current].ext.links[0]);
    assert.strictEqual(link.provider, 'youtube');
    assert.strictEqual(link.startSeconds, 90);
    assert.ok(link.thumbnail.includes('dQw4w9WgXcQ'));
  });
  await step('generate prompt (offline builder)', async () => {
    await page.selectOption('#f-shotType', 'CU');
    await page.selectOption('#f-cameraMove', 'pan-left');
    await page.click('#btn-gen-prompt');
    await page.waitForFunction(() => document.getElementById('f-videoPrompt').value.length > 20);
    const v = await page.inputValue('#f-videoPrompt');
    assert.ok(/pan to the left/i.test(v), v);
    await page.screenshot({ path: path.join(OUT, '04-inspector.png') });
  });

  // ---- exports + print + player
  await step('exports respond', async () => {
    for (const f of ['csv', 'markdown', 'prompts', 'storyboarder', 'zip']) {
      const r = await page.request.get(`${base}/api/projects/${encodeURIComponent('E2E-테스트')}/export/${f}`);
      assert.strictEqual(r.status(), 200, f);
      const body = await r.body();
      assert.ok(body.length > 100, `${f} too small`);
    }
    await page.click('#btn-export');
    await page.waitForSelector('.export-list');
    await page.keyboard.press('Escape');
  });
  await step('print sheet renders', async () => {
    const p2 = await context.newPage();
    await p2.goto(`${base}/print.html?project=${encodeURIComponent('E2E-테스트')}`, { waitUntil: 'networkidle' });
    await p2.waitForSelector('.page .cell');
    const cells = await p2.locator('.cell').count();
    assert.ok(cells >= 9, `cells ${cells}`);
    await p2.screenshot({ path: path.join(OUT, '05-print.png'), fullPage: false });
    await p2.close();
  });
  await step('player opens and advances', async () => {
    await page.click('#stage');
    await page.keyboard.press(' ');
    await page.waitForSelector('.player');
    await page.waitForTimeout(1500);
    const tc = await page.textContent('.player-tc');
    assert.ok(tc && tc.includes('/'), tc);
    await page.screenshot({ path: path.join(OUT, '06-player.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.player', { state: 'detached' });
  });
  await step('delete board', async () => {
    const before = await page.evaluate(() => window.__sbn.state.project.boards.length);
    await page.click('#btn-del-board');
    await page.click('.modal-foot button.danger');
    await page.waitForFunction((n) => window.__sbn.state.project.boards.length === n - 1, before);
  });
  // ---- analysis import (shots/transcript JSON) + whiteboard
  await step('analysis import (JSON → boards + whiteboard cards)', async () => {
    const before = await page.evaluate(() => window.__sbn.state.project.boards.length);
    await page.click('#btn-import-menu');
    await page.click('#btn-analysis');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("예시 JSON 넣기")');
    await page.waitForSelector('.import-summary');
    await page.screenshot({ path: path.join(OUT, '08-analysis-import.png') });
    await page.click('.modal-foot button.primary');
    await page.waitForFunction((n) => window.__sbn.state.project.boards.length === n + 5, before);
    const b = await page.evaluate(() => {
      const boards = window.__sbn.state.project.boards;
      const i = boards.findIndex((x) => x.ext.source && x.ext.source.shotId === 'SH002');
      return boards[i];
    });
    assert.strictEqual(b.ext.shotType, 'MS');
    assert.strictEqual(b.ext.cameraMove, 'dolly-in');
    assert.ok(b.dialogue.includes('NARRATOR'));
    assert.strictEqual(b.ext.links.length, 1);
  });
  await step('whiteboard: open, cards present, note + embed + image, edge, save', async () => {
    await page.click('#view-switch [data-view=whiteboard]');
    await page.waitForFunction(() => window.__sbn.state.view === 'whiteboard' && window.__sbn.state.wbLoadedFor);
    await page.waitForTimeout(400);
    const types = await page.evaluate(() => window.__sbn.whiteboard.data.nodes.map((n) => n.type));
    assert.ok(types.filter((t) => t === 'board').length === 5, `expected 5 board cards, got ${types}`);
    assert.ok(types.includes('frame') && types.includes('embed'));
    // look at an empty region, then double-click to create a sticky note and type into it
    await page.evaluate(() => window.__sbn.whiteboard.fitTo([{ x: 5000, y: 5000, w: 1200, h: 800 }]));
    const vp = await page.locator('.wb-viewport').boundingBox();
    await page.mouse.dblclick(vp.x + vp.width / 2, vp.y + vp.height / 2);
    await page.waitForSelector('.wb-node.wb-note.editing');
    await page.keyboard.type('화이트보드 메모');
    await page.mouse.click(vp.x + 80, vp.y + vp.height - 60);
    await page.evaluate(async () => {
      const wb = window.__sbn.whiteboard;
      await wb.addFromUrl('https://youtu.be/dQw4w9WgXcQ?t=42', { x: 0, y: 2000 });
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await wb.addFiles([new File([arr], 'tiny.png', { type: 'image/png' })], { x: 600, y: 2000 });
    });
    await page.waitForFunction(() => window.__sbn.whiteboard.data.nodes.some((n) => n.type === 'note') && window.__sbn.whiteboard.data.nodes.filter((n) => n.type === 'image').length === 1);
    // connect note → embed through the selection toolbar
    await page.evaluate(() => window.__sbn.whiteboard.fitAll());
    await page.click('.wb-node.wb-note');
    await page.click('.wb-seltoolbar button:has-text("연결")');
    await page.click('.wb-node.wb-embed >> nth=0');
    await page.waitForFunction(() => window.__sbn.whiteboard.data.edges.length === 1);
    // board card double-click opens the board editor
    await page.waitForTimeout(1200); // autosave
    await page.screenshot({ path: path.join(OUT, '09-whiteboard.png') });
    const saved = await page.evaluate(async () => {
      const r = await fetch(`/api/projects/${encodeURIComponent(window.__sbn.state.projectId)}/whiteboard`);
      return (await r.json()).whiteboard;
    });
    assert.strictEqual(saved.edges.length, 1);
    assert.ok(saved.nodes.some((n) => n.type === 'note' && n.text === '화이트보드 메모'));
    assert.ok(saved.nodes.some((n) => n.type === 'image' && n.src.includes('/assets/')));
    await page.keyboard.press('Escape'); // clear selection (its toolbar may cover the card)
    await page.evaluate(() => window.__sbn.whiteboard.fitTo(window.__sbn.whiteboard.data.nodes.filter((n) => n.type === 'board')));
    await page.dblclick('.wb-node.wb-board >> nth=0');
    await page.waitForFunction(() => window.__sbn.state.view === 'boards');
  });

  await step('reload keeps everything', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__sbn && window.__sbn.state.project);
    const b = await page.evaluate(() => window.__sbn.state.project.boards[0]);
    assert.strictEqual(b.action, '민지가 옥상 난간에 기대어 도시를 내려다본다');
    const has = await page.evaluate(() => window.__sbn.surface.layers.pencil.hasContent);
    assert.ok(has, 'pencil layer should be reloaded');
    await page.screenshot({ path: path.join(OUT, '07-reloaded.png') });
  });

  await browser.close();
  server.close();
  fs.rmSync(projectsDir, { recursive: true, force: true });

  const real = problems.filter((p) => !/favicon/.test(p));
  if (real.length) {
    console.error('\nProblems:\n' + real.join('\n'));
    process.exit(1);
  }
  console.log('\nE2E OK — screenshots in', OUT);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
