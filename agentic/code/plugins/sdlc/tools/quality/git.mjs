/**
 * Minimal git plumbing shared by the code-shape gate modules.
 */

import { spawnSync } from 'node:child_process';

/** Run git; returns stdout or throws with stderr. */
export function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function gitLines(root, args, options) {
  const out = git(root, args, options);
  return out === null ? [] : out.split('\n').filter(Boolean);
}

/** Content of `relPath` at `ref`, or null when absent. */
export function readFileAtRef(root, ref, relPath) {
  return git(root, ['show', `${ref}:${relPath}`], { allowFail: true });
}

export function resolveMergeBase(root, baseRef) {
  const base = git(root, ['merge-base', baseRef, 'HEAD'], { allowFail: true });
  if (!base) throw Object.assign(new Error(`no merge base between ${baseRef} and HEAD`), { exitCode: 2 });
  return base.trim();
}

function unquotePath(raw) {
  const trimmed = raw.trim();
  if (trimmed === '/dev/null') return null;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * Parse `git diff -U0` output into per-file hunks.
 * Returns [{oldPath, newPath, hunks: [{oldStart, oldCount, newStart, newCount, removed: string[], added: [{line, text}]}]}].
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { oldPath: match?.[1] ?? null, newPath: match?.[2] ?? null, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (!hunk && line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length);
    } else if (!hunk && line.startsWith('rename to ')) {
      file.newPath = line.slice('rename to '.length);
    } else if (!hunk && line.startsWith('--- ')) {
      file.oldPath = unquotePath(line.slice(4));
    } else if (!hunk && line.startsWith('+++ ')) {
      file.newPath = unquotePath(line.slice(4));
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        removed: [],
        added: [],
      };
      newLine = hunk.newStart;
      file.hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) {
      hunk.added.push({ line: newLine++, text: line.slice(1) });
    } else if (hunk && line.startsWith('-')) {
      hunk.removed.push(line.slice(1));
    }
  }
  return files;
}

/** Map a base line number to its head line number through `-U0` hunks. */
export function mapLine(hunks, line) {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      if (h.oldStart < line) offset += h.newCount;
      else break;
    } else if (line >= h.oldStart + h.oldCount) {
      offset += h.newCount - h.oldCount;
    } else if (line >= h.oldStart) {
      return h.newStart + Math.min(line - h.oldStart, Math.max(h.newCount - 1, 0));
    } else {
      break;
    }
  }
  return line + offset;
}

/** `git diff -U0 -M <base>...HEAD`, parsed. */
export function diffAgainstBase(root, baseRef, paths = []) {
  const args = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', `${baseRef}...HEAD`];
  if (paths.length) args.push('--', ...paths);
  return parseUnifiedDiff(git(root, args));
}
