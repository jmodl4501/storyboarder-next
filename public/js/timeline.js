// Bottom board strip: thumbnails, selection, drag & drop re-ordering.
import { el, boardDuration, thumbnailName, msToClock, totalDuration, boardHasImage } from './util.js';

export class Timeline {
  constructor(strip, summary, { onSelect, onReorder, onAdd, imageUrl }) {
    this.strip = strip;
    this.summary = summary;
    this.onSelect = onSelect;
    this.onReorder = onReorder;
    this.onAdd = onAdd;
    this.imageUrl = imageUrl;
    this.project = null;
    this.current = 0;
    this.dragUid = null;
  }

  render(project, current) {
    this.project = project;
    this.current = current;
    const strip = this.strip;
    strip.innerHTML = '';
    const vertical = project.aspectRatio < 1;
    project.boards.forEach((board, index) => {
      const card = el('div', {
        class: `tl-card ${index === current ? 'current' : ''} ${board.newShot ? 'new-shot' : ''} ${vertical ? 'vertical' : ''}`,
        draggable: 'true',
        'data-uid': board.uid,
        'data-index': String(index),
        title: [board.shot, board.action, board.dialogue].filter(Boolean).join(' · ').slice(0, 200),
      });
      const thumb = el('div', { class: 'tl-thumb' });
      if (boardHasImage(board)) {
        thumb.append(el('img', { src: this.imageUrl(board._legacyMain && !Object.keys(board.layers).length ? board.url : thumbnailName(board), board.lastEdited), alt: board.shot, draggable: 'false', loading: 'lazy' }));
      }
      const meta = el('div', { class: 'tl-meta' }, [
        el('span', { class: 'tl-shot', text: board.shot }),
        el('span', { class: 'tl-flag', text: (board.ext && board.ext.status && board.ext.status !== 'draft') ? statusGlyph(board.ext.status) : '' }),
        el('span', { class: 'tl-dur', text: `${(boardDuration(project, board) / 1000).toFixed(1)}s` }),
      ]);
      card.append(thumb, meta);
      card.addEventListener('click', () => this.onSelect(index));
      this._dnd(card);
      strip.append(card);
    });
    const add = el('button', { class: 'tl-add', title: '새 보드 (N)', text: '+' });
    add.addEventListener('click', () => this.onAdd());
    strip.append(add);
    this.updateSummary();
    this.scrollToCurrent();
  }

  updateSummary() {
    const p = this.project;
    if (!p) return;
    const shots = new Set(p.boards.map((b) => String(b.shot).replace(/[A-Z]+\d*$/, ''))).size;
    this.summary.textContent = `${p.boards.length} 보드 · ${shots} 샷 · 총 ${msToClock(totalDuration(p))} · ${p.fps}fps`;
  }

  highlight(current) {
    this.current = current;
    this.strip.querySelectorAll('.tl-card').forEach((c) => c.classList.toggle('current', Number(c.dataset.index) === current));
    this.scrollToCurrent();
  }

  /** Scroll the strip only (scrollIntoView would also shift overflow:hidden ancestors). */
  scrollToCurrent() {
    const card = this.strip.querySelector('.tl-card.current');
    if (!card) return;
    const strip = this.strip;
    const left = card.offsetLeft - 20;
    const right = card.offsetLeft + card.offsetWidth + 20;
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior: 'smooth' });
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior: 'smooth' });
  }

  /** Refresh a single card after an image save or text edit. */
  updateCard(board) {
    const card = this.strip.querySelector(`.tl-card[data-uid="${board.uid}"]`);
    if (!card) return;
    const thumb = card.querySelector('.tl-thumb');
    if (boardHasImage(board)) {
      let img = thumb.querySelector('img');
      if (!img) {
        img = el('img', { alt: board.shot, draggable: 'false' });
        thumb.append(img);
      }
      img.src = this.imageUrl(thumbnailName(board), board.lastEdited);
    } else thumb.innerHTML = '';
    card.querySelector('.tl-shot').textContent = board.shot;
    card.querySelector('.tl-dur').textContent = `${(boardDuration(this.project, board) / 1000).toFixed(1)}s`;
    card.querySelector('.tl-flag').textContent = board.ext && board.ext.status && board.ext.status !== 'draft' ? statusGlyph(board.ext.status) : '';
    card.classList.toggle('new-shot', !!board.newShot);
    this.updateSummary();
  }

  _dnd(card) {
    card.addEventListener('dragstart', (e) => {
      this.dragUid = card.dataset.uid;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.uid);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this.strip.querySelectorAll('.tl-card').forEach((c) => c.classList.remove('drag-over-before', 'drag-over-after'));
      this.dragUid = null;
    });
    card.addEventListener('dragover', (e) => {
      if (!this.dragUid || this.dragUid === card.dataset.uid) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      card.classList.toggle('drag-over-before', before);
      card.classList.toggle('drag-over-after', !before);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over-before', 'drag-over-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragUid || e.dataTransfer.getData('text/plain');
      const to = card.dataset.uid;
      card.classList.remove('drag-over-before', 'drag-over-after');
      if (!from || from === to) return;
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      const order = this.project.boards.map((b) => b.uid).filter((u) => u !== from);
      const idx = order.indexOf(to);
      order.splice(before ? idx : idx + 1, 0, from);
      this.onReorder(order);
    });
  }
}

function statusGlyph(status) {
  return { ready: '●', generating: '◌', generated: '▶', approved: '✓' }[status] || '';
}
