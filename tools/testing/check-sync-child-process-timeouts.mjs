#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SYNC_APIS = new Set(['execFileSync', 'execSync', 'spawnSync']);

// The one file allowed to call the raw Node APIs by their aliased import
// name (`execSync as nodeExecSync`, etc.) without going through itself —
// see the comment in findUnboundedCalls().
const BOUNDED_HELPER_IMPLEMENTATION_FILE = 'src/process/bounded-child-process.mjs';
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

/**
 * Normalize a relative path to POSIX separators, regardless of which
 * separator the current OS (or the path that produced it) used. Split on
 * either `/` or `\` explicitly — not just the current `path.sep` — so this
 * is verifiable on any OS: a path already built with Windows (`\`)
 * separators normalizes the same way whether or not the process actually
 * runs on Windows right now.
 *
 * @param {string} relativePath
 * @returns {string}
 */
export function toPosixPath(relativePath) {
  return relativePath.split(/[\\/]/).join('/');
}

/**
 * `path.relative()` on Windows returns backslash-separated paths; the
 * allow-list (and every `file` field this gate reports/compares) is
 * authored with POSIX separators. Without normalizing, a Windows run would
 * never match an existing allow-list entry — every entry would read as
 * stale, and a real exemption would read as an unmatched violation
 * (#3062 finding 15).
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function toPosixRelative(root, file) {
  return toPosixPath(path.relative(root, file));
}

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

const CHILD_PROCESS_MODULE_SPECIFIERS = new Set(['child_process', 'node:child_process']);

/**
 * Resolve local bindings for the raw sync child-process APIs within one
 * file (#3062 finding 3): aliased named imports (`execSync as nodeExecSync`),
 * namespace/default imports (`import cp from 'child_process'`, `import *
 * as cp`), `require('child_process')` — whole-module or destructured, with
 * or without a rename — and a simple same-file reassignment chain
 * (`const foo = nodeExecSync` / `const foo = cp.execSync`). This lets
 * `calledApi` recognize a call through any of those bindings, not just a
 * literal `execSync`/`execFileSync`/`spawnSync` identifier or property
 * name.
 *
 * @param {ts.SourceFile} source
 * @returns {{ aliasToApi: Map<string, string>, namespaceAliases: Set<string> }}
 */
function collectChildProcessApiAliases(source) {
  const aliasToApi = new Map();
  const namespaceAliases = new Set();

  const isRequireChildProcess = (node) =>
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    && CHILD_PROCESS_MODULE_SPECIFIERS.has(node.arguments[0].text);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && CHILD_PROCESS_MODULE_SPECIFIERS.has(node.moduleSpecifier.text) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) namespaceAliases.add(clause.name.text); // default import
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          namespaceAliases.add(clause.namedBindings.name.text);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            if (SYNC_APIS.has(importedName)) aliasToApi.set(element.name.text, importedName);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer && isRequireChildProcess(node.initializer)) {
      if (ts.isIdentifier(node.name)) {
        namespaceAliases.add(node.name.text); // const cp = require('child_process')
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          if (SYNC_APIS.has(importedName)) aliasToApi.set(element.name.text, importedName);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Same-file reassignment chain: `const foo = nodeExecSync;` (alias of an
  // alias) or `const foo = cp.execSync;` (property read off a namespace
  // alias). Fixed-point over a few passes handles chains in either
  // declaration order.
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    const propagate = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const init = node.initializer;
        const targetName = node.name.text;
        if (ts.isIdentifier(init)) {
          if (!aliasToApi.has(targetName) && aliasToApi.has(init.text)) {
            aliasToApi.set(targetName, aliasToApi.get(init.text));
            changed = true;
          }
          if (!namespaceAliases.has(targetName) && namespaceAliases.has(init.text)) {
            namespaceAliases.add(targetName);
            changed = true;
          }
        } else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)
            && namespaceAliases.has(init.expression.text) && SYNC_APIS.has(init.name.text)
            && !aliasToApi.has(targetName)) {
          aliasToApi.set(targetName, init.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, propagate);
    };
    propagate(source);
    if (!changed) break;
  }

  return { aliasToApi, namespaceAliases };
}

/**
 * The raw sync API a call expression invokes, if any — resolved through
 * `aliases` (#3062 finding 3) so a renamed import, a `require` rename, or a
 * reassigned local all still resolve to the real API name they ultimately
 * call. Covers plain identifiers, `obj.method()`, and `obj['method']()`
 * (computed property access with a string-literal key).
 *
 * @param {ts.CallExpression} node
 * @param {{ aliasToApi: Map<string, string> } | undefined} aliases
 * @returns {string | null}
 */
