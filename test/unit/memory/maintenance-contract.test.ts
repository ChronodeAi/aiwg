import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  MaintenancePlanSchema, MaintenanceReceiptSchema, validateMaintenancePlan,
  type MaintenancePlan,
} from '../../../src/memory/maintenance-contract.js';
import {
  detectMemoryIncludeCycles, indexMemoryAliases, loadMemoryRecord,
  memoryRecordFromIntake, memoryRecordId, MemoryRecordSchema, MemoryTombstoneSchema,
  type MemoryRecord,
} from '../../../src/memory/maintenance-record.js';
import {
  MemoryTaxonomySchema, MemoryObservationSchema, transitionMemoryAxis,
  type MemoryAxes,
} from '../../../src/memory/taxonomy.js';
import { sha256 } from '../../../src/memory/context-pack.js';
import pin from '../../fixtures/memory-maintenance/rare-obligation-pin.json';
import chain from '../../fixtures/memory-maintenance/import-chain.json';
import cycle from '../../fixtures/memory-maintenance/transitive-include-cycle.json';
import collision from '../../fixtures/memory-maintenance/alias-collision.json';
import external from '../../fixtures/memory-maintenance/external-root.json';
import truncation from '../../fixtures/memory-maintenance/truncation.json';

const at = '2026-10-24T12:00:00.000Z';
function record(sourcePath = pin.sourcePath, content = pin.content): MemoryRecord {
  const digest = sha256(content);
  return {
    schemaVersion: 'aiwg.memory-record.v1',
    id: memoryRecordId(sourcePath, digest), sourcePath, digest, version: 1,
    aliases: [], supersedes: [], mergedFrom: [], splitFrom: [],
    scope: 'project', placement: 'indexed', lifecycle: 'active',
    authority: { owner: 'semantic-memory', source: 'import', protection: 'pinned' },
    observation: { status: 'on-disk', evidence: { source: 'synthetic-fixture', at, session: null, provider: null, version: null } },
  };
}
function plan(item = record()): MaintenancePlan {
  return {
    schemaVersion: 'aiwg.maintenance-plan.v1', operations: [{
      op: 'retire', target: { id: item.id, digest: item.digest, version: item.version },
      from: { placement: item.placement, lifecycle: item.lifecycle },
      to: { placement: item.placement, lifecycle: 'retired' },
      scope: item.scope, rationale: 'Age eligibility preview', uncertainty: 'No usage telemetry',
      impactedLinks: [], sessionEffect: 'next-session', precondition: { digest: item.digest, version: item.version },
    }],
  };
}

describe('independent memory taxonomy axes', () => {
  const alternatives: Array<[keyof MemoryAxes, MemoryAxes[keyof MemoryAxes]]> = [
    ['scope', 'global'], ['scope', 'provider-native'], ['scope', 'loaded/session'],
    ['placement', 'resident'], ['placement', 'task-context'], ['placement', 'archived'],
    ['lifecycle', 'superseded'], ['lifecycle', 'retired'], ['lifecycle', 'quarantined'], ['lifecycle', 'purged'],
    ['authority', { owner: 'operator', source: 'reviewer', protection: 'unprotected' }],
  ];
  it.each(alternatives)('changes only the %s axis to %j', (axis, value) => {
    const before = record();
    const snapshot = structuredClone(before);
    const after = transitionMemoryAxis(before, axis, value);
    expect(after[axis]).toEqual(value);
    for (const other of ['scope', 'placement', 'lifecycle', 'authority'] as const) {
      if (other !== axis) expect(after[other]).toEqual(before[other]);
    }
    expect(after.id).toBe(before.id);
    expect(before).toEqual(snapshot);
  });

  it('preserves proposed authority on promotion and does not infer demotion from imports', () => {
    const before = record();
    before.authority.source = 'generated-output-proposed';
    expect(transitionMemoryAxis(before, 'placement', 'resident').authority).toEqual(before.authority);
    expect(detectMemoryIncludeCycles(chain.graph)).toEqual([]);
    expect(before.placement).toBe('indexed');
  });

  it.each(['unknown', 'opaque', 'inaccessible', 'absent', 'on-disk', 'inferred'] as const)(
    'retains %s observations without fabricated session evidence', status => {
      const observation = { ...record().observation, status };
      expect(MemoryObservationSchema.parse(observation)).toEqual(observation);
    },
  );
  it('requires provider, session and version evidence for observed live context', () => {
    const observation = { ...record().observation, status: 'observed' };
    expect(MemoryObservationSchema.safeParse(observation).success).toBe(false);
    observation.evidence = { source: 'runtime-diagnostic', at, session: 'fixture-session', provider: 'claude', version: 'fixture-v1' };
    expect(MemoryObservationSchema.parse(observation)).toEqual(observation);
  });
});

