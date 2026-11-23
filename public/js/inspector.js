// Right-hand panel: board metadata, reference links and AI prompt fields.
import { el, msToTimecode, fmtSeconds, escapeHtml } from './util.js';

const $ = (id) => document.getElementById(id);

export class Inspector {
  /**
   * handlers: { onChange(patch), onAddLink(url), onRemoveLink(i), onLinkNote(i, note),
   *             onGenPrompt(), onEnhance(), onCopyPrompt(), onCopyPayload(), onVideo(), onPollJob(jobId) }
   */
  constructor(meta, handlers) {
    this.meta = meta;
    this.h = handlers;
    this.board = null;
    this.project = null;
    this.fields = {
      newShot: $('f-newShot'), duration: $('f-duration'), status: $('f-status'), shotType: $('f-shotType'), cameraMove: $('f-cameraMove'),
      action: $('f-action'), dialogue: $('f-dialogue'), notes: $('f-notes'), tags: $('f-tags'),
      prompt: $('f-prompt'), videoPrompt: $('f-videoPrompt'), negativePrompt: $('f-negativePrompt'),
    };
    this._fillSelects();
    this._bind();
  }

  _fillSelects() {
    const f = this.fields;
    f.shotType.append(el('option', { value: '', text: '— 샷 타입' }));
    for (const s of this.meta.shotTypes) f.shotType.append(el('option', { value: s, text: `${s} · ${this.meta.shotTypeLabelsKo[s] || ''}` }));
    f.cameraMove.append(el('option', { value: '', text: '— 카메라' }));
    for (const c of this.meta.cameraMoves) f.cameraMove.append(el('option', { value: c, text: `${this.meta.cameraMoveLabelsKo[c] || c} (${c})` }));
    const statusKo = { draft: '초안', ready: '준비됨', generating: '생성 중', generated: '생성됨', approved: '승인' };
    for (const s of this.meta.boardStatus) f.status.append(el('option', { value: s, text: statusKo[s] || s }));
  }

  _bind() {
    const f = this.fields;
    const ext = (key) => (e) => this.h.onChange({ ext: { [key]: e.target.value } });
    f.newShot.addEventListener('change', (e) => this.h.onChange({ newShot: e.target.checked }));
    f.duration.addEventListener('change', (e) => {
      const v = e.target.value === '' ? null : Math.max(100, Math.round(Number(e.target.value)));
      this.h.onChange({ duration: v });
    });
    f.action.addEventListener('input', (e) => this.h.onChange({ action: e.target.value }));
    f.dialogue.addEventListener('input', (e) => this.h.onChange({ dialogue: e.target.value }));
    f.notes.addEventListener('input', (e) => this.h.onChange({ notes: e.target.value }));
    f.tags.addEventListener('change', (e) => this.h.onChange({ ext: { tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) } }));
    f.status.addEventListener('change', ext('status'));
    f.shotType.addEventListener('change', ext('shotType'));
    f.cameraMove.addEventListener('change', ext('cameraMove'));
    f.prompt.addEventListener('input', ext('prompt'));
    f.videoPrompt.addEventListener('input', ext('videoPrompt'));
    f.negativePrompt.addEventListener('input', ext('negativePrompt'));

