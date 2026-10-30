import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { PROVIDER_MEMORY_ADAPTERS } from '../../../src/memory/provider-memory-adapter.js';
import { auditMemory } from '../../../src/memory/audit.js';
import { main } from '../../../src/memory/cli.js';
import { costMemory } from '../../../src/memory/cost.js';
import { recommendMemory } from '../../../src/memory/recommend.js';
import { memoryRecordId } from '../../../src/memory/maintenance-record.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import { ArtifactMaintenanceOwner } from '../../../src/artifacts/memory-maintenance.js';
import { loadMetadataIndex } from '../../../src/artifacts/index-reader.js';
import { applyMaintenancePlan, maintenancePlanDigest, maintenanceOperationKey, previewMaintenancePlan, verifyMaintenancePlan } from '../../../src/memory/maintenance.js';
import type { MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { at, body, compareBaselines, config, gate, plan, rebuild, retrieve, roster, seedCorpus, seedLocalProviders, snapshot, sourcePath, write } from './fixtures.js';
import { CanonicalContextRepository } from '../../../src/memory/canonical-context.js';
import { CanonicalMaintenanceOwner } from '../../../src/memory/canonical-maintenance.js';
import { runMemoryMaintenanceCli } from '../../../src/memory/maintenance-cli.js';
import { regenerateHandler } from '../../../src/cli/handlers/regenerate.js';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { migrateWorkspaceContext, buildWorkspaceManagedBlock, providerCopiesStatus } from '../../../src/smiths/context-pipeline/workspace-context.js';

// libuv homedir does not reliably follow Vitest's virtualized environment.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

let temp: string, root: string, home: string;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-memory-qualification-'));
  root = path.join(temp, 'project'); home = path.join(temp, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_PROJECT_LOCAL_PATHS',
    'AIWG_GROKBOT_SKILLS_DIR', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE']) vi.stubEnv(key, '');
  for (const [key, dir] of Object.entries({ AIWG_PROJECT_MEMORY_HOME: '.aiwg/projects', XDG_CONFIG_HOME: '.config',
    XDG_DATA_HOME: '.local/share', XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache',
    HERMES_HOME: '.hermes', GROK_HOME: '.grok', CLAUDE_CONFIG_DIR: '.claude', CODEX_HOME: '.codex' })) vi.stubEnv(key, path.join(home, dir));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedLocalProviders(root);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(temp, { recursive: true, force: true }); });

const ids = [...PROVIDER_IDS, ...config.localProviders.map(provider => provider.id)];
const nativeCommand = 'node tools/rules/run-rule-probes.mjs --provider codex --model "$MEMORY_PROBE_MODEL" --effort low --n 1 --rule tool-quota --project "$MEMORY_PROBE_PROJECT" --aiwg-root "$MEMORY_PROBE_PACKAGE" --identity-file "$MEMORY_PROBE_IDENTITY" --account-home "$MEMORY_PROBE_ACCOUNT" --codex-executable "$MEMORY_PROBE_CODEX" --output "$MEMORY_PROBE_OUTPUT"';

