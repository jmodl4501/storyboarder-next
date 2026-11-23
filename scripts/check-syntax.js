#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency "lint": runs `node --check` on every .js file under
 * server/, public/js, scripts/ and tests/ and fails on the first syntax error.
 * Browser files are checked as plain scripts (they are not ES modules).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const roots = ['server', 'public/js', 'scripts', 'tests'];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'output') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = roots
  .map((r) => path.join(root, r))
  .filter((p) => fs.existsSync(p))
  .flatMap((p) => walk(p, []))
  .sort();

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const rel = path.relative(root, file);
  if (res.status === 0) {
    process.stdout.write(`  ok  ${rel}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL  ${rel}\n${res.stderr}\n`);
  }
}

// Extra sanity: every <script src> in the HTML files must exist.
for (const html of ['public/index.html', 'public/print.html']) {
  const abs = path.join(root, html);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
    const target = path.join(root, 'public', ref.replace(/^\//, '').split('?')[0]);
    if (!fs.existsSync(target)) {
      failed++;
      process.stdout.write(`FAIL  ${html} references missing file ${ref}\n`);
    }
  }
}

process.stdout.write(`\n${files.length} files checked, ${failed} problem(s)\n`);
process.exit(failed ? 1 : 0);
