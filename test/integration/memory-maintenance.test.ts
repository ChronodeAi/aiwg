import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildIndex } from '../../src/artifacts/index-builder.js';
import { CanonicalContextRepository } from '../../src/memory/canonical-context.js';
import { createMaintenanceOwners } from '../../src/memory/maintenance-cli.js';
import { removesResident } from '../../src/memory/maintenance.js';
import { runLineMemory } from '../../agentic/code/addons/line-memory/commands/line-memory.mjs';

const cli = path.resolve('bin/aiwg.mjs');
let temporary: string;
let workspace: string;
let env: NodeJS.ProcessEnv;
function run(args: string[]): string {
  return execFileSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function snapshot(root: string): unknown[] {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name); const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
beforeEach(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-maintenance-cli-'));
  workspace = path.join(temporary, 'workspace'); const home = path.join(temporary, 'home');
  fs.mkdirSync(path.join(workspace, '.aiwg/wiki'), { recursive: true }); fs.mkdirSync(home);
  env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_CLI_DRY_RUN: '',
    AIWG_PROJECT_MEMORY_HOME: path.join(home, '.aiwg/projects'), AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '', NO_COLOR: '1' };
  fs.writeFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), '# Synthetic decision\nKeep bounded retry constraints.\n');
  await buildIndex(workspace, { force: true, quiet: true, workers: 0 });
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('built memory maintenance CLI', () => {
  it('plans without ancillary writes, previews read-only, retires and restores through the indexed owner', () => {
    const before = snapshot(temporary);
    const flags = ['--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md', '--op', 'retire', '--reviewer', 'synthetic operator', '--rationale', 'Reviewed obsolete fact'];
    const preview = JSON.parse(run(['plan', ...flags, '--preview', '--json']));
    expect(preview.plan.operations[0].sessionEffect).toBe('next-session'); expect(snapshot(temporary)).toEqual(before);
    run(['plan', ...flags, '--out', 'retire.json', '--json']);
    const planned = snapshot(temporary);
    expect(JSON.parse(run(['apply', '--plan', 'retire.json', '--preview', '--json'])).planDigest).toBe(preview.planDigest);
    expect(snapshot(temporary)).toEqual(planned);
    const noConfirmation = spawnSync(process.execPath, [cli, 'memory', 'apply', '--plan', 'retire.json'], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    expect(noConfirmation.status).toBe(1); expect(noConfirmation.stderr).toContain('Noninteractive');
    const receipt = JSON.parse(run(['apply', '--plan', 'retire.json', '--yes', '--json']));
    expect(receipt.schemaVersion).toBe('aiwg.maintenance-receipt.v1'); expect(receipt.partial).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toContain('disposition: retired');
    expect(JSON.parse(run(['apply', '--plan', 'retire.json', '--yes', '--json'])).ownerReceipts).toHaveLength(1);
    run(['plan', '--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md', '--op', 'restore', '--reviewer', 'synthetic operator', '--rationale', 'Reviewed reinstatement', '--out', 'restore.json']);
    expect(JSON.parse(run(['restore', '--plan', 'restore.json', '--yes', '--json'])).partial).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toContain('lifecycle: active');
  });
  it('successfully demotes resident artifact content through the real indexed verifier', () => {
    const common = ['--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md',
      '--reviewer', 'operator', '--rationale', 'Reviewed placement change'];
    run(['plan', ...common, '--op', 'promote', '--placement', 'resident', '--out', 'promote.json']);
    expect(JSON.parse(run(['apply', '--plan', 'promote.json', '--yes', '--json'])).partial).toBeUndefined();
    const demotion = JSON.parse(run(['plan', ...common, '--op', 'demote', '--placement', 'indexed',
      '--out', 'demote.json', '--json']));
    expect(removesResident(demotion.plan.operations[0])).toBe(true);
    expect(JSON.parse(run(['apply', '--plan', 'demote.json', '--preview', '--json'])).planDigest).toBe(demotion.planDigest);
    expect(JSON.parse(run(['apply', '--plan', 'demote.json', '--yes', '--json'])).partial).toBeUndefined();
    const index = JSON.parse(fs.readFileSync(path.join(workspace, '.aiwg/.index/metadata.json'), 'utf8'));
    expect(index.entries['.aiwg/wiki/decision.md'].memoryRecord).toMatchObject({ placement: 'indexed', lifecycle: 'active' });
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toContain('Keep bounded retry constraints.');
  });
  it.each(['line-memory', 'compound-memory'])('explicitly refuses unsupported %s resident removal through the real CLI verifier', async ownerName => {
    const value = 'Retain bounded retries';
    if (ownerName === 'line-memory') {
      expect((await runLineMemory('add', [value], workspace)).exitCode).toBe(0);
    } else {
      const repository = new CanonicalContextRepository(workspace);
      const proposal = { target: 'decision' as const, key: 'retries', value, sourceRef: 'source.md',
        sourceDigest: null, reviewer: 'operator', reason: 'Reviewed decision', scope: 'project',
        classification: 'internal' as const, reviewAt: null, expiresAt: null };
      repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
    }
    // Even a same-digest artifact and explicit link cannot supply the missing
    // owner-native indexed projection or silently enable unsupported removal.
    fs.writeFileSync(path.join(workspace, '.aiwg/wiki/copy.md'), value);
    await buildIndex(workspace, { force: true, quiet: true, workers: 0 });
    const owner = (await createMaintenanceOwners(workspace)).find(owner => owner.name === ownerName)!;
    const record = (await owner.records())[0];
    for (const op of ['demote', 'retire'] as const) {
      const operation = { op, target: { id: record.id, digest: record.digest, version: record.version },
        precondition: { digest: record.digest, version: record.version },
        from: { placement: record.placement, lifecycle: record.lifecycle },
        to: { placement: op === 'demote' ? 'indexed' as const : record.placement,
          lifecycle: op === 'retire' ? 'retired' as const : record.lifecycle },
        owner: { name: ownerName, handle: record.aliases[0], snapshot: await owner.snapshot() },
        review: { reviewer: 'operator', retirementBasis: 'review' as const }, scope: record.scope,
        rationale: 'Reviewed resident removal', uncertainty: 'Session load unobserved',
        impactedLinks: ['.aiwg/wiki/copy.md'], sessionEffect: 'next-session' as const };
      expect(removesResident(operation)).toBe(true);
      const planPath = `${ownerName}-${op}.json`;
      fs.writeFileSync(path.join(workspace, planPath), JSON.stringify({ schemaVersion: 'aiwg.maintenance-plan.v1', operations: [operation] }));
      const before = await owner.snapshot();
      for (const mode of [['--preview'], ['--yes']]) {
        const result = spawnSync(process.execPath, [cli, 'memory', 'apply', '--plan', planPath, ...mode, '--json'],
          { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${ownerName} resident removal is unsupported`);
        expect(result.stderr).toContain('owner-native indexed retrieval projection');
        expect(await owner.snapshot()).toBe(before);
      }
    }
  });
  it('advertises exact-plan rules and rejects invalid flags before owner writes', () => {
    expect(run(['plan', '--help'])).toContain('--confirm <plan-digest>');
    const before = snapshot(workspace);
    for (const args of [['plan', '--out'], ['apply', '--plan', 'x', '--yes=no'], ['restore', '--plan', 'x', '--unknown']]) {
      const result = spawnSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
      expect(result.status).toBe(1);
    }
    // Invalid mutation arguments may resolve artifact routing but must not create lifecycle owner state.
    expect(fs.existsSync(path.join(workspace, '.aiwg/memory/maintenance'))).toBe(false);
    expect(snapshot(workspace)).toEqual(before);
  });
});
