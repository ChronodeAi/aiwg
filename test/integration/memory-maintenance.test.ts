import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildIndex } from '../../src/artifacts/index-builder.js';
import { CanonicalContextRepository } from '../../src/memory/canonical-context.js';
import { createMaintenanceOwners } from '../../src/memory/maintenance-cli.js';
import { MaintenanceReceiptSchema } from '../../src/memory/maintenance-contract.js';
import { removesResident } from '../../src/memory/maintenance.js';
import { runLineMemory } from '../../agentic/code/addons/line-memory/commands/line-memory.mjs';

const cli = path.resolve('bin/aiwg.mjs');
let temporary: string;
let workspace: string;
let env: NodeJS.ProcessEnv;
function run(args: string[]): string {
  const result = spawnSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
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
  it('reports stale startup copies after commit and verify, then current after explicit regeneration', () => {
    const regenerate = (args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args],
        { cwd: workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    regenerate(['regenerate', '--workspace', '--provider', 'codex']);
    const original = fs.readFileSync(path.join(workspace, 'WORKSPACE.md'), 'utf8');
    // The reported command must remain executable with ambiguous provider config.
    fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['codex', 'claude'], installed: {}, scripts: {} }));
    const repository = new CanonicalContextRepository(workspace);
    const proposal = { target: 'decision' as const, key: 'startup.fixture', value: 'Synthetic reviewed startup fact.',
      sourceRef: 'decision.md', sourceDigest: null, reviewer: 'operator', reason: 'Reviewed fixture',
      scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
    const entryId = repository.confirm({ preview: repository.previewUpsert(proposal), proposal }).entryIds[0];
    run(['plan', '--owner', 'compound-memory', '--target', entryId, '--op', 'recategorize', '--category', 'decisions',
      '--reviewer', 'operator', '--rationale', 'Reviewed category', '--out', 'category.json']);
    const applied = JSON.parse(run(['apply', '--plan', 'category.json', '--yes', '--json']));
    expect(MaintenanceReceiptSchema.parse(applied)).toEqual(applied);
    expect(applied.providerCopies).toEqual({ status: 'stale', regenerate: 'aiwg regenerate --workspace --provider generic' });
    expect(fs.readFileSync(path.join(workspace, 'WORKSPACE.md'), 'utf8')).toBe(original);
    const before = snapshot(temporary);
    const checked = JSON.parse(run(['verify', '--plan', 'category.json', '--json']));
    expect(checked.findings).toEqual([]); expect(checked.providerCopies.status).toBe('stale');
    expect(snapshot(temporary)).toEqual(before);
    regenerate(applied.providerCopies.regenerate.split(' ').slice(1));
    expect(fs.readFileSync(path.join(workspace, 'WORKSPACE.md'), 'utf8')).toContain(proposal.value);
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('WORKSPACE.md');
    expect(JSON.parse(run(['verify', '--plan', 'category.json', '--json'])).providerCopies.status).toBe('current');
    expect(run(['verify', '--plan', 'category.json'])).toContain('Provider copies: current');
  });

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
    expect(noConfirmation.status).toBe(2); expect(noConfirmation.stderr).toContain('Noninteractive');
    const receipt = JSON.parse(run(['apply', '--plan', 'retire.json', '--yes', '--json']));
    expect(MaintenanceReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(preview.review.targeting).toMatchObject({ scope: 'project', global: false, workspace });
    expect(preview.review.ownerReview[0].review.reviewer).toBe('synthetic operator');
    expect(receipt.schemaVersion).toBe('aiwg.maintenance-receipt.v1'); expect(receipt.partial).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toContain('disposition: retired');
    const afterApply = snapshot(temporary);
    expect(JSON.parse(run(['verify', '--plan', 'retire.json', '--json'])).findings).toEqual([]);
    expect(snapshot(temporary)).toEqual(afterApply);
    expect(JSON.parse(run(['apply', '--plan', 'retire.json', '--yes', '--json'])).ownerReceipts).toHaveLength(1);
    run(['plan', '--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md', '--op', 'restore', '--reviewer', 'synthetic operator', '--rationale', 'Reviewed reinstatement', '--out', 'restore.json']);
    expect(JSON.parse(run(['restore', '--plan', 'restore.json', '--yes', '--json'])).partial).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'utf8')).toContain('lifecycle: active');
    const afterRestore = snapshot(temporary);
    expect(JSON.parse(run(['verify', '--plan', 'restore.json', '--json'])).findings).toEqual([]);
    expect(snapshot(temporary)).toEqual(afterRestore);
    const outdated = spawnSync(process.execPath, [cli, 'memory', 'verify', '--plan', 'retire.json', '--json'], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    expect(outdated.status).toBe(1);
    expect(JSON.parse(outdated.stdout).findings.length).toBeGreaterThan(0);
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
    const verified = snapshot(temporary);
    expect(JSON.parse(run(['verify', '--plan', 'demote.json', '--json'])).findings).toEqual([]);
    expect(snapshot(temporary)).toEqual(verified);
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
        expect(result.status).toBe(3);
        expect(result.stdout + result.stderr).toContain(`${ownerName} resident removal is unsupported`);
        expect(result.stdout + result.stderr).toContain('owner-native indexed retrieval projection');
        expect(await owner.snapshot()).toBe(before);
      }
    }
  });
  it('advertises exact-plan rules and rejects invalid flags before owner writes', () => {
    expect(run(['plan', '--help'])).toContain('--confirm <plan-digest>');
    const before = snapshot(workspace);
    for (const args of [['plan', '--out'], ['apply', '--plan', 'x', '--yes=no'], ['restore', '--plan', 'x', '--unknown']]) {
      const result = spawnSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
      expect(result.status).toBe(2);
    }
    // Invalid mutation arguments may resolve artifact routing but must not create lifecycle owner state.
    expect(fs.existsSync(path.join(workspace, '.aiwg/memory/maintenance'))).toBe(false);
    expect(snapshot(workspace)).toEqual(before);
  });
  it('reports unapplied plans, stale publication and malformed inputs with deterministic JSON statuses', () => {
    fs.writeFileSync(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({ version: '1',
      command_log: { enabled: true, scopes: ['project', 'global'] },
      telemetry: { skill_usage: { enabled: true, scopes: ['project', 'global'] } } }));
    const result = (args: string[]) => spawnSync(process.execPath, [cli, 'memory', ...args], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30000,
    });
    const plan = JSON.parse(run(['plan', '--owner', 'semantic-memory', '--target', '.aiwg/wiki/decision.md',
      '--op', 'recategorize', '--category', 'decision', '--reviewer', 'operator', '--rationale', 'Reviewed taxonomy',
      '--out', 'category.json', '--json']));
    expect(plan.review.diff[0]).toMatchObject({ category: 'decision', scope: 'project' });
    const before = snapshot(temporary);
    const unapplied = result(['verify', '--plan', 'category.json', '--json']);
    expect(unapplied.status).toBe(1);
    expect(JSON.parse(unapplied.stdout).findings.length).toBeGreaterThan(0);
    expect(snapshot(temporary)).toEqual(before);
    const applied = result(['apply', '--plan', 'category.json', '--yes', '--json']);
    expect(applied.status).toBe(0);
    const review = JSON.parse(applied.stderr.trim());
    expect(review.event).toBe('maintenance-review');
    expect(review.review.targeting).toMatchObject({ scope: 'project', global: false });
    expect(review.review.limitations.join(' ')).toContain('next-session');
    expect(MaintenanceReceiptSchema.parse(JSON.parse(applied.stdout))).toMatchObject({ ownerReceipts: expect.any(Array) });
    expect(result(['verify', '--plan', 'category.json', '--json']).status).toBe(0);
    const indexFile = path.join(workspace, '.aiwg/.index/metadata.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.entries['.aiwg/wiki/decision.md'].memoryRecord.version = 1;
    fs.writeFileSync(indexFile, JSON.stringify(index));
    const stale = snapshot(temporary);
    const checked = result(['verify', '--plan', 'category.json', '--json']);
    expect(checked.status).toBe(1);
    expect(JSON.parse(checked.stdout).findings.length).toBeGreaterThan(0);
    expect(snapshot(temporary)).toEqual(stale);
    fs.writeFileSync(path.join(workspace, 'malformed.json'), '{');
    for (const args of [['verify', '--plan', 'malformed.json', '--json'], ['verify', '--plan', 'category.json', '--yes', '--json'],
      ['plan', '--scope', 'global', '--json']]) {
      const failed = result(args);
      expect(failed.status).toBe(2);
      expect(JSON.parse(failed.stdout)).toMatchObject({ exitCode: 2 });
    }
    fs.writeFileSync(path.join(workspace, '.aiwg/wiki/decision.md'), 'Concurrent body edit');
    const failedApply = result(['apply', '--plan', 'category.json', '--yes', '--json']);
    expect(failedApply.status).toBe(3);
    expect(JSON.parse(failedApply.stdout)).toMatchObject({ exitCode: 3 });
    fs.writeFileSync(indexFile, '{');
    const unreadable = result(['verify', '--plan', 'category.json', '--json']);
    expect(unreadable.status).toBe(3);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({ exitCode: 3 });
  });

});
