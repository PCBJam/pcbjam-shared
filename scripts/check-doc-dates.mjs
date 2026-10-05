#!/usr/bin/env node
// docs/**/*.md carry `created` and `updated` (YYYY-MM-DD) in their frontmatter;
// the docs site shows them as each page's version. This check fails when a
// page's text changed against the base branch but `updated` did not, and on
// impossible dates. Pages that are new at their path (added or renamed) only
// get the date sanity checks.
//
//   node scripts/check-doc-dates.mjs [base]     (default base: origin/main)
//
// Without the base ref (a shallow CI clone that didn't fetch it) it warns and
// skips the changed-text rule; it never passes silently on a missing base.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Split frontmatter fields and the body. */
export function parseDoc(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split('\n')) {
    const f = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (f) fields[f[1]] = f[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fields, body: m[2] };
}

/**
 * Problems for one page. `base` is the text at the base ref (null when the
 * page is new there); `today` is YYYY-MM-DD.
 */
export function checkDoc(file, head, base, today) {
  const problems = [];
  const { fields, body } = parseDoc(head);
  for (const key of ['created', 'updated']) {
    if (!fields[key]) problems.push(`${file}: missing \`${key}\``);
    else if (!DATE.test(fields[key]) || Number.isNaN(Date.parse(fields[key])))
      problems.push(`${file}: \`${key}\` is not YYYY-MM-DD (${fields[key]})`);
    else if (fields[key] > today) problems.push(`${file}: \`${key}\` ${fields[key]} is in the future`);
  }
  if (fields.created && fields.updated && fields.updated < fields.created)
    problems.push(`${file}: \`updated\` ${fields.updated} is before \`created\` ${fields.created}`);
  if (base !== null) {
    const before = parseDoc(base);
    if (before.body.trim() !== body.trim() && before.fields.updated === fields.updated)
      problems.push(`${file}: the text changed but \`updated\` is still ${fields.updated}; bump it`);
    if (before.fields.created && before.fields.created !== fields.created)
      problems.push(`${file}: \`created\` changed (${before.fields.created} → ${fields.created}); it never changes`);
  }
  return problems;
}

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? markdownFiles(full) : name.endsWith('.md') || name.endsWith('.mdx') ? [full] : [];
  });
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseRef = process.argv[2] ?? 'origin/main';
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let haveBase = true;
  try {
    git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`);
  } catch {
    haveBase = false;
    console.warn(`check-doc-dates: ${baseRef} is not available; checking dates only, not whether \`updated\` was bumped`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const problems = [];
  for (const full of markdownFiles(path.join(root, 'docs'))) {
    const rel = path.relative(root, full);
    let base = null;
    if (haveBase) {
      try {
        base = git('show', `${baseRef}:${rel}`);
      } catch {
        base = null; // new at this path
      }
    }
    problems.push(...checkDoc(rel, readFileSync(full, 'utf8'), base, today));
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
