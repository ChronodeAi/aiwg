#!/usr/bin/env node
/** Offline replay only. Capture contents are never executed or followed as paths. */
import { parseArgs } from 'node:util';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { readAiwgConfig } from '../../dist/src/config/aiwg-config.js';
import { analyzeBenchmark, benchmarkComparison, benchmarkDeviationComparison, benchmarkDigest,
  validateBenchmarkCapture, splitBenchmarkHoldout, MAX_BENCHMARK_BYTES, BENCHMARK_PASS_COUNTS } from '../../dist/src/decision/benchmark.js';

async function readJson(path) {
  if (path.split(/[\\/]/).includes('..')) throw new Error('Path traversal is not allowed.');
  const target = await realpath(resolve(path));
  const rel = relative(await realpath(process.cwd()), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Input must be inside the working directory.');
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Input must be a regular file.');
    if (stat.size > MAX_BENCHMARK_BYTES) throw new Error('Input exceeds 4 MiB size limit.');
    const buffer = Buffer.alloc(MAX_BENCHMARK_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BENCHMARK_BYTES) throw new Error('Input exceeds 4 MiB size limit.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { await file.close(); }
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    capture: { type: 'string' }, dataset: { type: 'string' }, holdout: { type: 'string' }, seed: { type: 'string', default: '3291' },
    'pass-counts': { type: 'string' }, thresholds: { type: 'string', default: '0.7,0.8,0.9,0.95' },
    agreement: { type: 'string', default: '0.67' }, 'minimum-accuracy': { type: 'string', default: '1' },
    'maximum-fallback-rate': { type: 'string', default: '0.5' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node tools/decision/benchmark.mjs analyze|replay|plan --capture <file> [--dataset <cases.json>] [--holdout <fraction> --seed <text>] [--pass-counts 1,3,5] [--thresholds 0.7,0.9] [--agreement 0.67] [--minimum-accuracy 1] [--maximum-fallback-rate 0.5] [--json]');
  } else {
    const mode = positionals[0];
    if (positionals.length !== 1 || !['analyze', 'replay', 'plan'].includes(mode) || !values.capture) throw new Error('Require analyze|replay|plan --capture <file>; see --help.');
    const input = await readJson(values.capture);
    let cases = values.dataset ? await readJson(values.dataset) : input.cases;
    let capture = values.dataset ? input : input.capture;
    if (!values.dataset && (!input || Object.keys(input).some(k => !['cases', 'capture'].includes(k)))) throw new Error('Expected {cases, capture} envelope.');
    validateBenchmarkCapture(cases, capture);
    const sourceDigest = capture.datasetDigest;
    if (values.holdout !== undefined) {
      cases = splitBenchmarkHoldout(cases, Number(values.holdout), values.seed);
      capture = { ...capture, datasetDigest: benchmarkDigest(cases) };
    }
    const available = Math.min(...capture.rows.map(r => r.jev.length));
    const counts = values['pass-counts'] ? values['pass-counts'].split(',').map(Number) : [...new Set([...BENCHMARK_PASS_COUNTS.filter(n => n <= available), available])];
    if ([values.thresholds, values.agreement, values['pass-counts']].some(v => v !== undefined && v.split(',').some(n => !n.trim()))) throw new Error('Sweep values must be nonempty numbers.');
    const policies = values.thresholds.split(',').flatMap(t => counts.flatMap(passes => values.agreement.split(',').map(a => ({ passes, threshold: Number(t), agreement: Number(a) }))));
    const config = await readAiwgConfig(process.cwd());
    const rates = config?.decision?.ask?.cost;
    const report = analyzeBenchmark(cases, capture, policies, rates, {
      minimumAccuracy: Number(values['minimum-accuracy']), maximumFallbackRate: Number(values['maximum-fallback-rate']),
    });
    const result = { mode, sourceDigest, holdout: values.holdout ?? 'captured', seed: values.seed, ...report };
    console.log(values.json || mode === 'plan' ? JSON.stringify(result, null, 2)
      : `${benchmarkComparison(capture, rates)}\n\n${benchmarkDeviationComparison(report)}\n\nTuning recommendation: ${JSON.stringify(report.recommended)}\nTuning/holdout results:\n${JSON.stringify(report.measurements, null, 2)}`);
  }
} catch (error) {
  console.error(`Benchmark: ${error.message}`);
  process.exitCode = 2;
}
