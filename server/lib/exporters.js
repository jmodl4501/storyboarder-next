'use strict';

/**
 * Export formats that do not need a browser:
 *  - CSV shot list (Excel / Sheets – the format most teams still plan in)
 *  - Markdown "prompt pack" (readable on GitHub, images linked relatively)
 *  - JSON prompt pack (machine readable, one entry per board)
 *  - ZIP bundle (project file + images + the three documents above)
 *
 * PDF / print sheets are rendered by the browser (public/print.html).
 */

const path = require('path');
const fsp = require('fs').promises;
const boards = require('./boards');
const util = require('./util');
const { buildPrompt, SHOT_TYPE_LABELS_KO, CAMERA_MOVE_LABELS_KO } = require('./promptBuilder');
const { createZip } = require('./zip');
const whiteboard = require('./whiteboard');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsForProject(project) {
  const fps = project.fps || 24;
  return project.boards.map((b) => {
    const ext = b.ext || {};
    const built = buildPrompt(b, project);
    return {
      number: b.number,
      shot: b.shot,
      newShot: b.newShot ? 'Y' : '',
      timecode: util.msToTimecode(b.time, fps),
      startMs: b.time,
      durationMs: boards.boardDuration(project, b),
      durationSec: (boards.boardDuration(project, b) / 1000).toFixed(1),
      shotType: ext.shotType || '',
      shotTypeKo: SHOT_TYPE_LABELS_KO[ext.shotType] || '',
      cameraMove: ext.cameraMove || '',
      cameraMoveKo: CAMERA_MOVE_LABELS_KO[ext.cameraMove] || '',
      action: b.action || '',
      dialogue: b.dialogue || '',
      notes: b.notes || '',
      status: ext.status || '',
      tags: (ext.tags || []).join(' '),
      links: (ext.links || []).map((l) => l.url).join(' | '),
      imagePrompt: ext.prompt || built.imagePrompt,
      videoPrompt: ext.videoPrompt || built.videoPrompt,
      negativePrompt: ext.negativePrompt || built.negativePrompt,
      image: `images/${boards.boardImageFilename(b)}`,
      videoUrl: ((ext.aiJobs || []).find((j) => j.videoUrl) || {}).videoUrl || '',
    };
  });
}

