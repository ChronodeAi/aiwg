/**
 * opencode rules → opencode.json instructions[] wiring (#1548).
 *
 * OpenCode loads rule content via the `instructions` array in opencode.json.
 * AIWG deploys rules to .opencode/rule/ but they're inert unless referenced
 * there. mergeOpenCodeInstructions wires a rule-dir glob + AGENTS.md
 * non-destructively. These tests lock: create-when-absent, merge-preserving-
 * operator-config, dedupe/no-op-when-wired, malformed-skip, and dry-run.
 *
 * @issue #1548
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// @ts-expect-error — provider is plain .mjs without types
import { mergeOpenCodeInstructions } from '../../../tools/agents/providers/opencode.mjs';

let dir: string;
const RULE_GLOB = '.opencode/rule/*.md';

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-oc-instr-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergeOpenCodeInstructions (#1548)', async () => {
  it('creates opencode.json with the rule glob + AGENTS.md when absent', async () => {
    const changed = await mergeOpenCodeInstructions(dir, {});
    expect(changed).toBe(true);
    const cfg = readConfig();
    expect(cfg.instructions).toEqual([RULE_GLOB, 'AGENTS.md', 'AIWG.md']);
  });

  it('merges into an existing opencode.json, preserving operator keys + entries', async () => {
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ theme: 'dark', instructions: ['CONTRIBUTING.md'] }, null, 2),
      'utf8',
    );
    const changed = await mergeOpenCodeInstructions(dir, {});
    expect(changed).toBe(true);
    const cfg = readConfig();
    // Operator key survives
    expect(cfg.theme).toBe('dark');
    // Existing entry preserved, AIWG entries appended
    expect(cfg.instructions).toEqual(['CONTRIBUTING.md', RULE_GLOB, 'AGENTS.md', 'AIWG.md']);
  });

  it('is a no-op (no duplication) when already wired', async () => {
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ instructions: [RULE_GLOB, 'AGENTS.md', 'AIWG.md'] }, null, 2),
      'utf8',
    );
    const changed = await mergeOpenCodeInstructions(dir, {});
    expect(changed).toBe(false);
    expect(readConfig().instructions).toEqual([RULE_GLOB, 'AGENTS.md', 'AIWG.md']);
  });

  it('adds only the missing entry when one is already present', async () => {
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ instructions: ['AGENTS.md'] }, null, 2),
      'utf8',
    );
    await mergeOpenCodeInstructions(dir, {});
    expect(readConfig().instructions).toEqual(['AGENTS.md', RULE_GLOB, 'AIWG.md']);
  });

  it('leaves a malformed opencode.json untouched (warn, skip — never clobber)', async () => {
    const malformed = '{ this is not json';
    fs.writeFileSync(path.join(dir, 'opencode.json'), malformed, 'utf8');
    const changed = await mergeOpenCodeInstructions(dir, {});
    expect(changed).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).toBe(malformed);
  });

  it('dry-run does not write the file', async () => {
    const changed = await mergeOpenCodeInstructions(dir, { dryRun: true });
    expect(changed).toBe(true); // reports it would change
    expect(fs.existsSync(path.join(dir, 'opencode.json'))).toBe(false);
  });
});


describe('OpenCode safe writes (#3565)', () => {
  it('refuses a target symlink and leaves external bytes untouched', async () => {
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const outside = path.join(dir, 'outside.json');
    const original = '{ "theme": "operator" }\n';
    fs.writeFileSync(outside, original);
    fs.symlinkSync(outside, path.join(project, 'opencode.json'));
    await expect(Promise.resolve().then(() => mergeOpenCodeInstructions(project)))
      .rejects.toThrow(/symlink/);
    expect(fs.readFileSync(outside, 'utf8')).toBe(original);
  });

  it('atomically replaces the config and keeps its project mode', async () => {
    const config = path.join(dir, 'opencode.json');
    const snapshot = path.join(dir, 'snapshot.json');
    const original = '{ "theme": "operator" }\n';
    fs.writeFileSync(config, original);
    fs.chmodSync(config, 0o640);
    fs.linkSync(config, snapshot);
    await mergeOpenCodeInstructions(dir);
    expect(fs.readFileSync(snapshot, 'utf8')).toBe(original);
    expect(fs.statSync(config).mode & 0o777).toBe(0o640);
    expect(readConfig().instructions).toContain(RULE_GLOB);
  });
});
