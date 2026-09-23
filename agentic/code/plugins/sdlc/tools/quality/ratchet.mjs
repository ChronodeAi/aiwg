/**
 * Change-scoped code-shape ratchet: judge only what a change did to the functions it touched,
 * against bands calibrated from the repository's own distribution. Legacy is baselined by
 * the base-ref delta, never by absolute thresholds.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffAgainstBase, gitLines, mapLine, readFileAtRef } from './git.mjs';
import { fileLoc, runLizard } from './lizard.mjs';
import { isMeasured } from './config.mjs';

export const REMEDIATION = 'Reduce or split this function along one named responsibility (see the code-shape rule). '
  + 'Do not edit .aiwg/quality/gate.json: it is evaluated from the base branch, so changing it cannot pass this check.';

const METRICS = [['nloc', 'function_nloc'], ['ccn', 'function_ccn']];

/** A band is calibrated when its p90 is positive; uncalibrated metrics yield no verdicts. */
function bandFor(bands, key) {
  const band = bands?.[key];
  return band && band.p90 > 0 ? band : null;
}

function isAboveBand(fn, bands) {
  return METRICS.some(([metric, key]) => {
    const band = bandFor(bands, key);
    return band !== null && fn[metric] > band.p90;
  });
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
}

function groupByName(functions) {
  const groups = new Map();
  for (const fn of functions) {
    if (!groups.has(fn.name)) groups.set(fn.name, []);
    groups.get(fn.name).push(fn);
  }
  return groups;
}

/**
 * Pair base and head functions across the changed set.
 * entries: [{file, basePath, baseFunctions, headFunctions, hunks}]
 * Returns [{base, head, file}] where base is null for new functions and head is null for removed ones.
 */
