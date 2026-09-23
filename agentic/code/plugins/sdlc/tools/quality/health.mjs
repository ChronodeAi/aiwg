#!/usr/bin/env node
/**
 * codebase-health CLI: change-scoped code-shape ratchet, import contracts, evaluator
 * meta-check, history routing and band calibration.
 *
 * Exit: 0 pass; 1 when --ci and any FAIL; 2 tool/config error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_MESSAGE, defaultGateConfig, discoverFiles, loadGateConfig } from './config.mjs';
import { calibrate } from './calibrate.mjs';
import { runContracts } from './contracts.mjs';
import { git, resolveMergeBase } from './git.mjs';
import { runHistory } from './history.mjs';
import { runLizard } from './lizard.mjs';
import { runMeta } from './meta.mjs';
import { distributionReport, formatShape, runRatchet } from './ratchet.mjs';

const USAGE = 'usage: health.mjs [--base <ref>] [--architecture] [--meta] [--history] [--calibrate [--write]] '
  + '[--functions <file>] [--format text|json] [--ci]';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

export function parseArgs(argv) {
  const opts = { base: null, architecture: false, meta: false, history: false, calibrate: false, write: false, functions: null, format: 'text', ci: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${arg} requires a value\n${USAGE}`);
      return next;
    };
    switch (arg) {
      case '--base': opts.base = value(); break;
      case '--architecture': opts.architecture = true; break;
      case '--meta': opts.meta = true; break;
      case '--history': opts.history = true; break;
      case '--calibrate': opts.calibrate = true; break;
      case '--write': opts.write = true; break;
      case '--functions': opts.functions = value(); break;
      case '--format': opts.format = value(); break;
      case '--ci': opts.ci = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new UsageError(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  if (!['text', 'json'].includes(opts.format)) throw new UsageError(`--format must be text or json\n${USAGE}`);
  if (opts.write && !opts.calibrate) throw new UsageError(`--write requires --calibrate\n${USAGE}`);
  if (opts.meta && !opts.base) throw new UsageError(`--meta requires --base <ref>\n${USAGE}`);
  return opts;
}

function projectRoot() {
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) throw new UsageError('not inside a git repository');
  return top.trim();
}

function formatVerdict(v) {
  const where = [v.file, v.function].filter(Boolean).join(' ');
  return `${v.level} ${v.code}${where ? ` ${where}` : ''}: ${v.message}`;
}

function summarise(verdicts) {
  const summary = { fail: 0, warn: 0, note: 0, advisory: 0 };
  for (const v of verdicts) {
    const key = v.level.toLowerCase();
    if (key in summary) summary[key]++;
  }
  return summary;
}

function emit(opts, report) {
  const summary = summarise(report.verdicts);
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify({ ...report, summary }, null, 2)}\n`);
  } else {
    const out = [...report.lines];
    for (const e of report.exceptions) out.push(`EXCEPTION evaluator-change ${e.sha} ${e.adr}`);
    for (const s of report.shape) out.push(formatShape(s));
    for (const v of report.verdicts) out.push(formatVerdict(v));
    out.push(`summary: fail=${summary.fail} warn=${summary.warn} note=${summary.note} advisory=${summary.advisory}`);
    process.stdout.write(`${out.join('\n')}\n`);
  }
  return opts.ci && summary.fail > 0 ? 1 : 0;
}

function runFunctions(root, opts) {
  const rel = path.relative(root, path.resolve(process.cwd(), opts.functions));
  if (!fs.existsSync(path.join(root, rel))) throw new UsageError(`file not found: ${opts.functions}`);
  const functions = runLizard([rel], { cwd: root });
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify({ mode: 'functions', file: rel, functions }, null, 2)}\n`);
  } else {
    for (const fn of functions) process.stdout.write(`${fn.startLine}-${fn.endLine}\tnloc=${fn.nloc}\tccn=${fn.ccn}\t${fn.name}\n`);
  }
  return 0;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = projectRoot();
  if (opts.functions) return runFunctions(root, opts);
  if (opts.calibrate) {
    const result = calibrate(root, { write: opts.write });
    if (opts.format === 'json') process.stdout.write(`${JSON.stringify({ mode: 'calibrate', ...result }, null, 2)}\n`);
    else process.stdout.write(`${result.lines.join('\n')}\n`);
    return result.exitCode;
  }

  const report = { mode: [], verdicts: [], shape: [], exceptions: [], lines: [] };
  const cfgHead = loadGateConfig(root);
  let cfg = cfgHead;
  let mergeBase = null;

  if (opts.base) {
    mergeBase = resolveMergeBase(root, opts.base);
    const cfgBase = loadGateConfig(root, { ref: opts.base });
    const cfgHeadCommitted = loadGateConfig(root, { ref: 'HEAD' });
    const anyConfig = Boolean(cfgBase || cfgHeadCommitted || cfgHead);
    const historyOnly = opts.history && !opts.meta && !opts.architecture;
    // Before bootstrap there is no evaluator to judge with: every gated mode is a
    // config error (exit 2), not a list of FAILs against defaults.
    if (!anyConfig && !historyOnly) throw new UsageError(BOOTSTRAP_MESSAGE);
    cfg = cfgBase ?? defaultGateConfig();
    if (anyConfig) {
      if (!cfgBase) report.lines.push(`bootstrap: no gate.json at ${opts.base}; judging with defaults`);
      report.mode.push('ratchet');
      const ratchet = runRatchet(root, cfg, { mergeBase });
      report.verdicts.push(...ratchet.verdicts);
      report.shape.push(...ratchet.shape);
    }
  } else if (!opts.history && !opts.architecture) {
    if (!cfgHead) throw new UsageError(BOOTSTRAP_MESSAGE);
    report.mode.push('distribution');
    const files = discoverFiles(root, cfgHead);
    const distribution = distributionReport(files.length ? runLizard(files, { cwd: root }) : [], cfgHead.bands);
    report.lines.push(...distribution.lines);
    report.verdicts.push(...distribution.verdicts);
  }

  if (opts.architecture) {
    if (!cfg) throw new UsageError(BOOTSTRAP_MESSAGE);
    report.mode.push('architecture');
    const contracts = runContracts(root, cfg, { baseRef: opts.base ? mergeBase : null });
    report.lines.push(...contracts.lines);
    report.verdicts.push(...contracts.verdicts);
  }
  if (opts.meta) {
    report.mode.push('meta');
    const meta = runMeta(root, { baseRef: opts.base, mergeBase });
    report.lines.push(...meta.lines);
    report.verdicts.push(...meta.verdicts);
    report.exceptions.push(...meta.exceptions);
  }
  if (opts.history) {
    report.mode.push('history');
    const history = runHistory(root, cfg ?? defaultGateConfig());
    report.lines.push(...history.lines);
    report.history = { insufficient: history.insufficient, units: history.units, hotspots: history.hotspots ?? [], pairs: history.pairs ?? [] };
  }
  report.mode = report.mode.join('+');
  return emit(opts, report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`codebase-health: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 2;
  }
}