function calledApi(node, aliases) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    if (SYNC_APIS.has(expression.text)) return expression.text;
    return aliases?.aliasToApi.get(expression.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

/**
 * The numeric value of `expr` when it is a numeric literal, a unary-minus
 * or parenthesized wrapper of one, or a `+`/`-`/`*`/`/` expression of such
 * literals — `null` when `expr` is not one of those shapes (e.g. an
 * identifier or call expression; those are not rejected by
 * `hasProvablyPositiveTimeout` below, just not provable one way or the
 * other from syntax alone).
 *
 * @param {ts.Expression} expr
 * @returns {number | null}
 */
function literalNumericValue(expr) {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replaceAll('_', ''));
    return Number.isFinite(value) ? value : null;
  }
  if (ts.isParenthesizedExpression(expr)) return literalNumericValue(expr.expression);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const operand = literalNumericValue(expr.operand);
    return operand === null ? null : -operand;
  }
  if (ts.isBinaryExpression(expr)) {
    const left = literalNumericValue(expr.left);
    const right = literalNumericValue(expr.right);
    if (left === null || right === null) return null;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.SlashToken: return right === 0 ? null : left / right;
      default: return null;
    }
  }
  return null;
}

function isUndefinedKeyword(expr) {
  return expr.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined');
}