    $('link-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('link-url');
      const url = input.value.trim();
      if (!url) return;
      this.h.onAddLink(url).then((ok) => ok && (input.value = ''));
    });
    $('btn-gen-prompt').addEventListener('click', () => this.h.onGenPrompt());
    $('btn-enhance-prompt').addEventListener('click', () => this.h.onEnhance());
    $('btn-copy-prompt').addEventListener('click', () => this.h.onCopyPrompt());
    $('btn-copy-payload').addEventListener('click', () => this.h.onCopyPayload());
    $('btn-video-gen').addEventListener('click', () => this.h.onVideo());
  }

  render(board, project) {
    this.board = board;
    this.project = project;
    const f = this.fields;
    const ext = board.ext || {};
    $('insp-shot').textContent = board.shot;
    $('insp-tc').textContent = `${msToTimecode(board.time, project.fps)} · 보드 ${board.number}/${project.boards.length}`;
    setIf(f.newShot, 'checked', !!board.newShot);
    setIf(f.duration, 'value', board.duration != null ? board.duration : '');
    f.duration.placeholder = `기본 ${project.defaultBoardTiming}`;
    setIf(f.status, 'value', ext.status || 'draft');
    setIf(f.shotType, 'value', ext.shotType || '');
    setIf(f.cameraMove, 'value', ext.cameraMove || '');
    setIf(f.action, 'value', board.action || '');
    setIf(f.dialogue, 'value', board.dialogue || '');
    setIf(f.notes, 'value', board.notes || '');
    setIf(f.tags, 'value', (ext.tags || []).join(', '));
    setIf(f.prompt, 'value', ext.prompt || '');
    setIf(f.videoPrompt, 'value', ext.videoPrompt || '');
    setIf(f.negativePrompt, 'value', ext.negativePrompt || '');
    this.renderLinks();
    this.renderJobs();
  }

  renderLinks() {
    const list = $('link-list');
    list.innerHTML = '';
    const links = (this.board.ext && this.board.ext.links) || [];
    if (!links.length) {
      list.append(el('p', { class: 'hint', text: '참고 영상/이미지 링크를 추가하세요. 썸네일과 제목만 저장됩니다.' }));
      return;
    }
    links.forEach((l, i) => {
      const thumb = el('a', { class: 'lthumb', href: l.url, target: '_blank', rel: 'noopener' });
      if (l.thumbnail) thumb.append(el('img', { src: l.thumbnail, alt: '', referrerpolicy: 'no-referrer' }));
      else thumb.textContent = (l.provider || 'link').toUpperCase();
      const meta = [l.provider, l.author, l.startSeconds ? `${fmtSeconds(l.startSeconds)}~` : '', l.duration ? fmtSeconds(l.duration) : ''].filter(Boolean).join(' · ');
      const note = el('input', { value: l.note || '', placeholder: '왜 참고하는지 한 줄 메모' });
      note.addEventListener('change', () => this.h.onLinkNote(i, note.value));
      const body = el('div', {}, [
        el('a', { class: 'ltitle', href: l.url, target: '_blank', rel: 'noopener', html: escapeHtml(l.title || l.url) }),
        el('div', { class: 'lmeta', text: meta }),
        note,
      ]);
      const remove = el('button', { class: 'lremove', title: '삭제', text: '✕' });
      remove.addEventListener('click', () => this.h.onRemoveLink(i));
      list.append(el('div', { class: 'link-item' }, [thumb, body, remove]));
    });
  }

  renderJobs() {
    const box = $('ai-jobs');
    box.innerHTML = '';
    const jobs = (this.board.ext && this.board.ext.aiJobs) || [];
    for (const j of jobs) {
      const row = el('div', { class: 'ai-job' }, [
        el('span', { class: 'muted', text: `${j.provider}/${j.endpoint}` }),
        el('span', { class: `status ${j.status}`, text: j.status }),
      ]);
      if (j.videoUrl) row.append(el('a', { href: j.videoUrl, target: '_blank', rel: 'noopener', text: '영상 열기 ↗' }));
      else if (j.statusUrl) {
        const b = el('button', { class: 'btn small', text: '상태 확인' });
        b.addEventListener('click', () => this.h.onPollJob(j.id));
        row.append(b);
      }
      if (j.error) row.append(el('span', { class: 'status failed', text: j.error.slice(0, 120) }));
      box.append(row);
    }
  }

  setAiHint(ai) {
    const hint = $('ai-status-hint');
    const parts = [];
    parts.push(ai.text.configured ? `텍스트 AI: ${ai.text.model}` : '텍스트 AI 미설정 (.env 의 AI_TEXT_* 참고)');
    parts.push(ai.video.configured ? `영상: Higgsfield ${ai.video.endpoint}` : '영상 생성 미설정 (HF_API_KEY_ID / HF_API_KEY_SECRET)');
    if (ai.video.configured && !ai.publicBaseUrl) parts.push('PUBLIC_BASE_URL 이 없어 image_url 을 만들 수 없습니다 — docs/AI_INTEGRATION.md');
    hint.textContent = parts.join(' · ');
    $('btn-enhance-prompt').disabled = !ai.text.configured;
    $('btn-video-gen').disabled = !ai.video.configured;
  }
}

/** Do not clobber a field the user is currently typing in. */
function setIf(node, prop, value) {
  if (document.activeElement === node) return;
  if (node[prop] !== value) node[prop] = value;
}
