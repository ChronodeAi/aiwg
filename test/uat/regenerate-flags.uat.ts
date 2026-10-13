/**
 * UAT: `aiwg regenerate` flag validation and idempotency
 *
 * Automates two scenarios from the agentic UAT plan:
 *
 *   - MW-018: conflicting (`--workspace --full-inject`) and unknown
 *     (`--nonsense`) regenerate flags fail with usage status (exit 2) and
 *     create or modify zero files in the target project.
 *   - MW-019: each regenerate branch (canonical workspace graph and the
 *     legacy inline branch) is idempotent and preserves an operator-written
 *     paragraph outside the AIWG-managed block across repeated runs.
 *
 * Spawns the real built CLI (`bin/aiwg.mjs`) against scratch project
 * directories — see test/uat/helpers/hermetic-cli.ts for the isolation
 * contract.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildHermeticEnv, runAiwgCli, missingBuiltCli, hashTree, diffTrees,
} from './helpers/hermetic-cli.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-uat-regen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe.skipIf(missingBuiltCli())('UAT: MW-018 — conflicting/unknown regenerate flags are usage errors with zero writes', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    configDir = mkdtempSync(join(tmpdir(), 'aiwg-uat-regen-config-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('--workspace --full-inject together exits 2 and writes nothing', async () => {
    const env = await buildHermeticEnv({ aiwgConfig: configDir });
    const before = hashTree(projectDir);
    const result = runAiwgCli(['regenerate', '--workspace', '--full-inject'], { cwd: projectDir, env });
    const after = hashTree(projectDir);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    const diff = diffTrees(before, after);
    expect(diff, 'no file should be created, removed, or changed').toEqual({ added: [], removed: [], changed: [] });
  });

  it('--nonsense exits 2 and writes nothing', async () => {
    const env = await buildHermeticEnv({ aiwgConfig: configDir });
    const before = hashTree(projectDir);
    const result = runAiwgCli(['regenerate', '--nonsense'], { cwd: projectDir, env });
    const after = hashTree(projectDir);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    const diff = diffTrees(before, after);
    expect(diff, 'no file should be created, removed, or changed').toEqual({ added: [], removed: [], changed: [] });
  });
});

describe.skipIf(missingBuiltCli())('UAT: MW-019 — each regenerate branch is idempotent and preserves operator content', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    configDir = mkdtempSync(join(tmpdir(), 'aiwg-uat-regen-config-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const SENTINEL = 'Operator sentinel paragraph for MW-019 — must survive byte-for-byte.';

  it('canonical --workspace branch: second run is byte-identical and the sentinel survives', async () => {
    const env = await buildHermeticEnv({ aiwgConfig: configDir });

    expect(runAiwgCli(['init', '--non-interactive'], { cwd: projectDir, env }).status).toBe(0);
    expect(runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env }).status).toBe(0);

    const workspacePath = join(projectDir, 'WORKSPACE.md');
    const baseline = readFileSync(workspacePath, 'utf-8');
    // "## Project Context" is the operator-editable section WORKSPACE.md
    // reserves outside the AIWG-managed graph block (see WORKSPACE.md's own
    // "Ownership" guidance: "Edit project-neutral notes only inside the
    // protected Project Context section below.").
    expect(baseline).toContain('## Project Context');
    const withSentinel = baseline.replace('## Project Context', `## Project Context\n\n${SENTINEL}`);
    require('fs').writeFileSync(workspacePath, withSentinel);

    const run1 = runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env });
    expect(run1.status).toBe(0);
    const afterRun1 = readFileSync(workspacePath, 'utf-8');

    const run2 = runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env });
    expect(run2.status).toBe(0);
    const afterRun2 = readFileSync(workspacePath, 'utf-8');

    expect(afterRun1).toContain(SENTINEL);
    expect(afterRun2).toContain(SENTINEL);
    expect(afterRun2).toBe(afterRun1);
  });

  it('legacy --full-inject branch: second run is byte-identical and the sentinel survives', async () => {
    const env = await buildHermeticEnv({ aiwgConfig: configDir });

    expect(runAiwgCli(['init', '--non-interactive'], { cwd: projectDir, env }).status).toBe(0);
    expect(runAiwgCli(['regenerate', '--full-inject'], { cwd: projectDir, env }).status).toBe(0);

    const claudeMdPath = join(projectDir, 'CLAUDE.md');
    const baseline = readFileSync(claudeMdPath, 'utf-8');
    const withSentinel = `${baseline}\n\n${SENTINEL}\n`;
    require('fs').writeFileSync(claudeMdPath, withSentinel);

    const run1 = runAiwgCli(['regenerate', '--full-inject'], { cwd: projectDir, env });
    expect(run1.status).toBe(0);
    const afterRun1 = readFileSync(claudeMdPath, 'utf-8');

    const run2 = runAiwgCli(['regenerate', '--full-inject'], { cwd: projectDir, env });
    expect(run2.status).toBe(0);
    const afterRun2 = readFileSync(claudeMdPath, 'utf-8');

    expect(afterRun1).toContain(SENTINEL);
    expect(afterRun2).toContain(SENTINEL);
    expect(afterRun2).toBe(afterRun1);
  });
});