/**
 * Whether `expr` is provably *not* a usable bound: the literal `undefined`,
 * or a numeric literal (or simple constant expression of literals) that
 * resolves to `<= 0`. Anything else — including an identifier, property
 * access, or call expression whose runtime value cannot be known from
 * syntax alone — is not provably bad, so it is left accepted exactly as
 * before (#3062 finding 4 narrows acceptance only for the specific cases
 * named in the review: `timeout: 0`, `timeout: undefined`, and a `timeout`
 * literal followed by a spread that could silently override it; it does
 * not require every `timeout` value to be a literal).
 *
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
function isProvablyNotAUsableTimeout(expr) {
  if (isUndefinedKeyword(expr)) return true;
  const numeric = literalNumericValue(expr);
  return numeric !== null && numeric <= 0;
}

/** @param {ts.ObjectLiteralExpression} objectLiteral @param {ts.SourceFile} source @returns {boolean} */
function hasProvablyPositiveTimeout(objectLiteral, source) {
  let timeoutIsPositive = false;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      timeoutIsPositive = false; // an unresolved spread can override/remove a preceding `timeout`
      continue;
    }
    const name = property.name && !ts.isComputedPropertyName(property.name)
      ? property.name.getText(source)
      : null;
    if (name !== 'timeout') continue;
    if (ts.isPropertyAssignment(property)) {
      timeoutIsPositive = !isProvablyNotAUsableTimeout(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      // `{ ..., timeout, ... }` — same as `{ timeout: timeout }`: not
      // provably bad (we have no data-flow into the referenced variable),
      // so treated the same as any other unresolvable identifier value.
      timeoutIsPositive = !isProvablyNotAUsableTimeout(property.name);
    } else {
      timeoutIsPositive = false; // e.g. a method named `timeout` — not an option value at all
    }
  }
  return timeoutIsPositive;
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
  // The bounded helper's own implementation is exempt from binding
  // resolution (#3062 finding 3): it necessarily calls the raw Node APIs
  // (aliased on import, e.g. `execSync as nodeExecSync`) through a
  // programmatically built options object — that is what "goes through
  // the bounded helper" means for every other file. Resolving its own
  // aliases would make this gate require boundedExecSync to call
  // boundedExecSync. Elsewhere, the raw spelling check alone still
  // catches a literal `execSync(...)`/`execFileSync(...)`/`spawnSync(...)`
  // here, if one is ever added outside the three documented wrappers.
  const aliases = file === BOUNDED_HELPER_IMPLEMENTATION_FILE ? undefined : collectChildProcessApiAliases(source);
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const api = calledApi(node, aliases);
      if (api && SYNC_APIS.has(api)) {
        const options = node.arguments.at(-1);
        const hasTimeout = options && ts.isObjectLiteralExpression(options)
          && hasProvablyPositiveTimeout(options, source);
        if (!hasTimeout) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          findings.push({ file, line: position.line + 1, api, node, source });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/**
 * Every actual comment token (single-line `//` or block) in `text`, via
 * the already-parsed `source`'s own token boundaries rather than a
 * standalone rescan of the raw text (#3062 finding 16).
 *
 * A marker-shaped string sitting inside a string or template literal —
 * not a real comment — must never register as an exemption; that rules
 * out a line-text regex. It also rules out an independent
 * `ts.createScanner` pass over the raw text: unlike the parser, a bare
 * scanner has no syntactic context, so it cannot tell a regex literal's
 * `/.../ ` from division — one `/` it misreads desyncs every token
 * position for the rest of the file, silently dropping every later
 * comment (this was caught by a real stale-entry regression: an existing
 * allow-listed marker past an earlier regex literal in the same file
 * stopped being found). Querying `ts.getLeadingCommentRanges` at each
 * parsed token's own start has no such ambiguity — the parser already
 * resolved it when producing that token.
 *
 * @param {ts.SourceFile} source
 * @param {string} text
 * @returns {{ pos: number, text: string }[]}
 */
function collectCommentTokens(source, text) {
  const byPos = new Map();
  const record = (ranges) => {
    for (const range of ranges ?? []) {
      if (!byPos.has(range.pos)) byPos.set(range.pos, { pos: range.pos, text: text.slice(range.pos, range.end) });
    }
  };
  const visit = (node) => {
    record(ts.getLeadingCommentRanges(text, node.getFullStart()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Trailing content at end-of-file (after the last real token) attaches
  // only to the synthetic end-of-file token, which forEachChild never
  // visits as a child of anything.
  record(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

/** Every `// sync-spawn: interactive <anchor>` marker found in one file's actual comments. */
export function findInteractiveMarkers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const markers = [];
  for (const comment of collectCommentTokens(source, text)) {
    const match = comment.text.match(MARKER_RE);
    if (!match) continue;
    const { line } = source.getLineAndCharacterOfPosition(comment.pos);
    markers.push({ file, line: line + 1, anchor: match[1].toLowerCase() });
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
 *   - every entry must be unique (no two entries for the same file+anchor)
 *   - every entry must correspond to exactly one marker that is actually
 *     attached to an exempted call ("stale" = 0 matches — listed but no
 *     longer present or never attached to a real call; "ambiguous" = 2+
 *     matches — the anchor does not uniquely identify one call, so the
 *     exemption's target is unclear)
 *
 * `attachedMarkerCountByKey` — not "does a marker with this text exist
 * anywhere in the file" — is what makes "stale" and "ambiguous" meaningful
 * (#3062 finding 16): it counts markers that `markerForFinding` actually
 * resolved to a real unbounded-call finding, so a marker-shaped comment
 * sitting next to nothing (or that never reaches a call) does not count as
 * covering an entry.
 *
 * Runs unconditionally (not gated behind `--enforce-product`): a stale,
 * duplicate, ambiguous, or malformed allow-list is a bug in the registry
 * itself, not an in-progress migration count.
 *
 * @param {{ entries: Array<{file: string, anchor: string, kind: string}> }} allowList
 * @param {Map<string, number>} attachedMarkerCountByKey
 */
export function validateAllowList(allowList, attachedMarkerCountByKey) {
  const problems = [];
  const seenKeys = new Set();
  for (const entry of allowList.entries) {
    const key = allowListKey(entry.file, entry.anchor);
    if (seenKeys.has(key)) {
      problems.push(`${entry.file}::${entry.anchor}: duplicate allow-list entry for the same file+anchor`);
      continue;
    }
    seenKeys.add(key);

    if (entry.kind !== 'interactive') {
      problems.push(`${entry.file}::${entry.anchor}: unsupported kind ${JSON.stringify(entry.kind)} (only "interactive" is supported)`);
      continue;
    }

    const count = attachedMarkerCountByKey.get(key) ?? 0;
    if (count === 0) {
      problems.push(`${entry.file}::${entry.anchor}: stale allow-list entry — no "// sync-spawn: interactive ${entry.anchor}" marker is attached to an exempted call in ${entry.file}`);
    } else if (count > 1) {
      problems.push(`${entry.file}::${entry.anchor}: ambiguous allow-list entry — anchor "${entry.anchor}" is attached to ${count} different calls in ${entry.file}; each anchor must identify exactly one call`);
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
    const fileFindings = findUnboundedCalls(toPosixRelative(root, file), text);
    findings.push(...fileFindings);
    if (fix && fileFindings.length) fixFile(file, text, fileFindings);
  }
  return findings.map(({ file, line, api }) => ({ file, line, api }));
}

/**
 * Product-code scan (src/, tools/, bin/, #3062): every unbounded call,
 * classified as `allowListed` (marker + matching registry entry) or
 * `violation` (still needs the helper, a literal timeout, or a new
 * allow-list entry). Also returns `registryProblems` (allow-list
 * validation against markers actually attached to a call — see
 * `validateAllowList`).
 */
export function checkProduct(root) {
  const allowList = loadAllowList(root);
  const attachedMarkerCountByKey = new Map();
  const allFindings = [];

  for (const file of sourceFiles(root, PRODUCT_DIRS)) {
    const relFile = toPosixRelative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    const markers = findInteractiveMarkers(relFile, text);
    const lines = text.split('\n');
    for (const finding of findUnboundedCalls(relFile, text)) {
      const marker = markerForFinding(markers, finding, lines);
      if (marker) {
        const key = allowListKey(marker.file, marker.anchor);
        attachedMarkerCountByKey.set(key, (attachedMarkerCountByKey.get(key) ?? 0) + 1);
      }
      allFindings.push({
        file: finding.file,
        line: finding.line,
        api: finding.api,
        anchor: marker?.anchor ?? null,
      });
    }
  }

  const registryProblems = validateAllowList(allowList, attachedMarkerCountByKey);

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
  return relFile.split('/')[0];
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
