// Printable storyboard sheets (use the browser's "Save as PDF").
import { api } from './api.js';
import { el, boardDuration, msToTimecode, totalDuration, escapeHtml, boardHasImage, boardImageName } from './util.js';

const params = new URLSearchParams(location.search);
const id = params.get('project');
const pages = document.getElementById('pages');
let project = null;

async function load() {
  if (!id) {
    pages.innerHTML = '<p class="empty">?project=이름 파라미터가 필요합니다</p>';
    return;
  }
  const res = await api.getProject(id);
  project = res.project;
  document.getElementById('title').textContent = project.ext.title || id;
  document.title = `${project.ext.title || id} — 인쇄`;
  render();
}

function render() {
  const [cols, rows] = document.getElementById('layout').value.split('x').map(Number);
  const showNotes = document.getElementById('show-notes').checked;
  const showPrompt = document.getElementById('show-prompt').checked;
  const portrait = document.getElementById('portrait').checked;
  document.documentElement.style.setProperty('--cols', cols);
  document.documentElement.style.setProperty('--rows', rows);
  document.documentElement.style.setProperty('--ar', String(project.aspectRatio));
  let pageStyle = document.getElementById('page-style');
  if (!pageStyle) {
    pageStyle = el('style', { id: 'page-style' });
    document.head.append(pageStyle);
  }
  pageStyle.textContent = `@page { size: A4 ${portrait ? 'portrait' : 'landscape'}; margin: 0; }`;

  pages.innerHTML = '';
  const perPage = cols * rows;
  const boards = project.boards;
  const pageCount = Math.max(1, Math.ceil(boards.length / perPage));
  const total = totalDuration(project);
  for (let p = 0; p < pageCount; p++) {
    const page = el('div', { class: `page ${portrait ? 'portrait' : ''}` });
    page.append(
      el('div', { class: 'page-head' }, [
        el('h1', { text: project.ext.title || id }),
        el('span', { text: `${boards.length} boards · ${msToTimecode(total, project.fps)} · ${project.fps}fps · ${new Date().toLocaleDateString()}` }),
      ]),
    );
    const grid = el('div', { class: 'grid' });
    for (const b of boards.slice(p * perPage, (p + 1) * perPage)) {
      const frame = el('div', { class: 'frame' });
      if (boardHasImage(b)) frame.append(el('img', { src: api.imageUrl(id, boardImageName(b), b.lastEdited), alt: b.shot }));
      frame.append(el('span', { class: 'label', text: b.shot }));
      if (b.newShot) frame.append(el('span', { class: 'flag', text: 'NEW SHOT' }));
      const ext = b.ext || {};
      const meta = el('div', { class: 'meta' }, [
        el('span', { text: `${msToTimecode(b.time, project.fps)}  ${(boardDuration(project, b) / 1000).toFixed(1)}s` }),
        el('span', { text: [ext.shotType, ext.cameraMove].filter(Boolean).join(' · ') }),
      ]);
      const text = el('div', { class: 'text' });
      if (b.action) text.append(el('p', { class: 'action', text: b.action }));
      if (b.dialogue) text.append(el('p', { class: 'dialogue', text: b.dialogue }));
      if (showNotes && b.notes) text.append(el('p', { class: 'notes', text: b.notes }));
      if (showPrompt && (ext.videoPrompt || ext.prompt)) text.append(el('p', { class: 'notes', html: `<b>prompt</b> ${escapeHtml(ext.videoPrompt || ext.prompt)}` }));
      grid.append(el('div', { class: 'cell' }, [frame, meta, text]));
    }
    page.append(grid, el('div', { class: 'page-foot' }, [el('span', { text: 'Storyboarder Next' }), el('span', { text: `${p + 1} / ${pageCount}` })]));
    pages.append(page);
  }
}

for (const ctl of ['layout', 'show-notes', 'show-prompt', 'portrait']) document.getElementById(ctl).addEventListener('change', render);
document.getElementById('print').addEventListener('click', () => window.print());
load().catch((err) => (pages.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`));
