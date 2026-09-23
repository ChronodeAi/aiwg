/**
 * History routing: churn hotspots and co-change pairs over first-parent units (one squashed or
 * merged change per unit). Prioritisation only — not defect prediction.
 */

import path from 'node:path';
import { matchesAny } from './config.mjs';
import { git } from './git.mjs';

export const HISTORY_HEADER = 'prioritisation only — not defect prediction';

/** Parse `git log --first-parent --name-only --format=%x1e%H%x00%an%x00%ct%x00%s` output into units. */
export function parseHistoryLog(text) {
  const units = [];
  for (const chunk of text.split('\x1e')) {
    const lines = chunk.split('\n');
    const header = lines.shift();
    if (!header) continue;
    const [sha, author, time, subject] = header.split('\x00');
    units.push({ sha, author, time: Number(time), subject, files: lines.map((l) => l.trim()).filter(Boolean) });
  }
  return units;
}

function moduleNameOf(file) {
  return file.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
}

/** Whether `from` statically imports `to`; null when the language is not understood. */
export function hasImportEdge(fromFile, fromText, toFile) {
  if (fromText === null || fromText === undefined) return null;
  if (fromFile.endsWith('.py') && toFile.endsWith('.py')) {
    const parts = moduleNameOf(toFile).split('.');
    // Source roots map to package names (`src/reactor/x.py` imported as `pkg.reactor.x`),
    // so compare module-path tails: a single-segment tail must match exactly, a longer
    // tail may follow any package prefix.
    const tails = parts.map((_, i) => parts.slice(i));
    const targets = (mod) => tails.some((tail) => {
      const joined = tail.join('.');
      return mod === joined || (tail.length >= 2 && mod.endsWith(`.${joined}`));
    });
    const fromPackage = moduleNameOf(fromFile).split('.').slice(0, -1);
    const absolute = (mod) => {
      const dots = /^\.*/.exec(mod)[0].length;
      if (dots === 0) return mod;
      const base = fromPackage.slice(0, Math.max(0, fromPackage.length - (dots - 1)));
      return [...base, mod.slice(dots)].filter(Boolean).join('.');
    };
    return fromText.split('\n').some((line) => {
      const m = /^\s*(?:from\s+([\w.]+)\s+import\s+([\w, ()*]+)|import\s+([\w.]+))/.exec(line);
      if (!m) return false;
      const mod = absolute(m[1] ?? m[3]);
      if (targets(mod)) return true;
      if (m[2]) return m[2].split(/[,\s()]+/).some((name) => name && targets(`${mod}.${name}`));
      return false;
    });
  }
  const jsLike = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  if (jsLike.test(fromFile) && jsLike.test(toFile)) {
    const dir = path.posix.dirname(fromFile);
    const target = toFile.replace(jsLike, '');
    for (const m of fromText.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const resolved = path.posix.normalize(path.posix.join(dir, m[1])).replace(jsLike, '');
      if (resolved === target || resolved === target.replace(/\/index$/, '')) return true;
    }
    return false;
  }
  return null;
}

/**
 * Pure analysis over units. readFile(path) → text|null for import-edge lookups; keep(path)
 * selects the files reported (units are still sized and counted on every path they touched).
 */
export function analyseHistory(allUnits, settings, readFile = () => null, keep = () => true) {
  const units = allUnits.filter((u) => u.files.length > 0 && u.files.length <= settings.max_files_per_commit);
  if (units.length < settings.min_commits) {
    return { insufficient: true, units: units.length };
  }
  const touches = new Map();
  const authors = new Map();
  const co = new Map();
  for (const unit of units) {
    const files = [...new Set(unit.files.filter(keep))].sort();
    for (const file of files) {
      touches.set(file, (touches.get(file) || 0) + 1);
      if (!authors.has(file)) authors.set(file, new Set());
      authors.get(file).add(unit.author);
    }
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\u0000${files[j]}`;
        co.set(key, (co.get(key) || 0) + 1);
      }
    }
  }
  const hotspots = [...touches.entries()]
    .map(([file, n]) => ({ file, churn: n / units.length, units: n, authors: authors.get(file).size }))
    .sort((a, b) => b.units - a.units || a.file.localeCompare(b.file))
    .slice(0, 20);
  const pairs = [];
  for (const [key, count] of co) {
    if (count < settings.min_cochange) continue;
    const [a, b] = key.split('\u0000');
    const confidence = Math.max(count / touches.get(a), count / touches.get(b));
    if (confidence < settings.min_confidence) continue;
    const ab = hasImportEdge(a, readFile(a), b);
    const ba = hasImportEdge(b, readFile(b), a);
    const importEdge = ab === true || ba === true ? 'yes' : ab === null && ba === null ? 'unknown' : 'no';
    pairs.push({ a, b, cochange: count, confidence: Number(confidence.toFixed(2)), importEdge });
  }
  pairs.sort((x, y) => y.cochange - x.cochange || y.confidence - x.confidence);
  return { insufficient: false, units: units.length, hotspots, pairs };
}

export function runHistory(root, cfg, { readFile } = {}) {
  const settings = cfg.history;
  const log = git(root, [
    '-c', 'core.quotePath=false', 'log', '--first-parent', '--diff-merges=first-parent', '-n', String(settings.window_commits),
    '--name-only', '--format=%x1e%H%x00%an%x00%ct%x00%s',
  ], { allowFail: true }) ?? '';
  const result = analyseHistory(
    parseHistoryLog(log),
    settings,
    readFile ?? ((file) => git(root, ['show', `HEAD:${file}`], { allowFail: true })),
    (file) => !matchesAny(file, cfg.exclude),
  );
  const lines = [HISTORY_HEADER];
  if (result.insufficient) {
    lines.push(`insufficient history (<${settings.min_commits} commits): ${result.units} usable units`);
    return { ...result, lines };
  }
  lines.push(`units: ${result.units} first-parent changes (≤ ${settings.max_files_per_commit} files each)`);
  lines.push('hotspots (relative churn):');
  for (const h of result.hotspots) lines.push(`  ${h.churn.toFixed(3)}  units=${h.units}  authors=${h.authors}  ${h.file}`);
  lines.push('co-change pairs:');
  for (const p of result.pairs) {
    lines.push(`  ${p.cochange}x conf=${p.confidence} import-edge: ${p.importEdge}  ${p.a} <-> ${p.b}`);
  }
  return { ...result, lines };
}