describe('memory identity, compatibility and history contracts', () => {
  it('derives identity from both exact locator and intake-compatible digest, not mutable axes or revision', () => {
    const before = record();
    expect(record().id).toBe(before.id);
    expect(record(before.sourcePath, `${pin.content} revised`).id).not.toBe(before.id);
    expect(record('other.md').id).not.toBe(before.id);
    expect(loadMemoryRecord({ ...before, version: 2, placement: 'resident' }).id).toBe(before.id);
    expect(() => loadMemoryRecord({ ...before, digest: sha256('different') })).toThrow(/identity/);
  });
  it('keeps prior handles and compatibility names as aliases without rewriting originals', () => {
    const before = Object.freeze(record(collision.sourcePaths[0], collision.content));
    const after = { ...record(collision.sourcePaths[1], collision.content), aliases: [before.id, '.windsurf'], supersedes: [before.id] };
    const index = indexMemoryAliases([after]);
    expect(index.get(before.id)?.id).toBe(after.id);
    expect(index.get('.windsurf')?.id).toBe(after.id);
    expect(before.aliases).toEqual([]);
    expect(loadMemoryRecord(after).supersedes).toEqual([before.id]);
  });
  it('rejects ambiguous aliases and aliases that collide with canonical identities', () => {
    const first = { ...record(collision.sourcePaths[0]), aliases: [collision.alias] };
    const second = { ...record(collision.sourcePaths[1]), aliases: [collision.alias] };
    expect(() => indexMemoryAliases([first, second])).toThrow(/alias collision/);
    expect(() => indexMemoryAliases([first, { ...second, aliases: [first.id] }])).toThrow(/alias collision/);
    expect(() => loadMemoryRecord({ ...first, aliases: [first.id] })).toThrow(/alias itself/);
  });
  it('retains canonical history when a successor carries a prior id as a lineage alias', () => {
    const original = Object.freeze({ ...record('original.md'), lifecycle: 'superseded' as const });
    const successor = { ...record('successor.md'), aliases: [original.id, 'compatibility-name'], supersedes: [original.id] };
    for (const records of [[original, successor], [successor, original]]) {
      const index = indexMemoryAliases(records);
      expect(index.get(original.id)).toEqual(original);
      expect(index.get('compatibility-name')).toEqual(successor);
      expect(validateMaintenancePlan(plan(successor), records, { retirementBasis: 'review' })).toEqual(plan(successor));
    }
    expect(original.lifecycle).toBe('superseded');
  });
  it('retains immutable merge and split lineage handles', () => {
    const first = record('first.md');
    const second = record('second.md');
    const merged = loadMemoryRecord({ ...record('merged.md'), mergedFrom: [first.id, second.id] });
    const split = loadMemoryRecord({ ...record('split.md'), splitFrom: [merged.id] });
    expect(merged.mergedFrom).toEqual([first.id, second.id]);
    expect(split.splitFrom).toEqual([merged.id]);
    expect(first.lifecycle).toBe('active');
  });
  it('records an external workspace locator without resolving or reading it', () => {
    const item = loadMemoryRecord({ ...record(external.sourcePath, external.content), scope: external.scope, sourceWorkspaceId: external.sourceWorkspaceId });
    expect(item.sourcePath).toBe(external.sourcePath);
    expect(() => validateMaintenancePlan({ ...plan(item), operations: [{ ...plan(item).operations[0], scope: 'project' }] }, [item])).toThrow(/scope/);
  });
  it('requires matching owner tombstones for retirement and retains successor history', () => {
    const item = record();
    const tombstone = { id: item.id, digest: item.digest, disposition: 'retired', reason: 'Reviewed replacement', reviewer: 'fixture-reviewer', at, successor: 'lm_fixture-successor' };
    expect(MemoryTombstoneSchema.parse(tombstone)).toEqual(tombstone);
    expect(loadMemoryRecord({ ...item, lifecycle: 'retired', tombstone }).tombstone).toEqual(tombstone);
    expect(() => loadMemoryRecord({ ...item, lifecycle: 'retired' })).toThrow(/tombstone/);
    expect(() => loadMemoryRecord({ ...item, lifecycle: 'retired', tombstone: { ...tombstone, digest: sha256('stale') } })).toThrow(/tombstone/);
  });
  it('projects an existing intake receipt to v1 indexed metadata without promoting knowledge', () => {
    const receipt = {
      schemaVersion: 'aiwg.compound-memory.intake-receipt.v1' as const,
      receiptId: 'fixture-intake-id', operationId: sha256('preview'), sourceLocator: pin.sourcePath,
      sourceDigest: sha256(pin.content), rawLocator: 'raw/fixture.md', route: 'llm-wiki' as const,
      duplicate: false, registeredAt: at,
    };
    const migrated = memoryRecordFromIntake(receipt, 'llm-wiki');
    expect(migrated).toMatchObject({ scope: 'project', placement: 'indexed', lifecycle: 'active', aliases: [receipt.receiptId], digest: receipt.sourceDigest, authority: { source: 'import' } });
    expect(migrated.id).toBe(record().id);
    expect(() => memoryRecordFromIntake({ ...receipt, schemaVersion: 'future' } as never, 'llm-wiki')).toThrow(/version/);
  });
  it('detects a transitive include cycle while permitting shared imports and missing leaves', () => {
    expect(detectMemoryIncludeCycles(cycle.graph)).toEqual(cycle.expectedCycles);
    expect(detectMemoryIncludeCycles(chain.graph)).toEqual([]);
    expect(detectMemoryIncludeCycles({ a: ['a'], b: ['missing'] })).toEqual([['a', 'a']]);
    expect(detectMemoryIncludeCycles({ a: ['constructor', 'toString', '__proto__'] })).toEqual([]);
  });
  it('keeps durable and injected fixture content separate at truncation boundaries', () => {
    expect(truncation.durableText.startsWith(truncation.injectedText)).toBe(true);
    expect(truncation.durableText.length).toBeGreaterThan(truncation.injectedText.length);
    const item = record('bootstrap.md', truncation.durableText);
    expect(item.observation.status).toBe('on-disk');
    expect(item.digest).not.toBe(sha256(truncation.injectedText));
  });
});