export function matchFunctions(entries) {
  const pairs = [];
  const unmatchedBase = new Set();
  const unmatchedHead = [];
  const allBaseByName = new Map();

  for (const entry of entries) {
    for (const fn of entry.baseFunctions) {
      if (!allBaseByName.has(fn.name)) allBaseByName.set(fn.name, []);
      allBaseByName.get(fn.name).push(fn);
    }
    const baseGroups = groupByName(entry.baseFunctions);
    const headGroups = groupByName(entry.headFunctions);
    for (const [name, heads] of headGroups) {
      const bases = baseGroups.get(name) || [];
      const candidates = [];
      for (const head of heads) {
        for (const base of bases) {
          const start = mapLine(entry.hunks || [], base.startLine);
          const end = mapLine(entry.hunks || [], base.endLine);
          candidates.push({ head, base, score: overlap(start, end, head.startLine, head.endLine) });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const usedHeads = new Set();
      const usedBases = new Set();
      for (const { head, base } of candidates) {
        if (usedHeads.has(head) || usedBases.has(base)) continue;
        usedHeads.add(head);
        usedBases.add(base);
        pairs.push({ base, head, file: entry.file });
      }
      for (const head of heads) if (!usedHeads.has(head)) unmatchedHead.push({ head, file: entry.file });
      for (const base of bases) if (!usedBases.has(base)) unmatchedBase.add(base);
    }
    for (const [name, bases] of baseGroups) {
      if (!headGroups.has(name)) bases.forEach((base) => unmatchedBase.add(base));
    }
  }

  // Cross-file moves: an unmatched head function pairs with an unmatched same-name base function
  // elsewhere in the changed set; failing that, with any same-name base function (it is not new).
  for (const { head, file } of unmatchedHead) {
    const sameName = allBaseByName.get(head.name) || [];
    const free = sameName.find((base) => unmatchedBase.has(base));
    if (free) {
      unmatchedBase.delete(free);
      pairs.push({ base: free, head, file });
    } else if (sameName.length) {
      const closest = [...sameName].sort((a, b) => Math.abs(a.ccn - head.ccn) - Math.abs(b.ccn - head.ccn))[0];
      pairs.push({ base: closest, head, file });
    } else {
      pairs.push({ base: null, head, file });
    }
  }
  for (const base of unmatchedBase) pairs.push({ base, head: null, file: base.file });
  return pairs;
}

function fnMetrics(fn) {
  return fn ? { nloc: fn.nloc, ccn: fn.ccn, startLine: fn.startLine } : null;
}

function judgePair({ base, head, file }, bands) {
  if (!head) return [];
  const verdicts = [];
  const where = { file, function: head.name };
  const metrics = { base: fnMetrics(base), head: fnMetrics(head) };
  const nlocBand = bandFor(bands, 'function_nloc');
  const ccnBand = bandFor(bands, 'function_ccn');
  if (!base) {
    if (nlocBand && ccnBand && head.nloc > nlocBand.p90 && head.ccn > ccnBand.p90) {
      verdicts.push({
        level: 'FAIL', code: 'function-worsened', ...where, metrics,
        message: `new function ${head.name} nloc=${head.nloc} > p90 ${nlocBand.p90} and ccn=${head.ccn} > p90 ${ccnBand.p90}. ${REMEDIATION}`,
      });
    }
    return verdicts;
  }
  let level = null;
  const reasons = [];
  for (const [metric, key] of METRICS) {
    const band = bandFor(bands, key);
    if (!band || head[metric] <= base[metric]) continue;
    const change = `${metric} ${base[metric]}→${head[metric]}`;
    if (head[metric] > band.p90) {
      level = 'FAIL';
      reasons.push(`${change} > p90 ${band.p90}`);
    } else if (head[metric] > band.p80) {
      level = level === 'FAIL' ? level : 'WARN';
      reasons.push(`${change} > p80 ${band.p80}`);
    } else if (head[metric] > band.p70) {
      level = level ?? 'NOTE';
      reasons.push(`${change} > p70 ${band.p70}`);
    }
  }
  if (!level) return verdicts;
  const message = `${head.name} worsened: ${reasons.join(', ')}`;
  verdicts.push({
    level, code: 'function-worsened', ...where, metrics,
    message: level === 'FAIL' ? `${message}. ${REMEDIATION}` : message,
  });
  return verdicts;
}

function shapeOf(functions, loc) {
  return {
    loc,
    functions: functions.length,
    sum_ccn: functions.reduce((sum, fn) => sum + fn.ccn, 0),
    max_ccn: functions.reduce((max, fn) => Math.max(max, fn.ccn), 0),
  };
}

/** Parse `File-Growth: <path> — <reason>` trailers from commit messages. */
export function parseGrowthTrailers(messages) {
  const trailers = new Map();
  for (const line of messages.split('\n')) {
    const m = /^\s*File-Growth:\s*(\S+)\s+(?:—|--|-)\s*(.+)$/.exec(line);
    if (m) trailers.set(m[1], m[2].trim());
  }
  return trailers;
}

/**
 * Pure ratchet core.
 * changedSet: [{file, baseLoc, headLoc, baseFunctions, headFunctions}] (loc null when absent)
 * pairs: output of matchFunctions; bands: gate.json bands; growthTrailers: Map(path → reason)
 */
export function evaluateRatchet({ pairs, changedSet, bands, growthTrailers = new Map() }) {
  const verdicts = [];
  for (const pair of pairs) verdicts.push(...judgePair(pair, bands));

  const baseAbove = changedSet.flatMap((e) => e.baseFunctions).filter((fn) => isAboveBand(fn, bands)).length;
  const headAbove = changedSet.flatMap((e) => e.headFunctions).filter((fn) => isAboveBand(fn, bands)).length;
  if (headAbove > baseAbove) {
    verdicts.push({
      level: 'FAIL', code: 'above-band-count-increased', file: null, metrics: { base: baseAbove, head: headAbove },
      message: `functions above the p90 bands across the changed set rose ${baseAbove}→${headAbove}. ${REMEDIATION}`,
    });
  }

  const shape = [];
  const fileBand = bandFor(bands, 'file_loc');
  for (const entry of changedSet) {
    const base = shapeOf(entry.baseFunctions, entry.baseLoc ?? 0);
    const head = shapeOf(entry.headFunctions, entry.headLoc ?? 0);
    shape.push({ file: entry.file, base, head });
    if (entry.headLoc !== null && head.functions - base.functions >= 3 && head.sum_ccn >= base.sum_ccn) {
      verdicts.push({
        level: 'WARN', code: 'split-mirage-candidate', file: entry.file, metrics: { base, head },
        message: `functions ${base.functions}→${head.functions} while sum_ccn ${base.sum_ccn}→${head.sum_ccn} did not fall`,
      });
    }
    if (fileBand && entry.headLoc !== null && head.loc > base.loc && head.loc > fileBand.p90) {
      const reason = growthTrailers.get(entry.file);
      verdicts.push({
        level: 'ADVISORY', code: 'file-growth', file: entry.file, metrics: { base: base.loc, head: head.loc },
        message: reason
          ? `JUSTIFIED loc ${base.loc}→${head.loc} > p90 ${fileBand.p90}: ${reason}`
          : `NEEDS-JUSTIFICATION loc ${base.loc}→${head.loc} > p90 ${fileBand.p90}; add trailer 'File-Growth: ${entry.file} — <responsibility>'`,
      });
    }
  }
  return { verdicts, shape };
}

export function formatShape({ file, base, head }) {
  return `SHAPE ${file} loc ${base.loc}→${head.loc} functions ${base.functions}→${head.functions} `
    + `sum_ccn ${base.sum_ccn}→${head.sum_ccn} max_ccn ${base.max_ccn}→${head.max_ccn}`;
}

/** Changed measured files between base and HEAD: [{status, oldPath, newPath}]. */
export function changedFiles(root, baseRef, cfg) {
  const lines = gitLines(root, [
    '-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '--diff-filter=ACMRD', `${baseRef}...HEAD`,
  ]);
  const changes = [];
  for (const line of lines) {
    const [status, first, second] = line.split('\t');
    const kind = status[0];
    const oldPath = kind === 'A' ? null : first;
    const newPath = kind === 'D' ? null : (second ?? first);
    if (kind === 'C') continue;
    if ((newPath && isMeasured(newPath, cfg)) || (oldPath && isMeasured(oldPath, cfg))) {
      changes.push({ status: kind, oldPath, newPath });
    }
  }
  return changes;
}

function measureAtRef(root, ref, relPaths, tmpDir) {
  const present = [];
  const locs = new Map();
  for (const rel of relPaths) {
    const text = readFileAtRef(root, ref, rel);
    if (text === null) continue;
    const dest = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    locs.set(rel, fileLoc(text));
    present.push(rel);
  }
  const functions = present.length ? runLizard(present, { cwd: tmpDir }) : [];
  return { functions, locs };
}

/** Measure base (merge base) and head (HEAD) versions of the changed set. */
export function buildChangedSet(root, mergeBase, cfg) {
  const changes = changedFiles(root, mergeBase, cfg);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-ratchet-'));
  try {
    const base = measureAtRef(root, mergeBase, changes.map((c) => c.oldPath).filter(Boolean), path.join(tmp, 'base'));
    const head = measureAtRef(root, 'HEAD', changes.map((c) => c.newPath).filter(Boolean), path.join(tmp, 'head'));
    const hunksByPath = new Map();
    for (const file of diffAgainstBase(root, mergeBase)) {
      hunksByPath.set(file.newPath ?? file.oldPath, file.hunks);
    }
    return changes.map((change) => {
      const file = change.newPath ?? change.oldPath;
      const baseFunctions = change.oldPath ? base.functions.filter((fn) => fn.file === change.oldPath) : [];
      const headFunctions = change.newPath ? head.functions.filter((fn) => fn.file === change.newPath) : [];
      baseFunctions.forEach((fn) => { fn.file = file; });
      return {
        file,
        basePath: change.oldPath,
        baseLoc: change.oldPath ? base.locs.get(change.oldPath) ?? null : null,
        headLoc: change.newPath ? head.locs.get(change.newPath) ?? null : null,
        baseFunctions,
        headFunctions,
        hunks: hunksByPath.get(file) || [],
      };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Full ratchet run against a base ref. */
export function runRatchet(root, cfgBase, { mergeBase }) {
  const changedSet = buildChangedSet(root, mergeBase, cfgBase);
  const pairs = matchFunctions(changedSet);
  const messages = gitLines(root, ['log', `${mergeBase}..HEAD`, '--format=%B'], { allowFail: true }).join('\n');
  return evaluateRatchet({ pairs, changedSet, bands: cfgBase.bands, growthTrailers: parseGrowthTrailers(messages) });
}

/** Distribution report (no base): share of NLOC per band and the largest above-p90 functions. */
export function distributionReport(functions, bands) {
  const total = functions.reduce((sum, fn) => sum + fn.nloc, 0) || 1;
  const lines = [];
  for (const [metric, key] of METRICS) {
    const band = bands[key];
    const buckets = { '≤p70': 0, 'p70–p80': 0, 'p80–p90': 0, '>p90': 0 };
    for (const fn of functions) {
      const v = fn[metric];
      const bucket = v > band.p90 ? '>p90' : v > band.p80 ? 'p80–p90' : v > band.p70 ? 'p70–p80' : '≤p70';
      buckets[bucket] += fn.nloc;
    }
    const shares = Object.entries(buckets).map(([k, v]) => `${k} ${((100 * v) / total).toFixed(1)}%`).join('  ');
    lines.push(`${key} (share of NLOC): ${shares}`);
  }
  const above = functions
    .filter((fn) => isAboveBand(fn, bands))
    .sort((a, b) => b.ccn - a.ccn || b.nloc - a.nloc)
    .slice(0, 20);
  lines.push(`above p90 (top ${above.length}):`);
  for (const fn of above) lines.push(`  ${fn.file}:${fn.startLine} ${fn.name} nloc=${fn.nloc} ccn=${fn.ccn}`);
  return { lines, above: above.map((fn) => ({ file: fn.file, function: fn.name, ...fnMetrics(fn) })) };
}
