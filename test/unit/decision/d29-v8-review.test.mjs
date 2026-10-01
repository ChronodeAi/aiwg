import { beforeAll, describe, expect, it } from 'vitest';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { prepareV7, buildReport } from '../../../tools/decision/studies/d29.mjs';

/**
 * Ported reviewer probes for the D29 v8 review fixes (refs #2622).
 * Every probe raises the preregistered ceiling to PROMOTE: only a perfect
 * run may promote, and every native fail/insufficient verdict must hold at
 * least HOLD at the binding level. Dates sit after the v8 binding freeze so
 * the freeze seal is never the reason a probe holds.
 */
let prepared;
beforeAll(async () => {
  prepared = await prepareV7('d29-study-v7');
}, 30000);

const FIRST_ACCESS = '2026-10-02T00:00:00.000Z';
const EVALUATED_AT = '2026-10-03T00:00:00.000Z';
const projectWith = config => {
  const root = mkdtempSync(join(tmpdir(), 'd29-v8-project-'));
  mkdirSync(join(root, '.aiwg'), { recursive: true });
  writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify(config));
  return root;
};
const PROJECT_ROOT = projectWith({});

const integrity = () => ({ sample_n: 1500, uncertainty: { method: 'wilson', levelBps: 9500 }, paired_baseline: { n: 1500 },
  integrity_mode: 'locked', fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'verified',
  trusted_score_source: 'locked-artifact-snapshot', compromise_labels: [], weak_signal_reason: null,
  release_gate: { decision: 'PROMOTE', reasons: [] } });

const samplesOf = (mut = sample => sample) => prepared.corpus.rows.filter(row => row.split === 'test').map(row => {
  const { gold } = prepared.gold.rows.find(item => item.id === row.id);
  return mut({ id: row.id, kind: row.input.payload.kind, slice: row.slice, gold,
    candidate: { route: gold.ready ? 'ADVISORY_READY' : 'REVIEW', support: gold.support, readyProbability: gold.ready ? 0.95 : 0.05,
      latencyMs: 4, inputTokens: 10, outputTokens: 2, costUsd: 0.001, calls: 1, retries: 0, fallbacks: 0 },
    baseline: { correct: true, costUsd: 0 }, reviewer: null });
});

function run({ ceiling = 'PROMOTE', mutate, heldoutMut = heldout => heldout, gate = {}, analysisMut = analysis => analysis } = {}) {
  const analysis = structuredClone(prepared.analysis);
  analysis.gateBinding.spec.ceiling = ceiling;
  analysisMut(analysis);
  const heldout = heldoutMut({ schemaVersion: 'decision-sdlc-screening-heldout-records/v1', evaluatedAt: EVALUATED_AT,
    splits: analysis.splits, samples: samplesOf(mutate) });
  const metadata = integrity();
  return buildReport({ analysis, trustedAnalysisDigest: heldoutDigest(analysis), heldout, integrity: metadata,
    trustedIntegrityDigest: heldoutDigest(metadata), nowEpochMs: Date.parse(EVALUATED_AT),
    firstTestAccessAt: FIRST_ACCESS, calibrationAttestation: { id: 'staged-calibration-artifact', passed: true },
    projectRoot: PROJECT_ROOT, ...gate });
}

const atLeastHold = report => expect(['HOLD', 'ROLLBACK'], `decision ${report.decision}`).toContain(report.decision);

