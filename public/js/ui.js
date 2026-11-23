// Modal dialogs, confirm and toast notifications.
import { el } from './util.js';

const root = () => document.getElementById('modal-root');

export function isModalOpen() {
  return root().children.length > 0;
}

/**
 * modal({ title, body: Node|string, actions: [{label, primary, danger, onClick(close)}], size: 'wide'|'full', onClose })
 */
export function modal({ title, body, actions = [], size = '', onClose, closeOnBackdrop = true }) {
  const bodyEl = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);

  const dialog = el('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-head' }, [el('h2', { text: title || '' }), el('button', { class: 'modal-close', title: '닫기 (Esc)', text: '✕', onclick: () => close() })]),
    bodyEl,
  ]);
  if (actions.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const a of actions) {
      const btn = el('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, text: a.label });
      btn.addEventListener('click', async () => {
        if (a.onClick) {
          btn.disabled = true;
          try {
            const result = await a.onClick(close, { dialog, body: bodyEl, button: btn });
            if (result !== false && a.closeAfter !== false) close();
          } finally {
            btn.disabled = false;
          }
        } else close();
      });
      foot.append(btn);
    }
    dialog.append(foot);
  }
  const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);
  if (closeOnBackdrop) backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());

  function close() {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);
  root().append(backdrop);
  const first = dialog.querySelector('input, textarea, select, button.primary');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, dialog, body: bodyEl };
}

export function confirmDialog(message, { title = '확인', okLabel = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: el('p', { text: message }),
      onClose: () => resolve(false),
      actions: [
        { label: '취소' },
        { label: okLabel, primary: !danger, danger, onClick: (close) => { resolve(true); close(); } },
      ],
    });
  });
}

export function promptDialog(message, { title = '입력', value = '', okLabel = '확인', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { value, placeholder });
    let done = false;
    const m = modal({
      title,
      body: el('div', {}, [el('p', { text: message }), input]),
      onClose: () => !done && resolve(null),
      actions: [
        { label: '취소' },
        { label: okLabel, primary: true, onClick: (close) => { done = true; resolve(input.value); close(); } },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        done = true;
        resolve(input.value);
        m.close();
      }
    });
  });
}

export function toast(message, type = '', ms = 2600) {
  const t = el('div', { class: `toast ${type}`, text: message });
  document.getElementById('toast-root').append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 320);
  }, ms);
  return t;
}
