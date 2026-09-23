#!/usr/bin/env node
// Inventory and research-report rendering plus report lint for the LLM model archivist (#2554).
//
// The inventory is the living record of evaluated models; the report is the
// ranked recommendation. Both carry the fields the archivist agent must fill,
// and the lint enforces the citation-policy rule that benchmark numbers carry
// a source URL and capture date, and the token-security rule that no hub
// credential ever lands in a report.

import { readFileSync } from 'node:fs';

/** Fields every inventory entry must carry (acceptance criteria, #2554). */
export const INVENTORY_REQUIRED_FIELDS = Object.freeze([
  'model_id', 'revision', 'precision', 'parameter_count', 'license',
  'downloads', 'benchmarks', 'archive_path', 'files', 'status',
]);
export const INVENTORY_STATUSES = Object.freeze(['candidate', 'archived', 'flagged-quantized-only', 'rejected']);
export const ORIGINAL_PRECISIONS = Object.freeze(['fp32', 'fp16', 'bf16']);

const BENCHMARK_NAMES = 'MMLU(?:-Pro)?|GSM8K|HumanEval(?:\\+)?|LiveCodeBench|Arena|Chatbot Arena|MATH|GPQA|IFEval|MBPP|HellaSwag|ARC(?:-C)?|TruthfulQA|Winogrande|BBH|MT-Bench|Elo|SWE-bench|AIME';
const BENCHMARK_LINE = new RegExp(`\\b(?:${BENCHMARK_NAMES})\\b`, 'i');
const NUMBER = /(?<![\w./-])\d+(?:\.\d+)?%?(?![\w./-])/;
const URL = /https?:\/\/\S+/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const OVERCLAIM = /\b(?:proves?|conclusively|definitively|undeniably|establishes that)\b/i;
const CREDENTIAL = /\bhf_[A-Za-z0-9]{20,}\b|\bAuthorization:\s*Bearer\s+\S+|\b(?:HF|HUGGINGFACE(?:_HUB)?)_TOKEN\s*=\s*\S+/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate one inventory entry; returns an array of human-readable errors (empty when valid). */
export function validateInventoryEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  for (const field of INVENTORY_REQUIRED_FIELDS) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') errors.push(`missing required field: ${field}`);
  }
  if (errors.length) return errors;
  if (!isNonEmptyString(entry.model_id) || !entry.model_id.includes('/')) errors.push('model_id must be "<org>/<name>"');
  if (!isNonEmptyString(entry.revision)) errors.push('revision must be the hub commit or revision string');
  if (!isNonEmptyString(entry.precision)) errors.push('precision must name the stored precision (fp32, fp16, bf16, or a quantization label)');
  if (!isNonEmptyString(entry.parameter_count)) errors.push('parameter_count must be a string such as "8B"');
  if (!isNonEmptyString(entry.license)) errors.push('license must be an SPDX id or the hub license label');
  if (typeof entry.downloads !== 'object' || !Number.isFinite(entry.downloads.count) || !DATE.test(String(entry.downloads.captured_at ?? ''))) {
    errors.push('downloads must be { count: <number>, captured_at: "YYYY-MM-DD" }');
  }
  if (!Array.isArray(entry.benchmarks)) errors.push('benchmarks must be an array');
  else entry.benchmarks.forEach((benchmark, index) => {
    if (!isNonEmptyString(benchmark?.name)) errors.push(`benchmarks[${index}].name is required`);
    if (!Number.isFinite(benchmark?.score)) errors.push(`benchmarks[${index}].score must be a number`);
    if (!URL.test(String(benchmark?.source_url ?? ''))) errors.push(`benchmarks[${index}].source_url must be an http(s) URL`);
    if (!DATE.test(String(benchmark?.date ?? ''))) errors.push(`benchmarks[${index}].date must be YYYY-MM-DD`);
  });
  if (!isNonEmptyString(entry.archive_path)) errors.push('archive_path must be the archived directory');
  if (!Array.isArray(entry.files)) errors.push('files must be an array of { path, sha256 }');
  else entry.files.forEach((file, index) => {
    if (!isNonEmptyString(file?.path)) errors.push(`files[${index}].path is required`);
    if (!/^[0-9a-f]{64}$/.test(String(file?.sha256 ?? ''))) errors.push(`files[${index}].sha256 must be a 64-hex SHA-256`);
  });
  if (!INVENTORY_STATUSES.includes(entry.status)) errors.push(`status must be one of ${INVENTORY_STATUSES.join(', ')}`);
  const original = ORIGINAL_PRECISIONS.includes(String(entry.precision).toLowerCase());
  if (entry.status === 'archived' && !original && entry.explicitly_requested !== true) {
    errors.push('archived entries must be original precision (fp32/fp16/bf16) unless explicitly_requested is true');
  }
  if (entry.status === 'archived' && entry.files.length === 0) errors.push('archived entries must list at least one file with its SHA-256');
  return errors;
}

export function validateInventory(entries) {
  if (!Array.isArray(entries)) return [{ index: -1, errors: ['inventory must be an array of entries'] }];
  return entries.map((entry, index) => ({ index, model_id: entry?.model_id, errors: validateInventoryEntry(entry) })).filter(item => item.errors.length);
}

function benchmarkCell(benchmarks) {
  if (!benchmarks?.length) return 'none recorded';
  return benchmarks.map(b => `${b.name} ${b.score} ([source](${b.source_url}), ${b.date})`).join('; ');
}