describe('D29 v8 reviewer probes (ceiling raised to PROMOTE)', () => {
  it('promotes a perfect run and caps it at the preregistered HOLD ceiling', () => {
    expect(run().decision).toBe('PROMOTE');
    const analysis = structuredClone(prepared.analysis);
    expect(analysis.gateBinding.spec.ceiling).toBe('HOLD');
    expect(run({ ceiling: 'HOLD' }).decision).toBe('HOLD');
  });

  it('rolls back a single false-ready event on a blocking slice', () => {
    let fired = false;
    const result = run({ mutate: sample => (sample.slice === 'missing-artifact' && !fired
      ? (fired = true, { ...sample, candidate: { ...sample.candidate, route: 'ADVISORY_READY' } }) : sample) });
    expect(result.decision).toBe('ROLLBACK');
  });

  it('holds a split digest mismatch instead of promoting the native failure', () => {
    const result = run({ heldoutMut: heldout => ({ ...heldout,
      splits: heldout.splits.map(split => (split.name === 'test' ? { ...split, digest: `sha256:${'0'.repeat(64)}` } : split)) }) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    expect(result.native.reasons.some(reason => reason === 'heldout-split-mismatch' || reason === 'heldout-records-invalid')).toBe(true);
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'heldout-split'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(result);
  });

  it('holds an evaluation timestamp in the future instead of promoting it', () => {
    const result = run({ heldoutMut: heldout => ({ ...heldout, evaluatedAt: '2027-01-01T00:00:00.000Z' }) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    expect(result.native.reasons).toContain('heldout-evaluated-in-future');
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'heldout-evaluated-at'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(result);
  });

  it('holds an evaluation timestamp before the freeze instead of promoting it', () => {
    const result = run({ heldoutMut: heldout => ({ ...heldout, evaluatedAt: '2026-09-01T00:00:00.000Z' }) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    expect(result.native.reasons).toContain('heldout-not-after-preregistration');
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'heldout-evaluated-at'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(result);
  });

  it('holds a mutated unregistered slice instead of promoting it', () => {
    let fired = false;
    const result = run({ mutate: sample => (sample.slice === 'failed-test' && !fired
      ? (fired = true, { ...sample, slice: 'bogus-slice' }) : sample) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    expect(result.native.reasons.some(reason => reason.startsWith('heldout-slice-unregistered'))).toBe(true);
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'heldout-slices-registered'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(result);
  });

  it('holds an appended unregistered slice instead of promoting it', () => {
    const result = run({ heldoutMut: heldout => ({ ...heldout,
      samples: [...heldout.samples, { ...heldout.samples[0], id: 'zz-bogus', slice: 'bogus-slice' }] }) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'heldout-slices-registered'))
      .toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(result);
  });

  it('holds thin per-class support through the class-support gate', () => {
    const kept = run({ heldoutMut: heldout => ({ ...heldout,
      samples: heldout.samples.filter(sample => sample.gold.support !== 'unclear') }) });
    // Dropping records withholds the native measured report; the held-out
    // record itself still carries thin unclear support, which the pack gate refuses.
    expect(kept.native.heldout).toBeNull();
    expect(kept.native.reasons).toContain('heldout-records-invalid');
    const unclear = kept.gateReport.gateEvidence.find(entry => entry.gateId === 'class-support-minimum');
    expect(unclear, 'class-support gate evidence').toMatchObject({ status: 'fail', outcome: 'HOLD' });
    atLeastHold(kept);
  });

  it('holds a shortfall in total support instead of promoting it', () => {
    const result = run({ heldoutMut: heldout => ({ ...heldout, samples: heldout.samples.filter((_, i) => i % 2) }) });
    expect(result.native.preregisteredDecision).not.toBe('pass');
    atLeastHold(result);
  });

  it('refuses any caller-supplied floors, including an opt-out or a looser floors object', () => {
    expect(run().decision).toBe('PROMOTE');
    expect(() => run({ gate: { floors: 'none-explicit-opt-out' } })).toThrow(/project-floors-caller-supplied/);
    expect(() => run({ gate: { floors: resolveProjectFloors({}) } })).toThrow(/project-floors-caller-supplied/);
    expect(() => run({ gate: { floors: undefined } })).toThrow(/project-floors-caller-supplied/);
  });

  it('applies the project HOLD ceiling from aiwg.config and cannot be loosened by the caller', () => {
    const projectRoot = projectWith({ gates: { ceilings: { '*': 'HOLD' } } });
    expect(() => run({ gate: { projectRoot } })).toThrow();
    expect(() => run({ gate: { projectRoot, floors: { floors: [], ceilings: {} } } })).toThrow(/project-floors-caller-supplied/);
  });

  it('requires an explicit project root and refuses a missing config on the scoring path', () => {
    expect(() => run({ gate: { projectRoot: undefined } })).toThrow(/project-root-missing/);
    const empty = mkdtempSync(join(tmpdir(), 'd29-v8-noconfig-'));
    expect(() => run({ gate: { projectRoot: empty, requireProjectConfig: true } })).toThrow(/project-floors-missing/);
  });

  it('holds a missing staged-calibration attestation while every other gate passes', () => {
    const result = run({ gate: { calibrationAttestation: null } });
    expect(result.decision).toBe('HOLD');
    expect(result.gateReport.gateEvidence.find(entry => entry.gateId === 'calibration-artifact'))
      .toMatchObject({ status: 'insufficient', outcome: 'HOLD' });
  });

  it('rolls back compromised integrity through the ceiling with no bespoke override', () => {
    const analysis = structuredClone(prepared.analysis);
    analysis.gateBinding.spec.ceiling = 'PROMOTE';
    const metadata = integrity();
    metadata.integrity_state = 'compromised';
    metadata.release_gate = { decision: 'PROMOTE', reasons: [] };
    const heldout = { schemaVersion: 'decision-sdlc-screening-heldout-records/v1', evaluatedAt: EVALUATED_AT,
      splits: analysis.splits, samples: samplesOf() };
    const result = buildReport({ analysis, trustedAnalysisDigest: heldoutDigest(analysis), heldout,
      integrity: metadata, trustedIntegrityDigest: heldoutDigest(metadata), nowEpochMs: Date.parse(EVALUATED_AT),
      firstTestAccessAt: FIRST_ACCESS, calibrationAttestation: { id: 'staged-calibration-artifact', passed: true },
      projectRoot: PROJECT_ROOT });
    expect(result.decision).toBe('ROLLBACK');
  });

  it('refuses a forged upstream integrity record instead of promoting it', () => {
    const analysis = structuredClone(prepared.analysis);
    analysis.gateBinding.spec.ceiling = 'PROMOTE';
    const metadata = integrity();
    expect(() => buildReport({ analysis, trustedAnalysisDigest: heldoutDigest(analysis), heldout: null,
      integrity: { ...metadata, integrity_state: 'compromised' }, trustedIntegrityDigest: heldoutDigest(metadata),
      nowEpochMs: Date.parse(EVALUATED_AT), firstTestAccessAt: FIRST_ACCESS,
      calibrationAttestation: { id: 'staged-calibration-artifact', passed: true }, projectRoot: PROJECT_ROOT }))
      .toThrow(/digest does not match|report-anchor/);
  });
});

describe('D29 approval gate-binding pins', () => {
  it('pins the binding digest and pack digests explicitly on the approval', async () => {
    const { artifactDigest } = await import('../../../src/decision/validate.js');
    expect(prepared.approval.gateBindingDigest).toBe(artifactDigest(prepared.analysis.gateBinding));
    expect(prepared.approval.gateBindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.approval.gatePackDigests).toEqual(prepared.analysis.gateBinding.spec.packs.map(pack => ({
      id: pack.id, version: pack.version, digest: pack.digest, resolvedDigest: pack.resolvedDigest })));
    expect(prepared.approval.preregistrationDigest).toBe(heldoutDigest(prepared.preregistration));
    const { readFileSync } = await import('node:fs');
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../../schemas/decision/HeldoutApproval.v1.schema.json', import.meta.url), 'utf8')));
    validate(prepared.approval);
    expect((validate.errors ?? []).filter(error => error.params?.additionalProperty === 'gateBindingDigest'
      || error.params?.additionalProperty === 'gatePackDigests')).toEqual([]);
  });

  it('loads project floors from aiwg.config and fails closed on invalid sections', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadD29ProjectFloors } = await import('../../../tools/decision/studies/d29.mjs');
    expect(() => loadD29ProjectFloors()).toThrow('project-root-missing');
    const empty = mkdtempSync(join(tmpdir(), 'd29-floors-empty-'));
    expect(loadD29ProjectFloors(empty)).toEqual({ floors: [], ceilings: {} });
    expect(() => loadD29ProjectFloors(empty, { requireConfig: true })).toThrow('project-floors-missing');
    const configured = mkdtempSync(join(tmpdir(), 'd29-floors-set-'));
    mkdirSync(join(configured, '.aiwg'), { recursive: true });
    writeFileSync(join(configured, '.aiwg', 'aiwg.config'), JSON.stringify({ gates: { ceilings: { '*': 'HOLD' } } }));
    expect(loadD29ProjectFloors(configured)).toEqual({ floors: [], ceilings: { '*': 'HOLD' } });
    const invalid = mkdtempSync(join(tmpdir(), 'd29-floors-bad-'));
    mkdirSync(join(invalid, '.aiwg'), { recursive: true });
    writeFileSync(join(invalid, '.aiwg', 'aiwg.config'), JSON.stringify({ gates: { ceilings: { '*': 'MAYBE' } } }));
    expect(() => loadD29ProjectFloors(invalid)).toThrow('project-floors-invalid');
    const unreadable = mkdtempSync(join(tmpdir(), 'd29-floors-raw-'));
    mkdirSync(join(unreadable, '.aiwg'), { recursive: true });
    writeFileSync(join(unreadable, '.aiwg', 'aiwg.config'), '{oops');
    expect(() => loadD29ProjectFloors(unreadable)).toThrow('project-floors-unreadable');
  });
});

describe('D29 per-generator digest pins (one family per study)', () => {
  it('pins D29 generator/renderer bytes separately from the D17 study bytes', async () => {
    const { heldoutGeneratorDigest, heldoutGeneratorFiles } = await import('../../../src/decision/heldout/generators.js');
    const { D29_V7_GENERATOR_ID } = await import('../../../src/decision/heldout/d29-v7.js');
    const v6 = heldoutGeneratorDigest('d29-synthetic/v6');
    expect(heldoutGeneratorDigest(D29_V7_GENERATOR_ID), 'v6 and v7 share the D29 family pin').toBe(v6);
    const d17 = heldoutGeneratorDigest('d17-entailment/v1');
    expect(d17, 'D17 pins only its own bytes').not.toBe(v6);
    const d29Files = heldoutGeneratorFiles('d29-synthetic/v6');
    const d17Files = heldoutGeneratorFiles('d17-entailment/v1');
    expect(d29Files.some(file => file.includes('ensemble-study')), 'D29 file list').toBe(false);
    expect(d17Files.some(file => file.includes('heldout/d29')), 'D17 file list').toBe(false);
    expect(new Set([...d29Files, ...d17Files]).size).toBe(d29Files.length + d17Files.length);
    expect([...d29Files, ...d17Files].every(file => file.endsWith('.ts')), 'source bytes only, no built fallback').toBe(true);
    expect(() => heldoutGeneratorDigest('no-such-generator/v1')).toThrow();
  });
});

describe('D29 v7 dataset freeze (drift guard vs 9d30ab348)', () => {
  const pins = {
    v6: { rows: 'sha256:deded25fc5e5c6e1a6eab014f32b69e8220476da63f06264b8452bae62ec9125',
      defs: 'sha256:d496e0bb69816c57194aea2eeebaa469caebcc7ce9c64826bfc302c7a5a5745a',
      gold: 'sha256:cc96a3359b53cab0b20d083fb9fba11ac8fd6d3c7e06c4e943e3b9925536443e',
      dev: 'sha256:01053b4d438da106c9ec35b9b67c04f92bcb5b964f43ce81b27450d5352839cb',
      reviews: 'sha256:95799cc104a4996187be943be7dd004fa7194c8f7decd2dcab9e8cbe026abf5c',
      splits: ['sha256:dd69fd8d48fcc3ff4217cb772395e5a0092a8819875b025098c5f74520524292',
        'sha256:24b43c00ef7b4a47343ea948f57e8a97749923e220e544330949eb0adcb8f26c',
        'sha256:a1b792d1194fc8bc77187d9e24984a03e846a18b5853dcbcbd77f439cc690c35'] },
    v7: { rows: 'sha256:56af2aba9bd732714328e44505a3068f58439b56ae1eb1b8923c4f22f8a783c4',
      defs: 'sha256:d496e0bb69816c57194aea2eeebaa469caebcc7ce9c64826bfc302c7a5a5745a',
      gold: 'sha256:b175f64db211e5710c3fff11efa479f4797cf631a96913f3a65da366bd70044e',
      dev: 'sha256:1f425e5ba21bb09f062e50792c27c03220574df0a01c04416af70ebe83bae26f',
      reviews: 'sha256:30a337848aa612c3e79ff1fbd131750d0569f0e3f2032ac18000c27ce815e5c8',
      splits: ['sha256:396b5ab3f9f364f704623df45bc6b5c69515c5d0c9aa4c50213d27d3f14ba0a3',
        'sha256:8923ec6bbb2bc394e102d616d1233527c08c04cd4683aa020bfabfd5eb04ce6a',
        'sha256:9214cee6603dcba1b867e862b6a2710234943b1ef5b08c00f0cf3d9d0f34bbdf'] },
  };
  it('regenerates v7 rows, gold, splits and dev-review ids byte-identically', async () => {
    const { prepare } = await import('../../../tools/decision/studies/d29.mjs');
    for (const [name, seed, prepareFn] of [['v6', 'd29-study-v6', prepare], ['v7', 'd29-study-v7', prepareV7]]) {
      const study = await prepareFn(seed);
      const expected = pins[name];
      expect(heldoutDigest(study.corpus.rows), `${name} rows`).toBe(expected.rows);
      expect(heldoutDigest(study.corpus.definitions), `${name} defs`).toBe(expected.defs);
      expect(heldoutDigest(study.gold), `${name} gold`).toBe(expected.gold);
      const dev = study.reviews.assessments.filter(item => item.phase === 'development').map(item => item.id);
      expect(dev).toHaveLength(50);
      expect(heldoutDigest(dev), `${name} dev`).toBe(expected.dev);
      expect(heldoutDigest(study.reviews.assessments.map(item => [item.phase, item.id])), `${name} reviews`).toBe(expected.reviews);
      expect(study.analysis.splits.map(split => split.digest), `${name} splits`).toEqual(expected.splits);
      expect(study.corpus.rows.filter(row => row.split === 'test')).toHaveLength(1500);
    }
  }, 120_000);
});
