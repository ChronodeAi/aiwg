import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allHandlers } from '../../../../src/cli/handlers/index.js';
import { gatesHandler } from '../../../../src/cli/handlers/gates.js';
import { getCommandDefinition, getCommandIds, searchCommandsByKeyword } from '../../../../src/extensions/commands/definitions.js';
import { artifactDigest } from '../../../../src/decision/validate.js';
import type { GateBinding, GateMetricsDocument } from '../../../../src/gates/types.js';
import {
  NOW, evaluateFixture, makeBinding, makeUpstream, pairedRecords, passingMetrics,
  proportionRecords, testHoldout,
} from '../../../conformance/gates-v1/helper.js';
import { proportionProvider, pairedProvider } from '../../../../src/gates/providers/index.js';

const repoRoot = process.cwd();
const fixturePack = 'test/conformance/gates-v1/fixtures/valid-pack.json';
const fixturePackAbs = path.join(repoRoot, fixturePack);

function ctx(args: string[], cwd = repoRoot) {
  return { args, rawArgs: ['gates', ...args], cwd, frameworkRoot: repoRoot };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function offlineFiles(dir: string, overrides?: { binding?: GateBinding; metrics?: GateMetricsDocument; upstream?: 'promote' | 'hold' | 'rollback' | null }) {
  const binding = overrides?.binding ?? makeBinding();
  const metrics = overrides?.metrics ?? passingMetrics();
  const upstream = overrides?.upstream === undefined ? makeUpstream('promote')
    : overrides.upstream === null ? null : makeUpstream(overrides.upstream);
  const holdout = testHoldout(binding);
  const bindingPath = writeJson(dir, 'binding.json', binding);
  const metricsPath = writeJson(dir, 'metrics.json', metrics);
  const holdoutPath = writeJson(dir, 'holdout.json', holdout);
  const upstreamPath = upstream ? writeJson(dir, 'upstream.json', upstream) : undefined;
  return { binding, metrics, holdout, upstream, bindingPath, metricsPath, holdoutPath, upstreamPath };
}

describe('gatesHandler', () => {
  it('is registered with command metadata', () => {
    expect(gatesHandler.id).toBe('gates');
    expect(gatesHandler.category).toBe('utility');
    expect(allHandlers.filter(handler => handler.id === 'gates')).toHaveLength(1);
    expect(getCommandDefinition('gates')).toMatchObject({ id: 'gates' });
    expect(getCommandIds()).toContain('gates');
    expect(searchCommandsByKeyword('gate pack').map(command => command.id)).toContain('gates');
  });

  it('validates packs, bindings and reports offline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-gates-cli-'));
    const { binding } = offlineFiles(dir);
    const report = evaluateFixture({ binding });
    const reportPath = writeJson(dir, 'report.json', report);
    for (const [kind, file] of [
      ['pack', fixturePack],
      ['binding', path.join(dir, 'binding.json')],
      ['report', reportPath],
    ] as const) {
      const result = await gatesHandler.execute(ctx(['validate', kind, file, '--pack-dir', fixturePackAbs]));
      expect(result.exitCode, kind).toBe(0);
      expect(JSON.parse(result.message ?? '{}')).toMatchObject({ valid: true, kind });
    }
    const invalid = await gatesHandler.execute(ctx(['validate', 'pack', 'test/conformance/gates-v1/fixtures/invalid-pack-kind.json']));
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.message ?? '{}')).toMatchObject({ valid: false });
    // Rewritten evidence with a stale digest is not a valid report.
    const forged = { ...report, decision: 'HOLD' };
    const forgedPath = writeJson(dir, 'forged-report.json', forged);
    const refused = await gatesHandler.execute(ctx(['validate', 'report', forgedPath]));
    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.message ?? '{}')).toMatchObject({ valid: false });
  });

  it('evaluates a passing binding to PROMOTE and refuses to promote breached thresholds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-gates-cli-'));
    const passing = offlineFiles(dir);
    const ok = await gatesHandler.execute(ctx([
      'evaluate', '--binding', passing.bindingPath, '--metrics', passing.metricsPath,
      '--holdout', passing.holdoutPath, '--upstream', passing.upstreamPath as string,
      '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.message ?? '{}')).toMatchObject({ decision: 'PROMOTE' });

    // Regressed Wilson upper bound: 12 false-ready events on slice a breaches
    // falseReadyMaxBps=100, so the candidate must NOT promote.
    const breachedMetrics = {
      ...passing.metrics,
      providers: {
        ...passing.metrics.providers,
        [proportionProvider.id]: proportionProvider.compute([
          ...proportionRecords({ a: { n: 1000, events: 12 }, b: { n: 1000, events: 0 } }, 'false-ready'),
          ...proportionRecords({ a: { n: 1000, events: 500 }, b: { n: 1000, events: 500 } }, 'coverage'),
        ]),
      },
    };
    const breached = offlineFiles(dir, { metrics: breachedMetrics });
    const held = await gatesHandler.execute(ctx([
      'evaluate', '--binding', breached.bindingPath, '--metrics', breached.metricsPath,
      '--holdout', breached.holdoutPath, '--upstream', breached.upstreamPath as string,
      '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(held.exitCode).toBe(0);
    const heldReport = JSON.parse(held.message ?? '{}');
    expect(heldReport.decision).toBe('HOLD');
    expect(heldReport.gateEvidence.find((entry: { gateId: string }) => entry.gateId === 'false-ready-upper'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });

    // Regressed paired contrast rolls back through the blocking gate.
    const regressedMetrics = {
      ...passing.metrics,
      providers: {
        ...passing.metrics.providers,
        [pairedProvider.id]: pairedProvider.compute(pairedRecords({
          a: { both: 300, candidateOnly: 5, baselineOnly: 90, neither: 605 },
          b: { both: 300, candidateOnly: 5, baselineOnly: 90, neither: 605 },
        })),
      },
    };
    const regressed = offlineFiles(dir, { metrics: regressedMetrics });
    const rolled = await gatesHandler.execute(ctx([
      'evaluate', '--binding', regressed.bindingPath, '--metrics', regressed.metricsPath,
      '--holdout', regressed.holdoutPath, '--upstream', regressed.upstreamPath as string,
      '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(JSON.parse(rolled.message ?? '{}').decision).toBe('ROLLBACK');
  });

  it('never upgrades an upstream HOLD or ROLLBACK and refuses forged seals', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-gates-cli-'));
    for (const upstream of ['hold', 'rollback'] as const) {
      const files = offlineFiles(dir, { upstream });
      const result = await gatesHandler.execute(ctx([
        'evaluate', '--binding', files.bindingPath, '--metrics', files.metricsPath,
        '--holdout', files.holdoutPath, '--upstream', files.upstreamPath as string,
        '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
      ], dir));
      expect(JSON.parse(result.message ?? '{}').decision).toBe(upstream === 'hold' ? 'HOLD' : 'ROLLBACK');
    }
    const clean = offlineFiles(dir);
    const forgedUpstream = { ...(clean.upstream as object), digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' };
    const forgedUpstreamPath = writeJson(dir, 'forged-upstream.json', forgedUpstream);
    const refused = await gatesHandler.execute(ctx([
      'evaluate', '--binding', clean.bindingPath, '--metrics', clean.metricsPath,
      '--holdout', clean.holdoutPath, '--upstream', forgedUpstreamPath,
      '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toMatch(/digest does not match/);

    const forgedHoldout = { ...clean.holdout, digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' };
    const forgedHoldoutPath = writeJson(dir, 'forged-holdout.json', forgedHoldout);
    const refusedHoldout = await gatesHandler.execute(ctx([
      'evaluate', '--binding', clean.bindingPath, '--metrics', clean.metricsPath,
      '--holdout', forgedHoldoutPath, '--upstream', clean.upstreamPath as string,
      '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(refusedHoldout.exitCode).toBe(1);
    expect(refusedHoldout.message).toMatch(/seal does not match/);
  });

  it('fails closed without throwing on missing files, bad digests and bad clocks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-gates-cli-'));
    const files = offlineFiles(dir);
    const missing = await gatesHandler.execute(ctx([
      'evaluate', '--binding', path.join(dir, 'missing.json'), '--metrics', files.metricsPath,
      '--holdout', files.holdoutPath, '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(missing.exitCode).toBe(1);
    const badClock = await gatesHandler.execute(ctx([
      'evaluate', '--binding', files.bindingPath, '--metrics', files.metricsPath,
      '--holdout', files.holdoutPath, '--now', 'not-a-time', '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(badClock.exitCode).toBe(1);
    // A binding whose digest differs from the frozen record is a new study version, never an edit.
    const edited = { ...files.binding, metadata: { ...files.binding.metadata, description: 'edited' } };
    const editedPath = writeJson(dir, 'edited-binding.json', edited);
    const editedHoldoutPath = writeJson(dir, 'edited-holdout.json', {
      frozenDigest: artifactDigest(files.binding), firstAccessedAt: null,
      digest: artifactDigest({ frozenDigest: artifactDigest(files.binding), firstAccessedAt: null }),
    });
    const stale = await gatesHandler.execute(ctx([
      'evaluate', '--binding', editedPath, '--metrics', files.metricsPath,
      '--holdout', editedHoldoutPath, '--now', NOW, '--pack-dir', fixturePackAbs, '--aiwg-root', dir,
    ], dir));
    expect(stale.exitCode).toBe(1);
    expect(stale.message).toMatch(/frozen record|trusted|mismatch/i);
  });

  it('shows and lists the bundled integrity-ceiling pack', async () => {
    const shown = await gatesHandler.execute(ctx(['show', 'aiwg:decision-engine/integrity-ceiling']));
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.message ?? '{}')).toMatchObject({
      id: 'aiwg:decision-engine/integrity-ceiling',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const short = await gatesHandler.execute(ctx(['show', 'integrity-ceiling', '--aiwg-root', repoRoot]));
    expect(short.exitCode).toBe(0);
    const listed = await gatesHandler.execute(ctx(['list']));
    expect(listed.exitCode).toBe(0);
    const packs = JSON.parse(listed.message ?? '{}').packs as Array<{ id: string }>;
    expect(packs.map(pack => pack.id)).toContain('aiwg:decision-engine/integrity-ceiling');
    const namespaced = await gatesHandler.execute(ctx(['list', '--namespace', 'aiwg']));
    expect(JSON.parse(namespaced.message ?? '{}').packs.every((pack: { namespace: string }) => pack.namespace === 'aiwg')).toBe(true);
    const ruleStub = await gatesHandler.execute(ctx(['list', '--rule']));
    expect(JSON.parse(ruleStub.message ?? '{}').enforcedBy.status).toBe('stub');
    const ruleFilter = await gatesHandler.execute(ctx(['list', '--rule', 'no-such-rule']));
    expect(JSON.parse(ruleFilter.message ?? '{}').packs).toEqual([]);
  });
});
