// Animatic playback: flips through the boards with their durations.
import { el, boardDuration, msToTimecode, totalDuration, boardHasImage, boardImageName } from './util.js';
import { modal } from './ui.js';

export function openPlayer(project, { imageUrl, startIndex = 0 }) {
  const frames = project.boards.map((b) => ({
    src: boardHasImage(b) ? imageUrl(boardImageName(b), b.lastEdited) : null,
    duration: boardDuration(project, b),
    dialogue: b.dialogue,
    action: b.action,
    shot: b.shot,
    time: b.time,
  }));
  const total = totalDuration(project);

  const img = el('img', { alt: '' });
  const caption = el('div', { class: 'player-caption' });
  const action = el('div', { class: 'player-action' });
  const frame = el('div', { class: 'player-frame' }, [img, action, caption]);
  const progress = el('div', { class: 'player-progress' }, [el('i')]);
  const tc = el('div', { class: 'player-tc' });
  const playBtn = el('button', { class: 'btn', text: '일시정지' });
  const bar = el('div', { class: 'player-bar' }, [
    playBtn,
    el('button', { class: 'btn', text: '처음부터', onclick: () => seek(0) }),
    progress,
    tc,
  ]);
  const body = el('div', { class: 'player' }, [frame, bar]);

  let index = Math.min(startIndex, frames.length - 1);
  let playing = true;
  let frameStart = performance.now();
  let elapsedInFrame = 0;
  let raf = 0;
  let closed = false;

  function show(i) {
    index = i;
    const f = frames[i];
    if (f.src) {
      img.src = f.src;
      img.style.visibility = 'visible';
    } else {
      img.removeAttribute('src');
      img.style.visibility = 'hidden';
    }
    caption.textContent = f.dialogue || '';
    action.textContent = `${f.shot}  ${f.action || ''}`.trim();
  }

  function tick(now) {
    if (closed) return;
    if (playing) {
      const f = frames[index];
      elapsedInFrame = now - frameStart;
      if (elapsedInFrame >= f.duration) {
        if (index + 1 >= frames.length) {
          playing = false;
          playBtn.textContent = '다시 재생';
          elapsedInFrame = f.duration;
        } else {
          frameStart = now;
          elapsedInFrame = 0;
          show(index + 1);
        }
      }
    }
    const f = frames[index];
    const pos = f.time + Math.min(elapsedInFrame, f.duration);
    progress.firstChild.style.width = `${(pos / Math.max(1, total)) * 100}%`;
    tc.textContent = `${msToTimecode(pos, project.fps)} / ${msToTimecode(total, project.fps)}`;
    raf = requestAnimationFrame(tick);
  }

  function seek(i) {
    show(i);
    frameStart = performance.now();
    elapsedInFrame = 0;
    if (!playing) toggle();
  }

  function toggle() {
    if (!playing && index === frames.length - 1 && elapsedInFrame >= frames[index].duration) {
      show(0);
      elapsedInFrame = 0;
    }
    playing = !playing;
    playBtn.textContent = playing ? '일시정지' : '재생';
    if (playing) frameStart = performance.now() - elapsedInFrame;
  }

  playBtn.addEventListener('click', toggle);
  progress.addEventListener('click', (e) => {
    const rect = progress.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * total;
    const i = Math.max(0, frames.findIndex((f) => t < f.time + f.duration));
    seek(i === -1 ? frames.length - 1 : i);
  });
  const onKey = (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight') seek(Math.min(frames.length - 1, index + 1));
    else if (e.key === 'ArrowLeft') seek(Math.max(0, index - 1));
  };
  document.addEventListener('keydown', onKey);

  const m = modal({
    title: `재생 — ${project.ext.title || ''}`,
    body,
    size: 'full',
    onClose: () => {
      closed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
    },
  });
  show(index);
  raf = requestAnimationFrame(tick);
  return m;
}
