// "영상 → 장면 스토리보드" (v0.3): URL or local file → browser-side scene
// detection → one board per scene, either with the captured key frame on the
// reference layer, a stick-figure / outline sketch on the drawing layers, or both.
//
// The server never decodes video: it only fetches the file (direct URL, or
// yt-dlp when installed) and serves it same-origin so <video> + canvas can read
// the pixels.  Scene descriptions are rule-based unless a vision model is
// configured, in which case the key frames are captioned in batches of 10.

import { api } from './api.js';
import { BoardSurface, loadImage } from './surface.js';
import { SceneAnalyzer, describeHeuristic, attachTranscript, guessCameraMove } from './sceneDetect.js';
import { renderStickFigureBoard, renderBackground, outlineSketch, heuristicLayout } from './sketch.js';
import { modal, toast } from './ui.js';
import { el, msToClock } from './util.js';

const fmtT = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;
};
const fmtMb = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(bytes > 1048576 * 10 ? 0 : 1)} MB`);

const AI_BATCH = 10;
const AI_IMAGE_WIDTH = 512;
const KEEP_VIDEO_AUTO_MB = 200;

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('read failed'));
  r.readAsDataURL(blob);
});

function downscaleDataUrl(img, width, quality = 0.7) {
  const w = Math.min(width, img.naturalWidth || img.width);
  const h = Math.round(w * ((img.naturalHeight || img.height) / (img.naturalWidth || img.width)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/**
 * ctx: { state, currentBoard, adoptProject, flushAll, ensureWhiteboardLoaded, whiteboard, surfaceSize: () => ({width,height}) }
 */
export async function openVideoImport(ctx) {
  const { state } = ctx;
  let caps = { ytdlp: { available: false }, ffmpeg: { available: false }, maxMb: 1024, vision: { configured: false } };
  try {
    caps = await api.videoCapabilities();
  } catch {
    /* offline capabilities are fine */
  }
  const visionOk = !!(caps.vision && caps.vision.configured);

  /* ------------------------------------------------------------ state */
  const src = { kind: null, url: '', file: null, objectUrl: '', job: null, info: null, transcript: [], title: '', fileName: '' };
  let analyzer = null;
  let scan = null; // result of SceneAnalyzer.run()
  let busy = false;
  let createBtn = null; // the modal's footer primary button (assigned after the modal is built)

  /* --------------------------------------------------------- source UI */
  const urlInput = el('input', { type: 'url', placeholder: 'https://www.youtube.com/watch?v=… 또는 https://…/clip.mp4', spellcheck: 'false' });
  const fetchBtn = el('button', { class: 'btn small primary', text: '불러오기' });
  const fileInput = el('input', { type: 'file', accept: 'video/*,.mp4,.webm,.mov,.m4v,.mkv', hidden: true });
  const fileBtn = el('button', { class: 'btn small', text: '파일 선택…' });
  const drop = el('div', { class: 'import-drop' }, [el('span', { text: '영상 파일(mp4 · webm · mov)을 여기에 드롭 — 서버로 보내지 않고 브라우저에서 바로 분석합니다' }), fileBtn, fileInput]);
  const srcStatus = el('div', { class: 'vi-status' });
  const video = el('video', { class: 'vi-video', muted: true, playsinline: true, controls: true, preload: 'metadata' });
  video.muted = true;
  const capsLine = el('p', { class: 'hint' }, [
    `서버: ${caps.ytdlp.available ? `yt-dlp ${caps.ytdlp.version || ''} 사용 가능 → YouTube · Vimeo 등 URL 지원` : 'yt-dlp 없음 → 직접 영상 파일 URL(mp4/webm)만 지원, YouTube는 파일을 내려받아 드롭하세요'}`,
    ` · 최대 ${caps.maxMb} MB`,
    visionOk ? ` · 비전 모델 ${caps.vision.visionModel || caps.vision.model || ''} 사용 가능` : ' · 비전 모델 미설정(규칙 기반 설명)',
  ]);

  const setStatus = (text, cls = '') => {
    srcStatus.textContent = text;
    srcStatus.className = `vi-status ${cls}`;
  };
  video.addEventListener('loadedmetadata', () => {
    if (src.kind !== 'file' || !src.file) return;
    setStatus(`파일: ${src.file.name} · ${fmtMb(src.file.size)} · ${video.videoWidth}×${video.videoHeight} · ${msToClock(video.duration * 1000)}`, 'ok');
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const code = video.error && video.error.code;
    setStatus(code === 4 ? '이 브라우저가 재생할 수 없는 형식입니다 (코덱 미지원). mp4(H.264) 또는 webm으로 변환해 주세요.' : `영상을 열 수 없습니다 (code ${code || '?'})`, 'error');
  });

  const useLocalFile = (f) => {
    if (!f) return;
    if (!/^video\//.test(f.type) && !/\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(f.name)) {
      toast('영상 파일이 아닙니다', 'error');
      return;
    }
    resetScan();
    if (src.objectUrl) URL.revokeObjectURL(src.objectUrl);
    src.kind = 'file';
    src.file = f;
    src.objectUrl = URL.createObjectURL(f);
    src.url = '';
    src.job = null;
    src.info = null;
    src.transcript = [];
    src.fileName = f.name;
    src.title = f.name.replace(/\.[^.]+$/, '');
    video.src = src.objectUrl;
    setStatus(`파일: ${f.name} · ${fmtMb(f.size)} — 메타데이터 읽는 중…`);
    keepVideo.checked = f.size <= KEEP_VIDEO_AUTO_MB * 1048576;
    keepVideoLabel.textContent = ` 영상 파일을 프로젝트 자산으로 보관 (${fmtMb(f.size)} 업로드${f.size > KEEP_VIDEO_AUTO_MB * 1048576 ? ' · 큰 파일' : ''})`;
    showStep(2);
  };
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => useLocalFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); useLocalFile(e.dataTransfer.files[0]); });

  let pollTimer = 0;
  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = 0;
  };

  const fetchFromUrl = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    resetScan();
    stopPolling();
    fetchBtn.disabled = true;
    setStatus('서버가 영상을 가져오는 중… (yt-dlp 또는 직접 다운로드)');
    try {
      const { job } = await api.fetchVideo(state.projectId, { url, quality: qualitySel.value });
      src.kind = job.kind;
      src.url = url;
      src.file = null;
      src.job = job;
      await pollJob(job.id);
    } catch (err) {
      setStatus(`가져오기 실패: ${err.message}`, 'error');
      fetchBtn.disabled = false;
    }
  };
  const pollJob = async (jobId) => {
    let job;
    try {
      ({ job } = await api.videoJob(jobId));
    } catch (err) {
      setStatus(`작업 조회 실패: ${err.message}`, 'error');
      fetchBtn.disabled = false;
      return;
    }
    src.job = job;
    if (job.status === 'running') {
      const pct = job.progress != null ? ` ${Math.round(job.progress)}%` : '';
      setStatus(`${job.stage === 'download' ? '다운로드' : job.stage === 'info' ? '정보 조회' : job.stage || '진행'} 중${pct}${job.message ? ` · ${job.message}` : ''}`);
      pollTimer = setTimeout(() => pollJob(jobId), 1000);
      return;
    }
    fetchBtn.disabled = false;
    if (job.status === 'error') {
      setStatus(`가져오기 실패: ${job.error || '알 수 없는 오류'}`, 'error');
      return;
    }
    const r = job.result;
    src.info = r.info || null;
    src.transcript = Array.isArray(r.transcript) ? r.transcript : [];
    src.title = (r.info && r.info.title) || r.name.replace(/\.[^.]+$/, '');
    src.fileName = r.name;
    if (src.objectUrl) URL.revokeObjectURL(src.objectUrl);
    src.objectUrl = '';
    video.src = r.url;
    const meta = [src.title, r.info && r.info.uploader, r.info && r.info.duration && msToClock(r.info.duration * 1000), fmtMb(r.size), src.transcript.length ? `자막 ${src.transcript.length}구간` : ''].filter(Boolean);
    setStatus(`준비됨: ${meta.join(' · ')}`, 'ok');
    keepVideo.checked = r.size <= KEEP_VIDEO_AUTO_MB * 1048576;
    keepVideoLabel.textContent = ` 영상 파일을 프로젝트 자산으로 보관 (${fmtMb(r.size)} 복사)`;
    showStep(2);
  };
  fetchBtn.addEventListener('click', fetchFromUrl);
  urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && fetchFromUrl());
  const qualitySel = el('select', { class: 'small', title: '다운로드 화질 (yt-dlp)' }, [
    el('option', { value: '480', text: '480p (빠름)' }),
    el('option', { value: '720', text: '720p', selected: true }),
    el('option', { value: '1080', text: '1080p' }),
  ]);

  /* --------------------------------------------------------- options UI */
  const modeRadios = ['capture', 'sketch', 'both'].map((v) => el('input', { type: 'radio', name: 'vi-mode', value: v }));
  modeRadios[2].checked = true;
  const modeBox = el('div', { class: 'vi-modes' }, [
    el('label', { class: 'vi-mode' }, [modeRadios[0], el('div', {}, [el('b', { text: '캡처 프레임' }), el('small', { text: '장면 대표 프레임을 레퍼런스 레이어에 넣습니다' })])]),
    el('label', { class: 'vi-mode' }, [modeRadios[1], el('div', {}, [el('b', { text: '졸라맨 · 간단한 형체' }), el('small', { text: visionOk ? '비전 모델이 잡아낸 인물 배치를 졸라맨으로, 배경은 윤곽 스케치로 그립니다' : '프레임을 단순화한 윤곽 스케치 (AI가 있으면 졸라맨 배치까지)' })])]),
    el('label', { class: 'vi-mode' }, [modeRadios[2], el('div', {}, [el('b', { text: '둘 다' }), el('small', { text: '연한 캡처 프레임 위에 스케치 — 바로 따라 그리기 좋습니다' })])]),
  ]);
  const modeValue = () => modeRadios.find((r) => r.checked).value;

  const thr = el('input', { type: 'range', min: 14, max: 70, step: 1, value: 30 });
  const thrVal = el('span', { class: 'mono', text: '30' });
  thr.addEventListener('input', () => (thrVal.textContent = thr.value));
  const minLen = el('input', { type: 'number', min: 0.2, max: 10, step: 0.1, value: 0.6, class: 'small' });
  const maxScenes = el('input', { type: 'number', min: 1, max: 500, step: 1, value: 120, class: 'small' });
  const speedSel = el('select', { class: 'small' }, [
    el('option', { value: '4', text: '정밀 (4배속)' }),
    el('option', { value: '8', text: '보통 (8배속)', selected: true }),
    el('option', { value: '16', text: '빠름 (16배속)' }),
  ]);
  const useAi = el('input', { type: 'checkbox', checked: visionOk, disabled: !visionOk });
  const placeholderFig = el('input', { type: 'checkbox' });
  const addWb = el('input', { type: 'checkbox', checked: true });
  const afterCur = el('input', { type: 'checkbox', checked: true });
  const keepVideo = el('input', { type: 'checkbox', checked: true });
  const keepVideoLabel = el('span', { text: ' 영상 파일을 프로젝트 자산으로 보관' });
  const aiCtx = el('input', { placeholder: '(선택) 영상 맥락 — 예: 카페에서 두 친구가 다투는 단편', class: 'wide' });

  const optionsBox = el('div', { class: 'vi-options' }, [
    el('h4', { text: '보드 종류' }),
    modeBox,
    el('h4', { text: '장면 감지' }),
    el('div', { class: 'vi-row' }, [
      el('label', {}, ['컷 감도 ', thr, ' ', thrVal, el('small', { class: 'hint', text: '낮을수록 더 잘게 자릅니다 (기본 30)' })]),
      el('label', {}, ['최소 장면 길이(초) ', minLen]),
      el('label', {}, ['최대 장면 수 ', maxScenes]),
      el('label', {}, ['분석 속도 ', speedSel]),
    ]),
    el('h4', { text: '장면 설명' }),
    el('label', { class: 'check' }, [useAi, el('span', { text: visionOk ? ` 비전 모델로 장면 설명 · 샷 타입 · 졸라맨 배치 생성 (장면 ${AI_BATCH}개씩 요청)` : ' 비전 모델 미설정 — 밝기·색·움직임 기반 규칙 설명만 붙습니다 (.env의 AI_TEXT_* 참고)' })]),
    el('div', { class: 'vi-aictx' }, [aiCtx]),
    el('label', { class: 'check' }, [placeholderFig, el('span', { text: ' AI 배치가 없을 때도 장면마다 자리표시 졸라맨 1명(MS) 그리기' })]),
    el('h4', { text: '넣을 위치' }),
    el('label', { class: 'check' }, [afterCur, el('span', { text: ' 현재 보드 뒤에 삽입 (해제하면 맨 뒤)' })]),
    el('label', { class: 'check' }, [addWb, el('span', { text: ' 화이트보드에도 카드로 추가 (프레임 + 영상 노드)' })]),
    el('label', { class: 'check' }, [keepVideo, keepVideoLabel]),
  ]);
  useAi.addEventListener('change', () => (aiCtx.parentElement.hidden = !useAi.checked));
  aiCtx.parentElement.hidden = !useAi.checked;

  /* ------------------------------------------------------------ scan UI */
  const scanBtn = el('button', { class: 'btn primary', text: '장면 분석 시작' });
  const stopBtn = el('button', { class: 'btn', text: '중지', hidden: true });
  const bar = el('div', { class: 'vi-bar' }, [el('i')]);
  const barText = el('span', { class: 'vi-bartext', text: '' });
  const strip = el('div', { class: 'vi-strip' });
  const resultBox = el('div', { class: 'vi-results', hidden: true });
  const scanBox = el('div', { class: 'vi-scan' }, [el('div', { class: 'btn-row' }, [scanBtn, stopBtn, barText]), bar, strip, resultBox]);

  const setBar = (pct, text) => {
    bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text != null) barText.textContent = text;
  };

  function resetScan() {
    if (analyzer) analyzer.abort();
    analyzer = null;
    scan = null;
    strip.innerHTML = '';
    resultBox.innerHTML = '';
    resultBox.hidden = true;
    setBar(0, '');
    if (createBtn) createBtn.disabled = true;
  }

  async function runScan() {
    if (!video.src) {
      toast('먼저 영상을 불러오거나 파일을 드롭하세요', 'error');
      return;
    }
    resetScan();
    busy = true;
    scanBtn.disabled = true;
    stopBtn.hidden = false;
    video.controls = false;
    const opts = {
      threshold: Number(thr.value),
      minSceneSec: Math.max(0.2, Number(minLen.value) || 0.6),
      maxScenes: Math.max(1, Math.min(500, Number(maxScenes.value) || 120)),
      playbackRate: Number(speedSel.value) || 8,
      captureMaxWidth: Math.max(960, Math.min(1920, ctx.surfaceSize().width)),
    };
    // the blurred modal backdrop makes every presented video frame expensive to composite → plain backdrop while scanning
    const backdrop = video.closest('.modal-backdrop');
    if (backdrop) backdrop.classList.add('scanning');
    analyzer = new SceneAnalyzer(video, opts);
    analyzer.addEventListener('progress', (e) => {
      const d = e.detail;
      setBar(d.percent, `${fmtT(d.t)}${d.duration ? ` / ${fmtT(d.duration)}` : ''} · 장면 ${d.scenes}개`);
    });
    analyzer.addEventListener('scene', (e) => {
      const s = e.detail.scene;
      if (s.thumb) strip.append(el('img', { src: s.thumb, title: `#${s.index + 1} ${fmtT(s.start)}–${fmtT(s.end)}` }));
      strip.scrollLeft = strip.scrollWidth;
    });
    analyzer.addEventListener('error', (e) => toast(e.detail.message, 'error'));
    try {
      const res = await analyzer.run();
      scan = res;
      window.__sbnLastScan = res; // inspected by the e2e test
      attachTranscript(scan.scenes, src.transcript);
      for (const s of scan.scenes) {
        s.include = true;
        const chapter = chapterAt(s.start);
        s.heur = describeHeuristic(s, { chapter, transcriptText: (s.transcript || []).map((t) => t.text).join(' ') });
        s.chapter = chapter;
      }
      setBar(100, `완료 · ${scan.scenes.length}개 장면 · ${scan.samples}프레임 샘플 · ${(scan.elapsedMs / 1000).toFixed(1)}초${res.aborted ? ' (중지됨)' : ''}`);
      renderResults();
    } catch (err) {
      toast(`분석 실패: ${err.message}`, 'error');
      setBar(0, `실패: ${err.message}`);
    } finally {
      busy = false;
      scanBtn.disabled = false;
      stopBtn.hidden = true;
      video.controls = true;
      if (backdrop) backdrop.classList.remove('scanning');
      updateCreateBtn();
      try {
        video.pause();
        video.playbackRate = 1;
      } catch {
        /* ignore */
      }
    }
  }
  scanBtn.addEventListener('click', runScan);
  stopBtn.addEventListener('click', () => analyzer && analyzer.abort());

  function chapterAt(t) {
    const ch = src.info && Array.isArray(src.info.chapters) ? src.info.chapters : [];
    const c = ch.find((x) => t >= (x.start_time || 0) && t < (x.end_time || Infinity));
    return c ? c.title || '' : '';
  }

  function renderResults() {
    resultBox.innerHTML = '';
    resultBox.hidden = false;
    if (!scan.scenes.length) {
      resultBox.append(el('p', { class: 'import-warn', text: '장면을 찾지 못했습니다. 컷 감도를 낮추거나 다른 영상을 시도하세요.' }));
      return;
    }
    const total = scan.scenes.length;
    const head = el('div', { class: 'vi-reshead' }, [
      el('b', { text: `${total}개 장면` }),
      el('span', { class: 'muted', text: ` · 평균 ${(scan.scenes.reduce((a, s) => a + s.duration, 0) / total).toFixed(1)}초 · 포함할 장면을 체크하세요` }),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn small ghost', text: '모두 선택', onclick: () => toggleAll(true) }),
      el('button', { class: 'btn small ghost', text: '모두 해제', onclick: () => toggleAll(false) }),
    ]);
    const grid = el('div', { class: 'vi-grid' });
    for (const s of scan.scenes) {
      const cb = el('input', { type: 'checkbox', checked: s.include });
      cb.addEventListener('change', () => {
        s.include = cb.checked;
        card.classList.toggle('off', !s.include);
        updateCreateBtn();
      });
      const card = el('label', { class: `vi-card ${s.include ? '' : 'off'}` }, [
        el('div', { class: 'vi-thumb' }, [s.thumb ? el('img', { src: s.thumb, alt: '' }) : el('span', { text: '—' }), el('span', { class: 'vi-time', text: `${fmtT(s.start)} · ${s.duration.toFixed(1)}s` })]),
        el('div', { class: 'vi-cardbody' }, [
          el('div', { class: 'vi-cardtop' }, [cb, el('b', { text: `#${s.index + 1}` }), el('span', { class: 'muted', text: [s.heur.cameraMove && camLabel(s.heur.cameraMove), s.transitionIn === 'fade-in' ? '페이드 인' : '', s.chapter].filter(Boolean).join(' · ') })]),
          el('div', { class: 'vi-desc', text: s.heur.action }),
          (s.transcript || []).length ? el('div', { class: 'vi-tr', text: s.transcript.map((t) => t.text).join(' ').slice(0, 140) }) : null,
        ]),
      ]);
      s._card = card;
      s._cb = cb;
      grid.append(card);
    }
    resultBox.append(head, grid);
    updateCreateBtn();
    function toggleAll(on) {
      for (const s of scan.scenes) {
        s.include = on;
        s._cb.checked = on;
        s._card.classList.toggle('off', !on);
      }
      updateCreateBtn();
    }
  }

  function updateCreateBtn() {
    if (!createBtn) return;
    const n = scan ? scan.scenes.filter((s) => s.include).length : 0;
    createBtn.disabled = !n || busy;
    createBtn.textContent = n ? `보드 ${n}개 만들기` : '보드 만들기';
  }

  /* ---------------------------------------------------------- creation */
  const progress = el('div', { class: 'vi-progress', hidden: true });

  async function createBoards(close) {
    const scenes = scan.scenes.filter((s) => s.include);
    if (!scenes.length) return;
    busy = true;
    scanBtn.disabled = true;
    progress.hidden = false;
    const say = (t) => (progress.textContent = t);
    const mode = modeValue();
    const { width, height } = ctx.surfaceSize();
    try {
      // 1) key frames as images
      say('프레임 준비 중…');
      for (const s of scenes) {
        if (s.keyframe && s.keyframe.blob && !s.img) {
          const url = URL.createObjectURL(s.keyframe.blob);
          try {
            s.img = await loadImage(url);
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      }
      // 2) optional vision captions (10 scenes per request)
      let withAi = false;
      if (useAi.checked && visionOk) {
        withAi = true;
        for (let i = 0; i < scenes.length; i += AI_BATCH) {
          const batch = scenes.slice(i, i + AI_BATCH);
          say(`AI 장면 설명 ${Math.min(i + AI_BATCH, scenes.length)}/${scenes.length}…`);
          try {
            const r = await api.describeScenes({
              title: src.title,
              style: state.project.style || (state.project.ext && state.project.ext.style) || '',
              context: aiCtx.value.trim(),
              scenes: batch.map((s) => ({
                index: s.index,
                time: s.start,
                duration: s.duration,
                image: s.img ? downscaleDataUrl(s.img, AI_IMAGE_WIDTH) : undefined,
                transcript: (s.transcript || []).map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join(' ').slice(0, 400),
                hints: { cameraMove: s.heur.cameraMove, brightness: Number(s.metrics.brightness.toFixed(2)), chapter: s.chapter || undefined },
              })),
            });
            for (const d of r.scenes || []) {
              const s = batch.find((x) => x.index === d.index);
              if (s && !d.missing) s.ai = d;
            }
          } catch (err) {
            toast(`AI 설명 실패 (${err.message}) — 규칙 기반 설명으로 대체합니다`, 'error', 4000);
            withAi = false;
            break;
          }
        }
      }
      // 3) upload the file when it should be kept (local files only; server-fetched files are copied server-side)
      let assetUrl = '';
      if (keepVideo.checked && src.kind === 'file' && src.file) {
        say(`영상 업로드 중 (${fmtMb(src.file.size)})…`);
        try {
          const asset = await api.uploadAsset(state.projectId, src.file, src.file.name);
          assetUrl = asset.url;
        } catch (err) {
          toast(`영상 보관 실패: ${err.message} (보드는 계속 만듭니다)`, 'error', 4000);
        }
      }
      // 4) create the boards in one request
      say('보드 생성 중…');
      await ctx.flushAll();
      const payloadScenes = scenes.map((s) => {
        const a = s.ai || null;
        const h = s.heur;
        return {
          index: s.index,
          start: s.start,
          end: s.end,
          action: (a && a.action) || h.action,
          description: (a && a.description) || h.description || '',
          notes: h.notes,
          shotType: (a && a.shotType) || h.shotType || '',
          cameraMove: (a && a.cameraMove) || h.cameraMove || '',
          mood: (a && a.mood) || h.mood || '',
          tags: a && a.tags && a.tags.length ? a.tags : h.tags,
          descriptionBy: a ? 'ai' : 'heuristic',
          transcript: s.transcript || [],
          metrics: pickMetrics(s.metrics),
          cutScore: s.cutScore,
          transitionIn: s.transitionIn || undefined,
          transitionOut: s.transitionOut || undefined,
        };
      });
      const info = src.info || {};
      const r = await api.importScenes(state.projectId, {
        scenes: payloadScenes,
        source: {
          kind: src.kind === 'file' ? 'file' : src.kind,
          url: src.url || undefined,
          videoId: info.id || undefined,
          title: src.title || undefined,
          uploader: info.uploader || undefined,
          fps: info.fps || undefined,
          width: scan.width || info.width || undefined,
          height: scan.height || info.height || undefined,
          duration: scan.duration || info.duration || undefined,
          fileName: src.fileName || undefined,
          asset: assetUrl || undefined,
        },
        afterUid: afterCur.checked && ctx.currentBoard() ? ctx.currentBoard().uid : undefined,
        addToWhiteboard: addWb.checked,
        keepVideo: keepVideo.checked,
        cacheJob: src.job && src.kind !== 'file' ? src.job.id : undefined,
        mode,
        withAi,
      });
      if (addWb.checked) state.wbLoadedFor = null;
      // 5) draw each board offline (no board switching) and upload the layers
      const scratch = new BoardSurface(width, height);
      const uids = r.created;
      let failed = 0;
      for (let i = 0; i < uids.length; i++) {
        const s = scenes[i];
        say(`보드 이미지 ${i + 1}/${uids.length} 저장 중…`);
        const payload = buildBoardImages(scratch, s, mode, { width, height, placeholder: placeholderFig.checked });
        if (!payload) continue;
        try {
          await api.saveBoardImage(state.projectId, uids[i], payload);
        } catch (err) {
          failed++;
          console.error(err);
        }
      }
      const project = await api.getProject(state.projectId);
      await ctx.adoptProject(project.project || project, { selectUid: uids[0] });
      close();
      toast(`${uids.length}개의 보드를 만들었습니다${r.whiteboard ? ` · 화이트보드 카드 ${r.whiteboard.cards}개` : ''}${r.asset ? ' · 영상 보관됨' : ''}${failed ? ` · 이미지 ${failed}개 저장 실패` : ''}`, failed ? 'error' : 'ok', 4000);
      if (state.view === 'whiteboard') {
        await ctx.ensureWhiteboardLoaded();
        ctx.whiteboard.fitAll();
      }
    } catch (err) {
      toast(`보드를 만들지 못했습니다: ${err.message}`, 'error', 5000);
      say(`실패: ${err.message}`);
      busy = false;
      scanBtn.disabled = false;
      updateCreateBtn();
    }
  }

  /* -------------------------------------------------------------- steps */
  const step1 = el('section', { class: 'vi-step' }, [
    el('h3', { text: '1. 영상' }),
    el('div', { class: 'vi-urlrow' }, [urlInput, qualitySel, fetchBtn]),
    drop,
    srcStatus,
    capsLine,
  ]);
  const step2 = el('section', { class: 'vi-step', hidden: true }, [el('h3', { text: '2. 옵션' }), optionsBox]);
  const step3 = el('section', { class: 'vi-step', hidden: true }, [el('h3', { text: '3. 장면 분석' }), scanBox]);
  function showStep(n) {
    step2.hidden = n < 2;
    step3.hidden = n < 2;
  }

  const body = el('div', { class: 'vi-grid2' }, [
    el('div', { class: 'vi-left' }, [video, step1, step2]),
    el('div', { class: 'vi-right' }, [step3, progress]),
  ]);

  const m = modal({
    title: '영상 → 장면별 스토리보드',
    body,
    size: 'full',
    closeOnBackdrop: false,
    onClose: () => {
      stopPolling();
      if (analyzer) analyzer.abort();
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        /* ignore */
      }
      if (src.objectUrl) URL.revokeObjectURL(src.objectUrl);
      if (src.job && src.job.status === 'done' && !keepVideo.checked) api.deleteVideoJob(src.job.id).catch(() => {});
    },
    actions: [
      { label: '닫기' },
      { label: '보드 만들기', primary: true, closeAfter: false, onClick: (close) => createBoards(close).then(() => false) },
    ],
  });
  // the footer's primary button is the live "create" control (label shows the scene count)
  createBtn = m.dialog.querySelector('.modal-foot .btn.primary');
  createBtn.disabled = true;
  setTimeout(() => urlInput.focus(), 50);
  return m;
}