function toCSV(project) {
  const rows = rowsForProject(project);
  const headers = [
    'number', 'shot', 'newShot', 'timecode', 'startMs', 'durationMs', 'durationSec', 'shotType', 'shotTypeKo',
    'cameraMove', 'cameraMoveKo', 'action', 'dialogue', 'notes', 'status', 'tags', 'links', 'imagePrompt',
    'videoPrompt', 'negativePrompt', 'image', 'videoUrl',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  return '\uFEFF' + lines.join('\r\n'); // BOM so Excel opens UTF-8 (Korean) correctly
}

function toPromptPack(project, { id, publicBaseUrl } = {}) {
  const base = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(id)}/images/` : null;
  return {
    project: {
      id,
      title: project.ext.title || id,
      aspectRatio: project.aspectRatio,
      fps: project.fps,
      style: project.ext.style,
      totalDurationMs: boards.totalDuration(project),
      exportedAt: new Date().toISOString(),
    },
    boards: project.boards.map((b) => {
      const built = buildPrompt(b, project, { imageUrl: base ? base + boards.boardImageFilename(b) : null });
      const ext = b.ext || {};
      return {
        uid: b.uid,
        number: b.number,
        shot: b.shot,
        newShot: b.newShot,
        timecode: util.msToTimecode(b.time, project.fps),
        durationMs: boards.boardDuration(project, b),
        image: `images/${boards.boardImageFilename(b)}`,
        imageUrl: base ? base + boards.boardImageFilename(b) : null,
        shotType: ext.shotType || '',
        cameraMove: ext.cameraMove || '',
        action: b.action,
        dialogue: b.dialogue,
        notes: b.notes,
        links: ext.links || [],
        imagePrompt: ext.prompt || built.imagePrompt,
        videoPrompt: ext.videoPrompt || built.videoPrompt,
        negativePrompt: ext.negativePrompt || built.negativePrompt,
        payloads: {
          ...built.payloads,
          higgsfield: { ...built.payloads.higgsfield, prompt: (ext.videoPrompt || built.videoPrompt).slice(0, 2500) },
        },
        status: ext.status,
        aiJobs: ext.aiJobs || [],
      };
    }),
  };
}

function toMarkdown(project, { id } = {}) {
  const pack = toPromptPack(project, { id });
  const out = [];
  out.push(`# ${pack.project.title}`);
  out.push('');
  out.push(`- 보드 수: ${project.boards.length}`);
  out.push(`- 총 길이: ${util.msToTimecode(pack.project.totalDurationMs, project.fps)} (${(pack.project.totalDurationMs / 1000).toFixed(1)}s)`);
  out.push(`- 화면비: ${pack.project.aspectRatio.toFixed(3)} · ${project.fps}fps`);
  if (pack.project.style) out.push(`- 스타일: ${pack.project.style}`);
  out.push(`- 내보낸 시각: ${pack.project.exportedAt}`);
  out.push('');
  for (const b of pack.boards) {
    out.push(`## ${b.shot} — 보드 ${b.number}${b.newShot ? ' (새 샷)' : ''}`);
    out.push('');
    out.push(`![${b.shot}](${b.image})`);
    out.push('');
    out.push(`| 항목 | 내용 |`);
    out.push(`|---|---|`);
    out.push(`| 타임코드 | ${b.timecode} (${(b.durationMs / 1000).toFixed(1)}s) |`);
    if (b.shotType) out.push(`| 샷 | ${b.shotType} ${SHOT_TYPE_LABELS_KO[b.shotType] ? `(${SHOT_TYPE_LABELS_KO[b.shotType]})` : ''} |`);
    if (b.cameraMove) out.push(`| 카메라 | ${b.cameraMove} ${CAMERA_MOVE_LABELS_KO[b.cameraMove] ? `(${CAMERA_MOVE_LABELS_KO[b.cameraMove]})` : ''} |`);
    if (b.action) out.push(`| 액션 | ${md(b.action)} |`);
    if (b.dialogue) out.push(`| 대사 | ${md(b.dialogue)} |`);
    if (b.notes) out.push(`| 노트 | ${md(b.notes)} |`);
    if (b.status) out.push(`| 상태 | ${b.status} |`);
    out.push('');
    if (b.links.length) {
      out.push('**레퍼런스**');
      out.push('');
      for (const l of b.links) {
        out.push(`- [${l.title || l.url}](${l.url})${l.startSeconds ? ` (${fmtSec(l.startSeconds)}~)` : ''}${l.note ? ` — ${l.note}` : ''}`);
      }
      out.push('');
    }
    out.push('**Image prompt**');
    out.push('');
    out.push('```text');
    out.push(b.imagePrompt);
    out.push('```');
    out.push('');
    out.push('**Video prompt (image-to-video, first frame = 위 이미지)**');
    out.push('');
    out.push('```text');
    out.push(b.videoPrompt);
    out.push('```');
    out.push('');
    out.push(`Negative: \`${b.negativePrompt}\``);
    out.push('');
    const done = b.aiJobs.filter((j) => j.videoUrl);
    if (done.length) {
      out.push('**생성된 영상**');
      for (const j of done) out.push(`- ${j.provider}/${j.endpoint}: ${j.videoUrl}`);
      out.push('');
    }
  }
  return out.join('\n');
}

function md(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}
function fmtSec(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function buildZipBundle(project, { id, imagesDir, assetsDir, fileName }) {
  const entries = [];
  entries.push({ name: `${id}/${fileName || id + '.storyboarder'}`, data: boards.toFileJson(project) });
  entries.push({ name: `${id}/shotlist.csv`, data: toCSV(project) });
  entries.push({ name: `${id}/prompts.md`, data: toMarkdown(project, { id }) });
  entries.push({ name: `${id}/prompts.json`, data: JSON.stringify(toPromptPack(project, { id }), null, 2) });
  const wb = project.ext && project.ext.whiteboard ? whiteboard.normalizeWhiteboard(project.ext.whiteboard) : null;
  if (wb && wb.nodes.length) {
    const boardsByUid = Object.fromEntries(project.boards.map((b) => [b.uid, b]));
    entries.push({ name: `${id}/whiteboard.md`, data: whiteboard.toMarkdown(wb, { title: (project.ext && project.ext.title) || id, boardsByUid }) });
    if (assetsDir) {
      for (const f of whiteboard.referencedAssets(wb, id)) {
        try {
          const data = await fsp.readFile(path.join(assetsDir, f));
          entries.push({ name: `${id}/assets/${f}`, data });
        } catch {
          /* asset was deleted */
        }
      }
    }
  }
  const seen = new Set();
  for (const b of project.boards) {
    for (const f of boards.referencedFiles(b)) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        const data = await fsp.readFile(path.join(imagesDir, f));
        entries.push({ name: `${id}/images/${f}`, data });
      } catch {
        /* file may not exist yet (empty board) */
      }
    }
  }
  return createZip(entries);
}

module.exports = { toCSV, toMarkdown, toPromptPack, buildZipBundle, rowsForProject };