describe('memory maintenance provider qualification (#3285), offline default lane', () => {
  it('derives the full roster from the canonical registry and validated local manifests, failing closed', async () => {
    expect((await roster(root)).map(row => row.id)).toEqual(ids);
    for (const id of PROVIDER_IDS) {
      const missing = new Map(PROVIDER_MEMORY_ADAPTERS); missing.delete(id);
      await expect(roster(root, missing)).rejects.toThrow(`Missing memory adapter contract for ${id}`);
    }
    write(root, '.aiwg/providers/broken/manifest.json', JSON.stringify({ id: 'broken', type: 'provider', manifestVersion: '1', version: '1.0.0', name: 'broken', description: 'broken', providerConfig: { extends: 'unregistered' } }));
    await expect(roster(root)).rejects.toThrow();
  });

  it.each(ids)('%s: common path, recovery and outcome qualification', async id => {
    const row = (await roster(root)).find(row => row.id === id)!;
    expect(row, 'Every registered selector needs a disposition').toBeDefined();
    const { adapter } = row;
    const scenarios: Record<string, 'pass'> = {};
    async function scenario(name: string, run: () => Promise<void>) { await run(); scenarios[name] = 'pass'; }
    seedCorpus(root);
    // The temporal replacement is produced by a reviewed supersession, not seeded as a live fact.
    fs.rmSync(path.join(root, sourcePath('current-port')));
    await rebuild(root);
    let failIndex = false;
    const owner = new ArtifactMaintenanceOwner(root, { now: () => new Date(at), rebuild: async () => {
      if (failIndex) throw new Error('synthetic index publication failure');
      await rebuild(root);
    } });
    async function apply(input: MaintenancePlan) {
      const result = await applyMaintenancePlan(input, { root, owners: [owner], confirmedDigest: maintenancePlanDigest(input) });
      expect(result.partial).toBeUndefined();
      const before = snapshot(root);
      expect((await verifyMaintenancePlan(input, [owner])).findings).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      return result;
    }

    await scenario('adapter-disposition', async () => {
      const item = { visibility: 'static' as const, observation: { status: 'on-disk' as const,
        evidence: { source: 'synthetic fixture', at, provider: adapter.providerId, version: null, session: null } } };
      expect(adapter.disposition(item)).toBe('on-disk');
      expect(adapter.disposition({ ...item, visibility: 'hidden' })).toBe('opaque');
      expect(adapter.disposition({ ...item, observation: { ...item.observation, status: 'observed' } })).toBe('inferred');
      expect(['unknown', 'next-session']).toContain(adapter.sessionEffect('retire'));
    });

    await scenario('audit-cli-non-mutation-and-scope-isolation', async () => {
      // Same alias, distinct identities: do not silently pick a winning source.
      const original = (await owner.records()).find(record => record.sourcePath === sourcePath('retry'))!;
      for (const [index, scope] of ['project', 'project', 'global'].entries()) {
        const source = scope === 'global' ? path.join(home, '.aiwg/projects/global.json') : `.aiwg/memory/collision-${index}.json`;
        const digest = sha256(`collision-${index}`);
        const record = { ...original, id: memoryRecordId(source, digest), digest, sourcePath: source, scope, aliases: ['shared-alias'] };
        write(scope === 'global' ? home : root, scope === 'global' ? '.aiwg/projects/global.json' : source, JSON.stringify(record));
      }
      const before = snapshot(temp);
      const local = await auditMemory({ workspace: root, provider: adapter.providerId, scope: 'project', at, clock: () => 0 });
      const global = await auditMemory({ workspace: root, provider: adapter.providerId, scope: 'global', at, clock: () => 0 });
      expect(local.findings.some(finding => finding.code === 'alias-collision')).toBe(true);
      expect(local.items.some(item => item.record?.scope === 'global')).toBe(false);
      expect(global.items.some(item => item.record?.scope === 'project')).toBe(false);
      expect(global.items.some(item => item.sourcePath.endsWith('global.json'))).toBe(true);
      expect(local.coverage.limitsHit).toEqual([]); expect(global.coverage.limitsHit).toEqual([]);
      expect(local.items.every(item => item.observation.status !== 'observed')).toBe(true);
      await main(['audit', '--scope', 'project', '--provider', adapter.providerId, '--json']);
      const cliAudit = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(cliAudit.providers.map((provider: { id: string }) => provider.id)).toEqual([adapter.providerId]);
      expect(cliAudit.items.some((item: { sourcePath: string }) => item.sourcePath === sourcePath('retry'))).toBe(true);
      expect(snapshot(temp)).toEqual(before);
      for (const index of [0, 1]) fs.rmSync(path.join(root, `.aiwg/memory/collision-${index}.json`));
    });

    await scenario('unknown-use-and-rare-obligation-regressions', async () => {
      const audit = await auditMemory({ workspace: root, provider: adapter.providerId, scope: 'project', at, clock: () => 0 });
      const targets = audit.items.filter(item => [sourcePath('recovery'), sourcePath('unknown-use')].includes(item.sourcePath));
      expect(targets).toHaveLength(2);
      const costs = costMemory(audit, { at, env: {} });
      for (const item of targets) expect(costs.items.find(cost => cost.id === item.id)?.utility.used).toBeNull();
      const recommendations = recommendMemory(audit, { items: Object.fromEntries(targets.map(item => [item.id, {
        source: 'synthetic review', obsolete: true, history: 'unknown', createdAt: '2001-01-01T00:00:00.000Z',
        ...(item.sourcePath === sourcePath('recovery') ? { rareObligation: true, ownerPinned: true } : {}),
      }])) }, { at, env: {} });
      for (const item of targets) {
        const candidates = recommendations.candidates.filter(candidate => candidate.target.id === item.id && candidate.kind === 'retire');
        expect(candidates).toHaveLength(1);
        expect(candidates[0].status).toBe('blocked');
        expect(candidates[0].blockedReasons.join(' ')).toMatch(/unknown/);
      }
      const age = await plan(owner, 'retire', 'recovery'); age.operations[0].review!.retirementBasis = 'age';
      await expect(previewMaintenancePlan(age, [owner])).rejects.toThrow(/Pinned/);
      expect(body(root, 'recovery')).toContain('annual-offline-drill');
    });

    await scenario('all-placement-and-taxonomy-operations', async () => {
      const original = (await owner.records()).find(record => record.sourcePath === sourcePath('unknown-use'))!;
      for (const [op, placement] of [['promote', 'task-context'], ['promote', 'resident'], ['demote', 'task-context'], ['demote', 'indexed'], ['demote', 'archived'], ['promote', 'indexed']] as const) {
        const current = (await owner.records()).find(record => record.id === original.id)!;
        await apply(await plan(owner, op, 'unknown-use', { to: { lifecycle: 'active', placement } }));
        const next = (await owner.records()).find(record => record.id === original.id)!;
        expect(next).toMatchObject({ placement, lifecycle: 'active', scope: original.scope, authority: original.authority, version: current.version + 1 });
      }
      await apply(await plan(owner, 'recategorize', 'unknown-use', { category: 'reviewed-decisions' }));
      expect(body(root, 'unknown-use')).toContain('keep-original-source');
    });

    await scenario('stale-plan-and-cross-scope-rejection', async () => {
      const stale = await plan(owner, 'recategorize', 'retry', { category: 'stale' });
      await apply(await plan(owner, 'recategorize', 'retry', { category: 'fresh' }));
      const before = snapshot(root);
      await expect(previewMaintenancePlan(stale, [owner])).rejects.toThrow(/Stale/);
      const wrongScope = await plan(owner, 'retire', 'retry'); wrongScope.operations[0].scope = 'global';
      await expect(previewMaintenancePlan(wrongScope, [owner])).rejects.toThrow(/project scope/);
      expect(snapshot(root)).toEqual(before);
    });

    await scenario('temporal-supersession-and-source-survival', async () => {
      const fact = config.facts.find(fact => fact.id === 'current-port')!;
      const original = body(root, 'old-port');
      await apply(await plan(owner, 'supersede', 'old-port', { replacements: [{
        key: fact.id, sourcePath: sourcePath(fact.id), value: `${fact.topic} fact ${fact.key}=${fact.value}\n`,
      }] }));
      expect(body(root, 'old-port')).toBe(original);
      const hits = await retrieve(root, 'tungsten', output);
      expect(hits).toContain(sourcePath('current-port')); expect(hits).not.toContain(sourcePath('old-port'));
    });

    await scenario('merge-and-split-lineage', async () => {
      for (const id of ['merge-a', 'merge-b', 'split']) write(root, sourcePath(id), `---\ntype: skill\nname: ${id}\n---\nRetain ${id} original fact.\n`);
      await rebuild(root);
      const related = (await owner.records()).find(record => record.sourcePath === sourcePath('merge-b'))!;
      await apply(await plan(owner, 'merge', 'merge-a', { related: [{ id: related.id, digest: related.digest, version: related.version }],
        replacements: [{ key: 'merged', sourcePath: sourcePath('merged'), value: 'Retain merge-a original fact.\nRetain merge-b original fact.\n' }] }));
      await apply(await plan(owner, 'split', 'split', { replacements: [
        { key: 'split-one', sourcePath: sourcePath('split-one'), value: 'Retain split original fact.\n' },
        { key: 'split-two', sourcePath: sourcePath('split-two'), value: 'Retain additional reviewed split fact.\n' },
      ] }));
      expect(body(root, 'merged')).toContain('merge-b original fact');
      for (const id of ['merge-a', 'merge-b', 'split']) expect(body(root, id)).toContain(`${id} original fact`);
    });

    await scenario('interruption-and-idempotent-resume', async () => {
      const input = await plan(owner, 'recategorize', 'retry', { category: 'resumed' });
      const options = { root, owners: [owner], confirmedDigest: maintenancePlanDigest(input) };
      await expect(applyMaintenancePlan(input, { ...options, afterOwner: () => { throw new Error('synthetic interruption after owner commit'); } })).rejects.toThrow(/synthetic interruption/);
      const version = (await owner.records()).find(record => record.sourcePath === sourcePath('retry'))!.version;
      const resumed = await apply(input); expect(resumed.resumedFrom).toBeDefined();
      const before = await owner.snapshot(); await apply(input);
      expect(await owner.snapshot()).toBe(before);
      expect((await owner.records()).find(record => record.sourcePath === sourcePath('retry'))!.version).toBe(version);
    });

    await scenario('index-failure-fails-closed-then-recovers', async () => {
      const input = await plan(owner, 'retire', 'decoy'); failIndex = true;
      await expect(applyMaintenancePlan(input, { root, owners: [owner], confirmedDigest: maintenancePlanDigest(input) })).rejects.toMatchObject({ receipt: { partial: { pending: [maintenanceOperationKey(input, 0)] } } });
      expect(await owner.receipt(maintenanceOperationKey(input, 0), { readOnly: true })).toBeUndefined();
      expect((await verifyMaintenancePlan(input, [owner])).findings.length).toBeGreaterThan(0);
      expect(await retrieve(root, 'unrelated', output)).not.toContain(sourcePath('decoy'));
      failIndex = false; await apply(input);
    });

    await scenario('restore-verify-and-common-redeployment', async () => {
      const original = body(root, 'decoy');
      await apply(await plan(owner, 'restore', 'decoy'));
      expect(body(root, 'decoy')).toBe(original);
      expect(await retrieve(root, 'unrelated', output)).toContain(sourcePath('decoy'));
      await apply(await plan(owner, 'retire', 'decoy'));
      // Actual existing index regeneration owner consumes canonical lifecycle metadata.
      await rebuild(root); await rebuild(root);
      expect(loadMetadataIndex(root)?.entries[sourcePath('decoy')].memoryRecord?.lifecycle).toBe('retired');
      expect(await retrieve(root, 'unrelated', output)).not.toContain(sourcePath('decoy'));
      expect(await retrieve(root, 'tungsten', output)).not.toContain(sourcePath('old-port'));
      expect(body(root, 'decoy')).toBe(original);
    });

    let migrationRecall = 0;
    await scenario('provider-model-embedder-migration-retrieval', async () => {
      // Transfer canonical sources, not a provider cache or an embedder-specific index.
      // Rebuild and query the portable lexical fallback under a new workspace.
      const migrated = path.join(temp, 'migrated'); fs.mkdirSync(migrated);
      fs.cpSync(path.join(root, '.aiwg/wiki'), path.join(migrated, '.aiwg/wiki'), { recursive: true });
      write(migrated, 'package.json', JSON.stringify({ name: 'migrated-fixture', version: '1.0.0', aiwg: {
        provider: adapter.providerId === 'generic' ? 'codex' : 'generic', model: 'synthetic-model-v2', embedder: 'synthetic-embedder-v2',
      } }));
      await rebuild(migrated);
      const migratedProvider = adapter.providerId === 'generic' ? 'codex' : 'generic';
      const inventory = await auditMemory({ workspace: migrated, provider: migratedProvider, scope: 'project', at, clock: () => 0 });
      expect(inventory.providers.map(provider => provider.id)).toEqual([migratedProvider]);
      expect(inventory.items.some(item => item.sourcePath === sourcePath('recovery') && item.record?.authority.protection === 'pinned')).toBe(true);
      let found = 0;
      const migrationTargets = [...config.facts.filter(fact => !fact.stale && fact.id !== 'decoy'), ...config.rules];
      for (const fact of migrationTargets) {
        const hits = await retrieve(migrated, fact.topic, output);
        expect(hits).toEqual(await retrieve(root, fact.topic, output));
        if (hits.includes(sourcePath(fact.id))) found++;
        expect(hits).not.toContain(sourcePath('old-port'));
      }
      migrationRecall = found / migrationTargets.length; expect(migrationRecall).toBe(1);
    });

    const survival = config.facts.filter(fact => body(root, fact.id) === `${fact.topic} fact ${fact.key}=${fact.value}\n`).length / config.facts.length;
    const comparison = await compareBaselines(root, output, migrationRecall, survival);
    expect(await compareBaselines(root, output, migrationRecall, survival)).toEqual(comparison);
    const baselines = comparison
      .map(baseline => ({ ...baseline, gateFailures: gate(baseline.metrics) }));
    for (const baseline of baselines) if (['indexed', 'selected-context', 'resident'].includes(baseline.baseline)) expect(gate(baseline.metrics), baseline.baseline).toEqual([]);
    expect(gate(baselines.find(row => row.baseline === 'no-memory')!.metrics)).toEqual(expect.arrayContaining(['recall', 'activation', 'adherence', 'completion']));
    expect(gate(baselines.find(row => row.baseline === 'unchanged')!.metrics)).toEqual(expect.arrayContaining(['staleHits', 'completion']));
    expect(baselines.find(row => row.baseline === 'selected-context')!.metrics.totalContextTokens)
      .toBeLessThan(baselines.find(row => row.baseline === 'indexed')!.metrics.totalContextTokens);
    scenarios['held-out-baseline-quality-gates'] = 'pass';
    const nativeStartup = adapter.context.bootstrapTargets.length > 0;
    if (nativeStartup) await scenario('native-startup-copy-regeneration', async () => {
      for (const route of ['regenerate', 'workspace-context'] as const) {
        const nativeRoot = path.join(temp, route); fs.mkdirSync(nativeRoot);
        write(nativeRoot, '.aiwg/aiwg.config', JSON.stringify({ version: '1', providers: [adapter.providerId], installed: {}, scripts: {} }));
        // Migration emits every registry bootstrap target, including providers
        // whose deploy generator only refreshes the shared workspace document.
        await migrateWorkspaceContext(nativeRoot, { apply: true });
        // Same generator used by aiwg use; no framework deployment or network.
        await generate({ provider: adapter.providerId, projectPath: nativeRoot, sections: [] });
        const files = ['WORKSPACE.md', ...adapter.context.bootstrapTargets];
        const bytes = () => files.map(file => fs.readFileSync(path.join(nativeRoot, file), 'utf8'));
        const empty = bytes();
        expect(empty[0]).toContain(buildWorkspaceManagedBlock(nativeRoot));
        for (const text of empty.slice(1)) expect(text).toContain('WORKSPACE.md');
        const regenerate = async () => {
          if (route === 'regenerate') {
            const args = ['--workspace', '--provider', adapter.providerId];
            const result = await regenerateHandler.execute({ args, rawArgs: ['regenerate', ...args], cwd: nativeRoot, frameworkRoot: nativeRoot });
            expect(result.exitCode, result.message).toBe(0);
          } else await migrateWorkspaceContext(nativeRoot, { apply: true });
        };
        // Warm migration's existing formatting before the byte-for-byte baseline.
        await regenerate();
        const baseline = bytes();
        await regenerate(); expect(bytes()).toEqual(baseline);
        expect(await providerCopiesStatus(nativeRoot)).toMatchObject({ status: 'not-applicable' });
        const repository = new CanonicalContextRepository(nativeRoot);
        const proposal = { target: 'decision' as const, key: 'startup.fixture', value: 'Retained synthetic resident fact 3553.',
          sourceRef: 'decision.md', sourceDigest: null, reviewer: 'synthetic operator', reason: 'Reviewed fixture',
          scope: 'project', classification: 'internal' as const, reviewAt: null, expiresAt: null };
        repository.confirm({ preview: repository.previewUpsert(proposal), proposal });
        expect(await providerCopiesStatus(nativeRoot)).toMatchObject({ status: 'stale' });
        await regenerate();
        expect(bytes()[0]).toContain(proposal.value);
        expect(await providerCopiesStatus(nativeRoot)).toMatchObject({ status: 'current' });
        // Inject an explicit synthetic retrieval proof. The default CLI still
        // refuses canonical resident removal without an owner-native index.
        const canonical = new CanonicalMaintenanceOwner(nativeRoot, { verifyRetrieval: async () => true });
        for (const op of ['demote', 'promote', 'retire', 'restore', 'retire'] as const) {
          const record = (await canonical.records())[0];
          const input: MaintenancePlan = { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [{
            op, target: { id: record.id, digest: record.digest, version: record.version },
            precondition: { digest: record.digest, version: record.version },
            owner: { name: canonical.name, handle: record.aliases[0], snapshot: await canonical.snapshot() },
            review: { reviewer: 'synthetic operator', retirementBasis: 'review' },
            from: { placement: record.placement, lifecycle: record.lifecycle },
            to: { placement: op === 'demote' ? 'indexed' : op === 'promote' ? 'resident' : record.placement,
              lifecycle: op === 'retire' ? 'retired' : op === 'restore' ? 'active' : record.lifecycle },
            scope: record.scope, rationale: 'Reviewed fixture', uncertainty: 'No native live session evidence',
            impactedLinks: [], sessionEffect: 'next-session',
          }] };
          write(nativeRoot, 'plan.json', JSON.stringify(input));
          const before = bytes();
          await runMemoryMaintenanceCli('apply', ['--plan', 'plan.json', '--yes', '--json'], { root: nativeRoot, owners: [canonical] });
          expect(JSON.parse(String(output.mock.calls.at(-1)![0])).providerCopies)
            .toEqual({ status: 'stale', regenerate: 'aiwg regenerate --workspace --provider generic' });
          expect(bytes()).toEqual(before);
          await runMemoryMaintenanceCli('verify', ['--plan', 'plan.json', '--json'], { root: nativeRoot, owners: [canonical] });
          expect(JSON.parse(String(output.mock.calls.at(-1)![0])).providerCopies.status).toBe('stale');
          await regenerate();
          const present = ['promote', 'restore'].includes(op);
          const emitted = bytes();
          if (present) expect(emitted[0]).toContain(proposal.value);
          else expect(emitted[0]).not.toContain(proposal.value);
          for (const text of emitted.slice(1)) expect(text).not.toContain(proposal.value);
          await runMemoryMaintenanceCli('verify', ['--plan', 'plan.json', '--json'], { root: nativeRoot, owners: [canonical] });
          const report = JSON.parse(String(output.mock.calls.at(-1)![0]));
          expect(report.findings).toEqual([]);
          expect(report.providerCopies.status).toBe(present ? 'current' : 'not-applicable');
          if (!present) expect(bytes()).toEqual(baseline);
        }
      }
    });
    const report = {
      provider: id, adapter: adapter.providerId, disposition: row.disposition,
      deterministicFixture: { status: 'pass', scenarios }, commonFallback: { status: 'pass', path: 'aiwg memory + project artifact index (local)' },
      nativeLive: { status: 'not-run', command: adapter.providerId === 'codex' ? nativeCommand : null,
        limitation: row.disposition === 'inherited-common-fallback' ? 'Command probes the base adapter only; derived native behavior requires manual qualification'
          : adapter.providerId === 'codex' ? 'Explicit operator opt-in; existing rule-binding probes only, not live memory-task outcomes' : 'Existing rule-binding live transport supports Codex only; manual native qualification required' },
      opaqueManual: { limits: adapter.limits, support: adapter.context.support, diagnostic: adapter.diagnostic, sessionEffect: adapter.sessionEffect('retire'),
        providerRegeneration: nativeStartup ? 'qualified offline: startup adapters -> WORKSPACE.md resident projection; regenerate and workspace-context migration'
          : 'not-applicable: no project startup file produced by this path' },
      migrations: { kind: 'fixture lexical fallback; no native model or embedding execution', provider: `${id} -> ${adapter.providerId === 'generic' ? 'codex' : 'generic'}`, model: 'synthetic-model-v1 -> synthetic-model-v2', embedder: 'synthetic-embedder-v1 -> synthetic-embedder-v2', recall: migrationRecall },
      thresholds: config.thresholds, baselines,
    };
    const reportPath = path.join(temp, `${id}.json`); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toEqual(report);
    // Full reproducible evidence can be retained by redirecting stdout; temp reports are always cleaned.
    console.info(JSON.stringify(process.env.AIWG_MEMORY_QUALIFICATION_STDOUT === '1' ? report : {
      provider: id, fixture: 'pass', commonFallback: 'pass', nativeLive: report.nativeLive,
      baselines: baselines.map(({ baseline, metrics }) => ({ baseline, ...metrics })),
      report: 'Set AIWG_MEMORY_QUALIFICATION_STDOUT=1 for full evidence and operator command',
    }));
  });

  it('rejects smaller-file-only success and independently gates every quality and cost metric', async () => {
    const passing = { recall: 1, staleHits: 0, activation: 1, adherence: 1, completion: 1, sourceSurvival: 1, migrationRecall: 1, totalContextTokens: 10, simulatedLatencyMs: 1 };
    expect(gate(passing)).toEqual([]);
    for (const field of ['recall', 'activation', 'adherence', 'completion', 'sourceSurvival', 'migrationRecall'] as const) {
      expect(gate({ ...passing, totalContextTokens: 0, [field]: 0 })).toContain(field);
      expect(gate({ ...passing, [field]: Number.NaN })).toContain(field);
    }
    for (const field of ['staleHits', 'totalContextTokens', 'simulatedLatencyMs'] as const) expect(gate({ ...passing, [field]: 1e9 })).toContain(field);
    expect(gate({ ...passing, recall: 0.5 }, { ...config.thresholds, minimumRecall: 0.5 })).toEqual([]);
  });
});