describe('maintenance preview validation', () => {
  it('rejects age retirement of a pinned rare obligation regardless of old use date', () => {
    expect(pin.lastUsedAt < at).toBe(true);
    expect(() => validateMaintenancePlan(plan(), [record()])).toThrow(/Pinned/);
    expect(() => validateMaintenancePlan(plan(), [record()], { retirementBasis: 'age' })).toThrow(/Pinned/);
    expect(validateMaintenancePlan(plan(), [record()], { retirementBasis: 'review' })).toEqual(plan());
  });
  it('permits an unprotected retirement preview without mutating source metadata', () => {
    const item = record();
    item.authority.protection = 'unprotected';
    const before = structuredClone(item);
    expect(validateMaintenancePlan(plan(item), [item])).toEqual(plan(item));
    expect(item).toEqual(before);
  });
  it.each(['digest', 'version'] as const)('rejects stale %s even when target agrees with precondition', field => {
    const preview = plan();
    const stale = field === 'digest' ? { digest: sha256('stale') } : { version: 2 };
    Object.assign(preview.operations[0].target, stale);
    Object.assign(preview.operations[0].precondition, stale);
    expect(() => validateMaintenancePlan(preview, [record()])).toThrow(/Stale/);
  });
  it('rejects target/precondition disagreement, changed state, scope drift and hidden authority changes', () => {
    const preview = plan();
    preview.operations[0].target.version = 2;
    expect(MaintenancePlanSchema.safeParse(preview).success).toBe(false);
    const changed = plan();
    changed.operations[0].from.placement = 'resident';
    changed.operations[0].to.placement = 'resident';
    expect(() => validateMaintenancePlan(changed, [record()])).toThrow(/Stale/);
    const drift = plan();
    drift.operations[0].scope = 'global';
    expect(() => validateMaintenancePlan(drift, [record()])).toThrow(/scope/);
    const hidden = plan();
    Object.assign(hidden.operations[0], { authority: { source: 'operator' } });
    expect(MaintenancePlanSchema.safeParse(hidden).success).toBe(false);
  });
  it('refuses implicit second-axis changes, purge operations and source purging through retire', () => {
    const preview = plan();
    preview.operations[0].to.placement = 'archived';
    expect(MaintenancePlanSchema.safeParse(preview).success).toBe(false);
    expect(MaintenancePlanSchema.safeParse({ ...plan(), operations: [{ ...plan().operations[0], op: 'purge' }] }).success).toBe(false);
    expect(MaintenancePlanSchema.safeParse({ ...plan(), operations: [{ ...plan().operations[0], to: { placement: 'indexed', lifecycle: 'purged' } }] }).success).toBe(false);
  });
  it('rejects missing and duplicate targets, including two aliases of one revision', () => {
    const item = { ...record(), aliases: ['legacy'] };
    expect(() => validateMaintenancePlan(plan(), [])).toThrow(/missing/);
    const preview = plan();
    preview.operations.push({ ...preview.operations[0], target: { ...preview.operations[0].target, id: 'legacy' } });
    expect(() => validateMaintenancePlan(preview, [item], { retirementBasis: 'review' })).toThrow(/Multiple/);
  });
});

