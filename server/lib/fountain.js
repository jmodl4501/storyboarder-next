'use strict';

/**
 * Lightweight script parser.
 *
 * Understands the parts of Fountain (https://fountain.io) that matter for
 * boarding (scene headings, action, character/dialogue, parentheticals,
 * transitions, sections, synopses) plus the informal conventions commonly used
 * in Korean scripts and planning documents:
 *
 *   S#1. 거실 (낮)          -> scene heading
 *   씬 3 / 장면 3 / #3      -> scene heading
 *   민지: 오늘 뭐 먹을까?    -> dialogue
 *   민지                     -> character line followed by dialogue lines
 *     오늘 뭐 먹을까?
 *
 * The output is a flat list of elements which `elementsToBoards` turns into
 * board records (without uid / url – the caller assigns those).
 */

const { estimateDurationMs } = require('./util');

const SCENE_RE = /^(?:(?:INT|EXT|EST|I\/E|INT\.?\/EXT|EXT\.?\/INT)[.\s]|\.(?=[^.\s]))/i;
const KO_SCENE_RE = /^(?:S\s*#?\s*\d+|씬\s*#?\s*\d+|장면\s*\d+|#\s*\d+|\d+\s*[.)]\s*(?:INT|EXT|실내|실외))/i;
const TRANSITION_RE = /^(?:[A-Z][A-Z\s]*TO:|FADE (?:IN|OUT)[:.]?|CUT TO BLACK[:.]?|SMASH CUT[:.]?|>[^<]*$)$/;
const KO_TRANSITION_RE = /^(?:컷\s*투|컷\s*투\s*블랙|페이드\s*(?:인|아웃)|디졸브|F\.?\s*I\.?|F\.?\s*O\.?|CUT|DISSOLVE)\s*[:.]?$/i;
const CHARACTER_RE = /^(?:@.+|[A-Z0-9][A-Z0-9 .'\-]*(?:\s*\([^)]*\))?\s*\^?)$/;
const KO_DIALOGUE_LINE_RE = /^([^\s:：()（）][^:：]{0,20}?)(\s*[(（][^)）]*[)）])?\s*[:：]\s*(.+)$/;
const KO_CHARACTER_ONLY_RE = /^([^\s:：][^:：]{0,20}?)(\s*[(（][^)）]*[)）])?\s*[:：]?$/;
const TITLE_KEY_RE = /^(title|credit|author|authors|source|draft date|date|contact|notes|copyright|제목|작가|각본|연출|날짜)\s*:\s*(.*)$/i;

function cleanText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '') // boneyard
    .replace(/\[\[[\s\S]*?\]\]/g, ''); // notes
}

function splitBlocks(lines) {
  const blocks = [];
  let cur = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line.trim());
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

function parseTitlePage(blocks) {
  const meta = {};
  if (!blocks.length) return { meta, rest: blocks };
  const first = blocks[0];
  if (!TITLE_KEY_RE.test(first[0])) return { meta, rest: blocks };
  let key = null;
  for (const line of first) {
    const m = TITLE_KEY_RE.exec(line);
    if (m) {
      key = m[1].toLowerCase();
      meta[key] = m[2].trim();
    } else if (key) {
      meta[key] = (meta[key] ? meta[key] + ' ' : '') + line.trim();
    }
  }
  return { meta, rest: blocks.slice(1) };
}

function isCharacterLine(line) {
  if (line.startsWith('@')) return true;
  if (!/[A-Z]/.test(line)) return false;
  if (/[a-z]/.test(line.replace(/\([^)]*\)/g, ''))) return false;
  return CHARACTER_RE.test(line);
}

function parseDialogueBlock(character, lines) {
  const parentheticals = [];
  const dialogue = [];
  for (const line of lines) {
    if (/^[(（].*[)）]$/.test(line)) parentheticals.push(line.replace(/^[(（]|[)）]$/g, ''));
    else dialogue.push(line);
  }
  return {
    type: 'dialogue',
    character: character.replace(/^@/, '').replace(/\^$/, '').trim(),
    parenthetical: parentheticals.join(', '),
    text: dialogue.join(' ').trim(),
  };
}

