#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SYNC_APIS = new Set(['execFileSync', 'execSync', 'spawnSync']);
// Healthy test commands finish well below one minute; this leaves generous CI
// headroom while turning an indefinite worker wedge into an attributable failure.
export const TEST_PROCESS_TIMEOUT_MS = 60_000;

function sourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(target);
    }
  };
  visit(path.join(root, 'test'));
  return files.sort();
}

function calledApi(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

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

export function check(root, { fix = false } = {}) {
  const findings = [];
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const fileFindings = findUnboundedCalls(path.relative(root, file), text);
    findings.push(...fileFindings);
    if (fix && fileFindings.length) fixFile(file, text, fileFindings);
  }
  return findings.map(({ file, line, api }) => ({ file, line, api }));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fix = process.argv.includes('--fix');
  const findings = check(root, { fix });
  if (fix) {
    console.log(`Added ${TEST_PROCESS_TIMEOUT_MS / 1000}s timeouts to ${findings.length} synchronous child-process calls.`);
  } else if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.api} has no explicit timeout`);
    console.error(`Found ${findings.length} unbounded synchronous child-process calls.`);
    process.exitCode = 1;
  } else {
    console.log('Synchronous child-process timeout gate: 0 unbounded calls.');
  }
}
