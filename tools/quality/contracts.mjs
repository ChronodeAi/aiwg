/**
 * Import-contract check. The contract command and frozen-edge settings come from the
 * base-ref config, so the candidate change cannot substitute its own evaluator.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileAtRef } from './git.mjs';

export function countFrozenEdges(text, regex) {
  if (!text) return 0;
  const re = new RegExp(regex);
  return text.split('\n').filter((line) => re.test(line)).length;
}

export function runContracts(root, cfgBase, { baseRef } = {}) {
  const verdicts = [];
  const lines = [];
  const { command, frozen_edges_file: edgesFile, frozen_edge_regex: edgeRegex } = cfgBase.contracts;

  if (!command) {
    lines.push('SKIP contracts: none configured (contracts.command in .aiwg/quality/gate.json)');
  } else {
    const result = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const status = result.status ?? 1;
    if (status !== 0) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      verdicts.push({
        level: 'FAIL', code: 'contracts', file: null, metrics: { exit: status },
        message: `${command} exited ${status}${output ? `\n${output}` : ''}`,
      });
    } else {
      lines.push(`contracts: ${command} passed`);
    }
  }

  if (edgesFile && edgeRegex) {
    const headPath = path.join(root, edgesFile);
    const head = countFrozenEdges(fs.existsSync(headPath) ? fs.readFileSync(headPath, 'utf8') : '', edgeRegex);
    const base = baseRef ? countFrozenEdges(readFileAtRef(root, baseRef, edgesFile), edgeRegex) : head;
    if (head > base) {
      verdicts.push({
        level: 'FAIL', code: 'frozen-edges-increased', file: edgesFile, metrics: { base, head },
        message: `base=${base} head=${head} — invert or move the dependency; do not add ignore entries`,
      });
    } else {
      lines.push(`frozen-edges: head=${head} base=${base} (${head < base ? '↓' : '→'})`);
    }
  }
  return { verdicts, lines };
}