/** Render the living inventory as Markdown: one table row per model plus a per-file SHA-256 block. */
export function renderInventory(entries, { title = 'Open-weight model inventory', generatedAt = new Date().toISOString() } = {}) {
  const rows = entries.map(entry => `| ${entry.model_id} | \`${entry.revision}\` | ${entry.precision} | ${entry.parameter_count} | ${entry.license} | ${entry.downloads.count} (${entry.downloads.captured_at}) | ${benchmarkCell(entry.benchmarks)} | ${entry.status} | \`${entry.archive_path}\` | ${entry.files.length} |`);
  const fileBlocks = entries.filter(entry => entry.files.length).map(entry => [
    `### ${entry.model_id} @ \`${entry.revision}\``,
    '',
    '```',
    ...entry.files.map(file => `${file.sha256}  ./${file.path}`),
    '```',
    '',
  ].join('\n'));
  return [
    `# ${title}`,
    '',
    `Generated: ${generatedAt}`,
    '',
    '| Model | Revision | Precision | Params | License | Downloads (captured) | Benchmarks (source, date) | Status | Archive path | Files |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Per-file SHA-256',
    '',
    ...fileBlocks,
  ].join('\n');
}

/** Render the structured research report with ranked candidates, flagged quantized-only models, and sources. */
export function renderReport(report) {
  const generatedAt = report.generatedAt ?? new Date().toISOString();
  const ranked = (report.candidates ?? []).map((entry, index) => `| ${index + 1} | ${entry.model_id} | ${entry.parameter_count} | ${entry.precision} | ${entry.license} | ${entry.downloads.count} (${entry.downloads.captured_at}) | ${benchmarkCell(entry.benchmarks)} |`);
  const flagged = (report.flagged ?? []).map(entry => `- ${entry.model_id} (${entry.precision}): ${entry.reason ?? 'no original-precision weights published'}`);
  const sources = [...new Set((report.candidates ?? []).concat(report.flagged ?? []).flatMap(entry => (entry.benchmarks ?? []).map(b => b.source_url)).concat(report.sources ?? []))];
  return [
    `# ${report.title ?? 'Open-weight model archival report'}`,
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Criteria',
    '',
    report.criteria ?? 'Not stated.',
    '',
    '## Ranked candidates',
    '',
    '| Rank | Model | Params | Precision | License | Downloads (captured) | Benchmarks (source, date) |',
    '|---|---|---|---|---|---|---|',
    ...ranked,
    '',
    '## Flagged: quantized-only',
    '',
    ...(flagged.length ? flagged : ['None.']),
    '',
    '## Recommendations',
    '',
    ...((report.recommendations ?? []).map(item => `- ${item}`)),
    '',
    '## Evidence quality',
    '',
    report.evidenceNote ?? 'Benchmark figures are as published by their sources on the dates shown; they were not reproduced. Leaderboard and self-reported numbers carry LOW to MODERATE GRADE weight and are hedged accordingly.',
    '',
    '## Sources',
    '',
    ...sources.map((url, index) => `${index + 1}. ${url}`),
    '',
  ].join('\n');
}

/**
 * Lint a rendered report. Errors: a benchmark line with a number but no source
 * URL or date; a hub credential. Warnings: overclaiming language.
 */
export function lintReport(markdown) {
  const findings = [];
  markdown.split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    if (CREDENTIAL.test(line)) findings.push({ line: lineNumber, severity: 'error', rule: 'credential-leak', message: 'hub credential material must never appear in a report' });
    if (BENCHMARK_LINE.test(line) && NUMBER.test(line) && !/^\|?\s*-{3,}/.test(line)) {
      if (!URL.test(line)) findings.push({ line: lineNumber, severity: 'error', rule: 'unsourced-number', message: 'benchmark figure without a source URL' });
      if (!DATE.test(line)) findings.push({ line: lineNumber, severity: 'error', rule: 'undated-number', message: 'benchmark figure without a capture date (YYYY-MM-DD)' });
    }
    if (OVERCLAIM.test(line)) findings.push({ line: lineNumber, severity: 'warning', rule: 'overclaim', message: 'claim strength exceeds what published benchmarks support; hedge per citation-policy' });
  });
  return { ok: !findings.some(finding => finding.severity === 'error'), findings };
}

function usage() {
  return [
    'Usage:',
    '  llm-model-report.mjs inventory validate <inventory.json>',
    '  llm-model-report.mjs inventory render <inventory.json>',
    '  llm-model-report.mjs report render <report.json>',
    '  llm-model-report.mjs report lint <report.md>',
  ].join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const [group, verb, file] = argv;
  if (group === 'inventory' && verb === 'validate' && file) {
    const problems = validateInventory(JSON.parse(readFileSync(file, 'utf8')));
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    return problems.length ? 1 : 0;
  }
  if (group === 'inventory' && verb === 'render' && file) {
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    const problems = validateInventory(entries);
    if (problems.length) throw new Error(`inventory is invalid: ${JSON.stringify(problems)}`);
    process.stdout.write(renderInventory(entries));
    return 0;
  }
  if (group === 'report' && verb === 'render' && file) {
    process.stdout.write(renderReport(JSON.parse(readFileSync(file, 'utf8'))));
    return 0;
  }
  if (group === 'report' && verb === 'lint' && file) {
    const result = lintReport(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  console.error(usage());
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = runCli(); } catch (error) { console.error(`llm-model-report: ${error.message}`); process.exitCode = 1; }
}