function pickMetrics(m) {
  if (!m) return undefined;
  const o = {};
  for (const k of ['brightness', 'saturation', 'warmth', 'motion', 'panX', 'panY', 'zoom', 'gain', 'lumRange']) if (Number.isFinite(m[k])) o[k] = Number(m[k].toFixed(3));
  if (m.hue) o.hue = m.hue;
  return o;
}

const CAM_LABEL = { static: '고정', 'pan-left': '팬 ←', 'pan-right': '팬 →', 'tilt-up': '틸트 ↑', 'tilt-down': '틸트 ↓', 'zoom-in': '줌 인', 'zoom-out': '줌 아웃', handheld: '핸드헬드' };
const camLabel = (c) => CAM_LABEL[c] || c;

/**
 * Compose the layer images for one scene board.  Returns the saveBoardImage payload.
 * mode: 'capture' | 'sketch' | 'both'
 */
export function buildBoardImages(scratch, s, mode, { width, height, placeholder = false }) {
  scratch.clear();
  const layers = {};
  const layerOpacity = {};
  const img = s.img || null;
  if (!img && mode === 'capture') return null;
  if (img && (mode === 'capture' || mode === 'both')) {
    scratch.placeImage(img, 'reference', { clearFirst: true });
    layers.reference = scratch.exportLayer('reference');
    if (mode === 'both') {
      layerOpacity.reference = 0.35;
      scratch.layers.reference.opacity = 0.35;
    }
  }
  if (mode === 'sketch' || mode === 'both') {
    const ai = s.ai || null;
    const h = s.heur || {};
    const cameraMove = (ai && ai.cameraMove) || h.cameraMove || guessCameraMove(s.metrics) || '';
    const shotType = (ai && ai.shotType) || '';
    let layout;
    if (ai && (ai.figures || ai.shapes)) layout = { figures: ai.figures || [], shapes: ai.shapes || [], horizon: ai.horizon };
    else layout = placeholder ? heuristicLayout(s, { shotType: 'MS', cameraMove }) : { figures: [], shapes: [], horizon: null };
    if (mode === 'sketch') {
      // paper wash + simplified outline of the frame → fill layer
      const bg = renderBackground({ width, height, brightness: s.metrics ? s.metrics.brightness : 0.6, outline: img ? outlineSketch(img, width, height, { strength: 1 }) : null, outlineAlpha: ai ? 0.4 : 0.8 });
      scratch.layers.fill.ctx.drawImage(bg, 0, 0, width, height);
      scratch.layers.fill.hasContent = true;
      layers.fill = scratch.exportLayer('fill');
    } else if (img) {
      // "both": the faded frame sits on the reference layer; trace lines only (no wash) go on the pencil layer
      const lines = outlineSketch(img, width, height, { strength: 1, wash: false });
      scratch.layers.pencil.ctx.globalAlpha = 0.85;
      scratch.layers.pencil.ctx.drawImage(lines, 0, 0, width, height);
      scratch.layers.pencil.ctx.globalAlpha = 1;
    }
    // figures, shapes, camera marks → pencil layer (transparent)
    const fig = renderStickFigureBoard({
      width,
      height,
      layout,
      shotType: shotType || (placeholder && !ai ? 'MS' : ''),
      cameraMove,
      mood: (ai && ai.mood) || h.mood || '',
      caption: `S${String(s.index + 1).padStart(3, '0')} · ${fmtT(s.start)}`,
      seed: s.index + 1,
      transparent: true,
    });
    scratch.layers.pencil.ctx.drawImage(fig, 0, 0, width, height);
    scratch.layers.pencil.hasContent = true;
    layers.pencil = scratch.exportLayer('pencil');
  }
  if (!Object.keys(layers).length) return null;
  return {
    layers,
    clearedLayers: [],
    layerOpacity: Object.keys(layerOpacity).length ? layerOpacity : undefined,
    composite: scratch.exportComposite({ includeNotes: false }),
    thumbnail: scratch.exportThumbnail(320),
    lineMileage: 0,
  };
}