describe('strict versioned JSON and runtime schemas', () => {
  const require = createRequire(import.meta.url);
  const { default: Ajv2020 } = require('ajv/dist/2020.js');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const names = ['memory-taxonomy', 'memory-record', 'maintenance-plan', 'maintenance-receipt'];
  const schemas = names.map(name => JSON.parse(readFileSync(new URL(`../../../schemas/memory/${name}.v1.schema.json`, import.meta.url), 'utf8')));
  for (const schema of schemas) ajv.addSchema(schema);
  const item = record();
  const { id: _id, sourcePath: _path, digest: _digest, version: _version, aliases: _aliases, supersedes: _supersedes, mergedFrom: _merged, splitFrom: _split, ...axes } = item;
  const taxonomy = { ...axes, schemaVersion: 'aiwg.memory-taxonomy.v1' };
  const cases = [
    { name: names[0], schema: schemas[0], runtime: MemoryTaxonomySchema, value: taxonomy },
    { name: names[1], schema: schemas[1], runtime: MemoryRecordSchema, value: item },
    { name: names[2], schema: schemas[2], runtime: MaintenancePlanSchema, value: plan() },
    { name: names[3], schema: schemas[3], runtime: MaintenanceReceiptSchema, value: { schemaVersion: 'aiwg.maintenance-receipt.v1', planDigest: sha256(JSON.stringify(plan())), ownerReceipts: [{ schemaVersion: 'owner-receipt.v1' }], partial: { completed: ['one'], pending: ['two'] }, resumedFrom: 'prior-journal' } },
  ];
  it.each(cases)('strictly validates $name and refuses unknown versions and extra fields', ({ schema, runtime, value }) => {
    const validate = ajv.getSchema(schema.$id)!;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(runtime.safeParse(value).success).toBe(true);
    for (const schemaVersion of ['v0', 'v2', undefined]) {
      const invalid = { ...value, schemaVersion };
      expect(validate(invalid)).toBe(false);
      expect(runtime.safeParse(invalid).success).toBe(false);
    }
    expect(validate({ ...value, unrecognized: true })).toBe(false);
    expect(runtime.safeParse({ ...value, unrecognized: true }).success).toBe(false);
  });
  it('refuses unversioned and future records instead of guessing a migration', () => {
    expect(() => loadMemoryRecord({ ...item, schemaVersion: 'aiwg.memory-record.v2' })).toThrow();
    expect(() => loadMemoryRecord({ ...item, schemaVersion: undefined })).toThrow();
  });
});
