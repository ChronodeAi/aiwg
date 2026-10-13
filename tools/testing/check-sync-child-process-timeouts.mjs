#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SYNC_APIS = new Set(['execFileSync', 'execSync', 'spawnSync']);
// Healthy test commands finish well below one minute; this leaves generous CI
// headroom while turning an indefinite worker wedge into an attributable failure.
export const TEST_PROCESS_TIMEOUT_MS = 60_000;

// Product-code directories covered by this gate (#3062), beyond the
// pre-existing test/ scan. Each is scanned the same way; what differs is
// whether findings fail the run (see `--enforce-product` below).
const PRODUCT_DIRS = ['src', 'tools', 'bin'];

// A call is exempted as interactive by pairing a `// sync-spawn: interactive
// <anchor>` comment at the call site with a matching entry in the allow-list
// (see `loadAllowList`). The marker is the anchor: it moves with the code
// (robust to line shifts) and lets one file carry several distinct
// exemptions (one anchor per call), which an enclosing-function-name anchor
// cannot do once a function holds more than one flagged call.
const MARKER_RE = /\/\/\s*sync-spawn:\s*interactive\s+([a-z0-9][a-z0-9-]*)/i;

export const ALLOWLIST_RELATIVE_PATH = 'tools/testing/sync-spawn-allowlist.json';

function sourceFiles(root, dirNames) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // directory may not exist (e.g. bin/ before other work lands) — nothing to scan
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(target);
    }
  };
  for (const dirName of dirNames) visit(path.join(root, dirName));
  return files.sort();
}

function calledApi(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/**
 * Calls to the bounded helper (`boundedExecSync`/`boundedExecFileSync`/
 * `boundedSpawnSync`, see src/process/bounded-child-process.mjs) are never
 * found here: they are different identifiers from the raw `execSync` /
 * `execFileSync` / `spawnSync` this gate matches, so "goes through the
 * helper" requires no special-casing below — it is the identifier match
 * failing, same as a literal `timeout` option, except covered without one.
 */
export function findUnboundedCalls(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && SYNC_APIS.has(calledApi(node))) {
      const options = node.arguments.at(-1);
      const hasTimeout = options && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) => property.name?.getText(source) === 'timeout');
      if (!hasTimeout) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({ file, line: position.line + 1, api: calledApi(node), node, source });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Every `// sync-spawn: interactive <anchor>` marker found in one file's text. */
export function findInteractiveMarkers(file, text) {
  const markers = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(MARKER_RE);
    if (match) markers.push({ file, line: i + 1, anchor: match[1].toLowerCase() });
  }
  return markers;
}

// Ceiling on how far a leading comment block may run above a call before we
// stop looking for its marker — just a sanity bound, not the real stop
// condition (that's the first non-comment, non-blank line encountered).
const MARKER_LOOKBACK_LINES = 10;

/**
 * A marker exempts a finding when it sits on the call's own line (trailing
 * comment) or anywhere in the contiguous `//`-comment block immediately
 * above it. Walking the actual lines (rather than a fixed line-count window)
 * means this can't accidentally cross into an unrelated call's marker.
 */
function markerForFinding(markers, finding, lines) {
  const byLine = new Map(markers.filter((m) => m.file === finding.file).map((m) => [m.line, m]));
  for (let line = finding.line; line >= Math.max(1, finding.line - MARKER_LOOKBACK_LINES); line -= 1) {
    const marker = byLine.get(line);
    if (marker) return marker;
    if (line !== finding.line && !/^\s*(\/\/.*)?$/.test(lines[line - 1] ?? '')) break;
  }
  return undefined;
}

