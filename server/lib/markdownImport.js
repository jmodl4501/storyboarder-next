'use strict';

const timeSeconds = (value) => {
  const m = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const millis = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + millis;
};

const clean = (value) => String(value || '').replace(/\r/g, '').trim();

function looksLikeStoryboardMarkdown(text) {
  const source = String(text || '');
  return /^#\s+.+/m.test(source) && /^###\s+장면\s+\d+\s*[·|]/m.test(source);
}

function firstHeading(text) {
  const match = /^#\s+(.+?)\s*$/m.exec(text);
  return match ? clean(match[1]) : '';
}

function metadata(text) {
  const source = /^-\s*원본:\s*\[[^\]]*]\((?:<)?(.+?)(?:>)?\)\s*$/m.exec(text);
  const fps = /^-\s*분석 소스:.*?,\s*([\d.]+)\s*fps\s*$/mi.exec(text);
  const duration = /^-\s*재생시간:\s*([0-9:.,]+)\s*$/m.exec(text);
  return {
    title: firstHeading(text),
    sourceUrl: source ? clean(source[1]) : '',
    fps: fps ? Number(fps[1]) : null,
    duration: duration ? timeSeconds(duration[1]) : null,
  };
}

function field(block, label) {
  const match = new RegExp(`^-\\s*${label}:\\s*(.+?)\\s*$`, 'm').exec(block);
  return match ? clean(match[1]) : '';
}

function imageReference(block) {
  const match = /!\[[^\]]*]\((?:<)?(.+?)(?:>)?\)/.exec(block);
  return match ? clean(match[1]).replace(/^\.?\//, '') : '';
}

function quoteAfter(block, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\*\\*|\\n\\s*</details>|$)`).exec(block);
  if (!match) return '';
  return match[1].split('\n').filter((line) => /^>\s?/.test(line)).map((line) => line.replace(/^>\s?/, '').trim()).filter(Boolean).join(' ').trim();
}

function fallbackQuote(block) {
  return block.split('\n').filter((line) => /^>\s?/.test(line)).map((line) => line.replace(/^>\s?/, '').trim()).filter(Boolean).join(' ').trim();
}

function dialogue(block) {
  const korean = quoteAfter(block, '한국어 번역') || quoteAfter(block, '한국어');
  const english = quoteAfter(block, 'English · 자동 자막') || quoteAfter(block, 'English');
  if (korean && english) return `한국어: ${korean}\nEnglish: ${english}`;
  return korean || english || fallbackQuote(block);
}

function parseSceneBlocks(text, warnings) {
  const header = /^###\s+장면\s+(\d+)\s*·\s*([0-9:.,]+)\s*[–—-]\s*([0-9:.,]+)(?:\s*\([^)]*초\))?(?:\s*·\s*(.*?))?\s*$/gm;
  const matches = [...text.matchAll(header)];
  return matches.map((match, i) => {
    const block = text.slice(match.index + match[0].length, i + 1 < matches.length ? matches[i + 1].index : text.length);
    const sceneNumber = Number(match[1]);
    const start = timeSeconds(match[2]);
    const end = timeSeconds(match[3]);
    const topic = clean(match[4] || '').replace(/\s*\([^)]*초\)\s*$/, '');
    const screen = field(block, '화면');
    const analysis = field(block, '분석');
    const image = imageReference(block);
    if (start == null || end == null) warnings.push(`scene ${sceneNumber}: invalid time range`);
    if (!image) warnings.push(`scene ${sceneNumber}: representative image not found`);
    return {
      id: `S${String(sceneNumber).padStart(4, '0')}`,
      startTime: start,
      endTime: end,
      description: screen || analysis || topic || `장면 ${sceneNumber}`,
      visual: screen || analysis || topic || `장면 ${sceneNumber}`,
      transcriptText: dialogue(block),
      notes: analysis,
      tags: [...new Set(['markdown-import', topic].filter(Boolean))],
      thumbnail: image,
      topic,
    };
  });
}

function parseStoryboardMarkdown(input) {
  const text = String(input || '').replace(/\r/g, '');
  if (!looksLikeStoryboardMarkdown(text)) throw Object.assign(new Error('storyboard markdown: "### 장면" sections were not found'), { status: 400 });
  const warnings = [];
  const meta = metadata(text);
  const shots = parseSceneBlocks(text, warnings);
  if (!shots.length) throw Object.assign(new Error('storyboard markdown: no scenes found'), { status: 400 });
  return {
    format: 'storyboard-markdown',
    meta: { videoId: '', title: meta.title, fps: meta.fps, width: null, height: null, duration: meta.duration, sourceUrl: meta.sourceUrl, sourcePath: '', hash: '' },
    shots,
    transcript: [],
    warnings,
  };
}

module.exports = { looksLikeStoryboardMarkdown, parseStoryboardMarkdown, timeSeconds };
