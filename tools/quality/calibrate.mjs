/**
 * Band calibration: LOC-weighted percentiles of the repository's own distribution
 * (SIG benchmark method), so thresholds describe this codebase rather than folklore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { fileLoc, lizardVersion, runLizard } from './lizard.mjs';
import {
  GATE_CONFIG_PATH, defaultGateConfig, discoverFiles, isGitIgnored, loadGateConfig, writeGateConfig,
} from './config.mjs';

export const MIN_CALIBRATION_FUNCTIONS = 200;
const PERCENTILES = [['p70', 0.7], ['p80', 0.8], ['p90', 0.9]];

/**
 * Weighted percentiles: sort by metric ascending, walk cumulative weight; the band is the
 * metric value at the element where cumulative weight first reaches the target share.
 */
export function weightedPercentiles(items, metric, weight) {
  const sorted = [...items].sort((a, b) => metric(a) - metric(b));
  const total = sorted.reduce((sum, item) => sum + weight(item), 0);
  const band = { p70: 0, p80: 0, p90: 0 };
  if (total <= 0) return band;
  let cumulative = 0;
  let next = 0;
  for (const item of sorted) {
    cumulative += weight(item);
    while (next < PERCENTILES.length && cumulative >= PERCENTILES[next][1] * total) {
      band[PERCENTILES[next][0]] = metric(item);
      next++;
    }
    if (next === PERCENTILES.length) break;
  }
  return band;
}

/** functions: FunctionMetric[]; fileLocs: number[] (physical LOC per measured file). */
export function computeBands(functions, fileLocs) {
  const files = fileLocs.map((loc) => ({ loc }));
  return {
    bands: {
      function_nloc: weightedPercentiles(functions, (f) => f.nloc, (f) => f.nloc),
      function_ccn: weightedPercentiles(functions, (f) => f.ccn, (f) => f.nloc),
      file_loc: weightedPercentiles(files, (f) => f.loc, (f) => f.loc),
    },
    functions: functions.length,
    files: fileLocs.length,
    provisional: functions.length < MIN_CALIBRATION_FUNCTIONS,
  };
}

function formatBand(band) {
  return `p70=${band.p70} p80=${band.p80} p90=${band.p90}`;
}

/** Measure the working tree, print bands; with `write`, persist them into gate.json. */
export function calibrate(root, { write = false } = {}) {
  const existing = loadGateConfig(root);
  const cfg = existing ?? defaultGateConfig();
  const files = discoverFiles(root, cfg);
  const functions = files.length ? runLizard(files, { cwd: root }) : [];
  const lines = [];
  if (functions.length === 0) {
    return { exitCode: 2, lines: ['no functions found under include/exclude; nothing written'] };
  }
  const fileLocs = files.map((file) => fileLoc(fs.readFileSync(path.join(root, file), 'utf8')));
  const result = computeBands(functions, fileLocs);
  lines.push(`calibration: ${result.functions} functions in ${result.files} files (LOC-weighted percentiles)`);
  lines.push(`  function_nloc  ${formatBand(result.bands.function_nloc)}`);
  lines.push(`  function_ccn   ${formatBand(result.bands.function_ccn)}   benchmark: moderate>${cfg.benchmark.function_ccn.moderate} high>${cfg.benchmark.function_ccn.high} very_high>${cfg.benchmark.function_ccn.very_high}`);
  lines.push(`  file_loc       ${formatBand(result.bands.file_loc)}`);
  if (result.provisional) {
    lines.push(`UNDERPOWERED: bands provisional (${result.functions} functions < ${MIN_CALIBRATION_FUNCTIONS})`);
  }
  if (!write) return { exitCode: 0, lines, result };

  if (isGitIgnored(root, GATE_CONFIG_PATH)) {
    return {
      exitCode: 2,
      lines: [...lines, "gate.json is gitignored; add '!.aiwg/quality/' to .gitignore (aiwg-managed block) and retry"],
    };
  }
  const commit = (git(root, ['rev-parse', 'HEAD'], { allowFail: true }) || '').trim();
  cfg.bands = result.bands;
  cfg.calibration = {
    tool: 'lizard',
    tool_version: lizardVersion(),
    date: new Date().toISOString().slice(0, 10),
    commit,
    functions: result.functions,
    files: result.files,
    provisional: result.provisional,
  };
  writeGateConfig(root, cfg);
  lines.push(
    "wrote .aiwg/quality/gate.json — commit it ALONE with trailer 'Evaluator-Change: ADR-NNN' "
    + '(the ADR adopting code-shape gates must already be on the base branch); reviewer other than author.',
  );
  return { exitCode: 0, lines, result };
}