export function loadAllowList(root) {
  const file = path.join(root, ALLOWLIST_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { entries: [], file };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return { entries, file };
}

function allowListKey(file, anchor) {
  return `${file}::${anchor}`;
}

/**
 * Validate the allow-list registry itself, independent of any one scan:
 *   - every entry's `kind` must be `"interactive"` (the only supported kind
 *     today; anything else is a data error, not a future feature flag)
 *   - every entry must correspond to a marker actually present in the
 *     scanned files ("stale" = listed but no longer present)
 *
 * Runs unconditionally (not gated behind `--enforce-product`): a stale or
 * malformed allow-list is a bug in the registry itself, not an in-progress
 * migration count.
 */
export function validateAllowList(allowList, markersByKey) {
  const problems = [];
  for (const entry of allowList.entries) {
    if (entry.kind !== 'interactive') {
      problems.push(`${entry.file}::${entry.anchor}: unsupported kind ${JSON.stringify(entry.kind)} (only "interactive" is supported)`);
      continue;
    }
    const key = allowListKey(entry.file, entry.anchor);
    if (!markersByKey.has(key)) {
      problems.push(`${entry.file}::${entry.anchor}: stale allow-list entry — no "// sync-spawn: interactive ${entry.anchor}" marker found in ${entry.file}`);
    }
  }
  return problems;
}

function fixFile(file, text, findings) {
  const timeout = TEST_PROCESS_TIMEOUT_MS.toLocaleString('en-US').replaceAll(',', '_');
  const edits = findings.map(({ node, source }) => {
    const last = node.arguments.at(-1);
    if (last && ts.isObjectLiteralExpression(last)) {
      const prefix = last.properties.length ? ', ' : ' ';
      return { at: last.getEnd() - 1, text: `${prefix}timeout: ${timeout} ` };
    }
    return { at: node.getEnd() - 1, text: `, { timeout: ${timeout} }` };
  }).sort((a, b) => b.at - a.at);
  let fixed = text;
  for (const edit of edits) fixed = fixed.slice(0, edit.at) + edit.text + fixed.slice(edit.at);
  fs.writeFileSync(file, fixed);
}

/**
 * Original surface, unchanged: scans test/ only, with the pre-existing
 * hard-fail (or `--fix`) behavior. Nothing under #3062 altered this.
 */
export function check(root, { fix = false } = {}) {
  const findings = [];
  for (const file of sourceFiles(root, ['test'])) {
    const text = fs.readFileSync(file, 'utf8');
    const fileFindings = findUnboundedCalls(path.relative(root, file), text);
    findings.push(...fileFindings);
    if (fix && fileFindings.length) fixFile(file, text, fileFindings);
  }
  return findings.map(({ file, line, api }) => ({ file, line, api }));
}

/**
 * Product-code scan (src/, tools/, bin/, #3062): every unbounded call,
 * classified as `allowListed` (marker + matching registry entry) or
 * `violation` (still needs the helper, a literal timeout, or a new
 * allow-list entry). Also returns the raw markers (for allow-list
 * validation) and any malformed-marker problems.
 */
export function checkProduct(root) {
  const allowList = loadAllowList(root);
  const markersByKey = new Map();
  const allFindings = [];

  for (const file of sourceFiles(root, PRODUCT_DIRS)) {
    const relFile = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    const markers = findInteractiveMarkers(relFile, text);
    for (const marker of markers) {
      markersByKey.set(allowListKey(marker.file, marker.anchor), marker);
    }
    const lines = text.split('\n');
    for (const finding of findUnboundedCalls(relFile, text)) {
      const marker = markerForFinding(markers, finding, lines);
      allFindings.push({
        file: finding.file,
        line: finding.line,
        api: finding.api,
        anchor: marker?.anchor ?? null,
      });
    }
  }

  const registryProblems = validateAllowList(allowList, markersByKey);

  const violations = [];
  const allowListed = [];
  for (const finding of allFindings) {
    const key = finding.anchor ? allowListKey(finding.file, finding.anchor) : null;
    const entry = key ? allowList.entries.find((e) => allowListKey(e.file, e.anchor) === key) : undefined;
    if (entry && entry.kind === 'interactive') allowListed.push(finding);
    else violations.push(finding);
  }

  return { violations, allowListed, registryProblems };
}

function topLevelDir(relFile) {
  return relFile.split(path.sep)[0];
}

function printProductReport({ violations, allowListed }, { enforced }) {
  const counts = new Map();
  for (const dir of PRODUCT_DIRS) counts.set(dir, { violations: 0, allowListed: 0 });
  for (const finding of violations) {
    const dir = topLevelDir(finding.file);
    if (!counts.has(dir)) counts.set(dir, { violations: 0, allowListed: 0 });
    counts.get(dir).violations += 1;
  }
  for (const finding of allowListed) {
    const dir = topLevelDir(finding.file);
    if (!counts.has(dir)) counts.set(dir, { violations: 0, allowListed: 0 });
    counts.get(dir).allowListed += 1;
  }

  const label = enforced ? 'enforced' : 'report mode — not yet enforced';
  console.log(`Sync child-process timeout gate — product code (src/, tools/, bin/) [${label}]:`);
  for (const [dir, counted] of counts) {
    console.log(`  ${dir}: ${counted.violations} unbounded (${counted.allowListed} allow-listed interactive)`);
  }
  const total = [...counts.values()].reduce((sum, c) => sum + c.violations, 0);
  console.log(`  total unbounded (non-allow-listed): ${total}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  // --root lets tests point the gate at a synthetic fixture tree instead of
  // this repo, so "report mode never fails" etc. don't depend on the real
  // (mutable, in-progress) product-code violation count.
  const rootFlagIndex = process.argv.indexOf('--root');
  const root = rootFlagIndex !== -1 && process.argv[rootFlagIndex + 1]
    ? path.resolve(process.argv[rootFlagIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fix = process.argv.includes('--fix');
  const enforceProduct = process.argv.includes('--enforce-product');

  // 1. test/ — unchanged hard-fail (or --fix) behavior.
  const testFindings = check(root, { fix });
  let failed = false;
  if (fix) {
    console.log(`Added ${TEST_PROCESS_TIMEOUT_MS / 1000}s timeouts to ${testFindings.length} synchronous child-process calls in test/.`);
  } else if (testFindings.length) {
    for (const finding of testFindings) console.error(`${finding.file}:${finding.line}: ${finding.api} has no explicit timeout`);
    console.error(`Found ${testFindings.length} unbounded synchronous child-process calls in test/.`);
    failed = true;
  } else {
    console.log('Synchronous child-process timeout gate (test/): 0 unbounded calls.');
  }

  // 2. src/, tools/, bin/ — report always; enforce only with --enforce-product.
  const product = checkProduct(root);
  printProductReport(product, { enforced: enforceProduct });

  if (product.registryProblems.length) {
    for (const problem of product.registryProblems) console.error(`${ALLOWLIST_RELATIVE_PATH}: ${problem}`);
    failed = true;
  }

  if (enforceProduct && product.violations.length) {
    for (const finding of product.violations) {
      console.error(`${finding.file}:${finding.line}: ${finding.api} has no explicit timeout, does not go through the bounded helper, and is not on the allow-list`);
    }
    failed = true;
  }

  if (failed) process.exitCode = 1;
}