function classifyBlock(block) {
  const first = block[0];
  const rest = block.slice(1);
  const out = [];

  if (/^={3,}$/.test(first)) return out; // page break
  if (first.startsWith('=')) return [{ type: 'synopsis', text: first.replace(/^=+\s*/, '') }];
  if (/^#\s*\d+/.test(first) || KO_SCENE_RE.test(first) || SCENE_RE.test(first)) {
    out.push({ type: 'scene', text: first.replace(/^\.(?=[^.])/, '').trim() });
    if (rest.length) out.push(...classifyBlock(rest));
    return out;
  }
  if (first.startsWith('#')) return [{ type: 'section', text: first.replace(/^#+\s*/, '') }];
  if (first.startsWith('!')) return [{ type: 'action', text: block.join(' ').replace(/^!/, '').trim() }];
  if (/^>.*<$/.test(first) && block.length === 1) return [{ type: 'action', text: first.slice(1, -1).trim(), centered: true }];
  if (block.length === 1 && (TRANSITION_RE.test(first) || KO_TRANSITION_RE.test(first))) {
    return [{ type: 'transition', text: first.replace(/^>\s*/, '').trim() }];
  }
  if (block.length >= 2 && isCharacterLine(first)) {
    return [parseDialogueBlock(first, rest)];
  }
  // Korean / informal "NAME: line" dialogue, one or more lines
  const koLines = block.map((l) => KO_DIALOGUE_LINE_RE.exec(l));
  if (koLines.every(Boolean) && koLines.length) {
    return koLines.map((m) => {
      let text = m[3].trim();
      const parens = [m[2] ? m[2].trim().replace(/^[(（]|[)）]$/g, '') : ''];
      const lead = /^[(（]([^)）]*)[)）]\s*(.*)$/.exec(text); // "준호: (하품하며) 아무거나."
      if (lead && lead[2]) {
        parens.push(lead[1]);
        text = lead[2].trim();
      }
      return { type: 'dialogue', character: m[1].trim(), parenthetical: parens.filter(Boolean).join(', '), text };
    });
  }
  // "NAME:" or "NAME" (short, no punctuation) followed by lines -> dialogue
  // Character names on their own line have no spaces (민지 / 김부장 / MARY) – anything
  // longer or with spaces is treated as plain action to avoid false positives.
  const nameOnly = KO_CHARACTER_ONLY_RE.exec(first);
  if (block.length >= 2 && nameOnly && !/\s/.test(nameOnly[1]) && nameOnly[1].length <= 10 && !/[.!?。,]$/.test(first)) {
    const m = nameOnly;
    const el = parseDialogueBlock(m[1], rest);
    if (m[2]) el.parenthetical = [m[2].replace(/^\s*[(（]|[)）]$/g, ''), el.parenthetical].filter(Boolean).join(', ');
    return [el];
  }
  return [{ type: 'action', text: block.join(' ').trim() }];
}

/** @returns {{meta: object, elements: Array}} */
function parseScript(text) {
  const lines = cleanText(text).split('\n');
  const blocks = splitBlocks(lines);
  const { meta, rest } = parseTitlePage(blocks);
  const elements = [];
  for (const block of rest) elements.push(...classifyBlock(block));
  return { meta, elements };
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?。！？])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {Array} elements  from parseScript
 * @param {object} opts     { granularity: 'element'|'scene'|'sentence', defaultBoardTiming }
 * @returns {Array} board-like records: { newShot, action, dialogue, notes, duration, ext }
 */
function elementsToBoards(elements, opts = {}) {
  const granularity = opts.granularity || 'element';
  const boards = [];
  let pendingNotes = [];
  let sceneBoard = null;

  const push = (b) => {
    if (pendingNotes.length) {
      b.notes = [pendingNotes.join('\n'), b.notes].filter(Boolean).join('\n');
      pendingNotes = [];
    }
    boards.push(b);
    return b;
  };
  const base = (over) => ({
    newShot: false,
    action: '',
    dialogue: '',
    notes: '',
    duration: null,
    ext: { shotType: '', cameraMove: '' },
    ...over,
  });

  for (const el of elements) {
    switch (el.type) {
      case 'section':
      case 'synopsis':
        pendingNotes.push(el.text);
        break;
      case 'transition':
        if (boards.length) boards[boards.length - 1].notes = [boards[boards.length - 1].notes, `→ ${el.text}`].filter(Boolean).join('\n');
        else pendingNotes.push(el.text);
        break;
      case 'scene': {
        const b = push(base({ newShot: true, action: el.text, ext: { shotType: 'WS', cameraMove: 'static' } }));
        b.duration = opts.defaultBoardTiming || null;
        sceneBoard = granularity === 'scene' ? b : null;
        break;
      }
      case 'action': {
        if (granularity === 'scene') {
          if (!sceneBoard) sceneBoard = push(base({ newShot: true }));
          sceneBoard.action = [sceneBoard.action, el.text].filter(Boolean).join('\n');
          sceneBoard.duration = (sceneBoard.duration || 0) + (estimateDurationMs(el.text, 'action') || 0);
        } else {
          const parts = granularity === 'sentence' ? splitSentences(el.text) : [el.text];
          for (const part of parts) {
            push(base({ action: part, duration: estimateDurationMs(part, 'action') }));
          }
        }
        break;
      }
      case 'dialogue': {
        const line = `${el.character}: ${el.text}`.trim();
        if (granularity === 'scene') {
          if (!sceneBoard) sceneBoard = push(base({ newShot: true }));
          sceneBoard.dialogue = [sceneBoard.dialogue, line].filter(Boolean).join('\n');
          sceneBoard.duration = (sceneBoard.duration || 0) + (estimateDurationMs(el.text, 'dialogue') || 0);
        } else {
          push(
            base({
              dialogue: line,
              action: el.parenthetical ? `(${el.parenthetical})` : '',
              duration: estimateDurationMs(el.text, 'dialogue'),
              ext: { shotType: 'MCU', cameraMove: 'static' },
            }),
          );
        }
        break;
      }
      default:
        break;
    }
  }
  if (pendingNotes.length) {
    if (boards.length) boards[boards.length - 1].notes = [boards[boards.length - 1].notes, pendingNotes.join('\n')].filter(Boolean).join('\n');
    else push(base({ notes: pendingNotes.join('\n') }));
  }
  for (const b of boards) {
    if (b.duration != null) b.duration = Math.max(500, Math.round(b.duration / 100) * 100);
    else delete b.duration;
  }
  return boards;
}

function scriptToBoards(text, opts = {}) {
  const { meta, elements } = parseScript(text);
  return { meta, elements, boards: elementsToBoards(elements, opts) };
}

function summarize(elements) {
  const counts = {};
  for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
  return counts;
}

module.exports = { parseScript, elementsToBoards, scriptToBoards, splitSentences, summarize };
