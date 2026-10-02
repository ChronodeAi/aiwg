import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepare, runBundle, runDevReviewMaterial } from '../../../tools/decision/d17-multifact.mjs';
import { prepare as prepareD17 } from '../../../tools/decision/d17-study.mjs';
import { collectHeldoutStudy, scoreHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { heldoutDigest, heldoutExecutionDigest, validateHeldoutBundle, validateHeldoutInputs } from '../../../src/decision/heldout/contract.js';
import { heldoutEvidenceDigest, heldoutRunsRoot, readHeldoutJournal } from '../../../src/decision/heldout/journal.js';
import { registeredHeldoutGeneratorDigest } from '../../../src/decision/heldout/generator-registry.js';
import { D17_MULTIFACT_CALIBRATION_NOT_AFTER, D17_MULTIFACT_GENERATOR_ID, generateStudyHeldoutRow, studyHeldoutGeneratorDigest } from '../../../src/decision/heldout/study-generators.js';
import { readHeldoutFrozen } from '../../../src/decision/heldout/calibration.js';
import type { HeldoutAttempt, HeldoutBundle } from '../../../src/decision/heldout/types.js';
import { calibrationArtifactDigest } from '../../../src/decision/calibration/registry.js';
import type { CalibrationArtifact } from '../../../src/decision/calibration/types.js';
import { fitD17Isotonic } from '../../../src/decision/ensemble-study/calibration.js';
import { createHash, randomBytes } from 'node:crypto';
import { D17_CALIBRATION } from '../../../src/decision/ensemble-study/protocol.js';
import { D17MF_CELLS, D17MF_POOLS, D17MF_POOL_IDS, D17MF_ROWS, cellKey, d17MfGenerateCase, d17MfTextOracle } from '../../../src/decision/ensemble-study/multifact.js';
import { D17MF_BUDGET, D17MF_PROTOCOL, assertD17MultifactPrivateSeed, auroc, d17MultifactDevReviewMaterial, d17MultifactFit, d17MultifactFreshAllowance, d17MultifactPlan, d17MultifactShortcutAudit,
  d17MultifactCollectionEnd, holmAdjust, newcombeDifference, scoreD17Multifact, twoProportionP, validateD17MultifactReview } from '../../../src/decision/ensemble-study/multifact-study.js';
import { assertD17ReviewBoundToApproval } from '../../../src/decision/ensemble-study/calibration.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';

const preflight = vi.hoisted(() => ({ canonical: '' }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => {
  const module = await original<typeof import('../../../src/decision/context-live-qualification.js')>();
  return { ...module, assertContextLiveSource: vi.fn(async () => {}),
    assertContextArtifactRoot: vi.fn(async (_source: string, root: string, mode = 'exact') => {
      if (mode === 'exact' ? root !== preflight.canonical : !root.startsWith(preflight.canonical)) throw new Error('root');
    }) };
});
// Entry admission measures a 1 s wall-clock budget; freeze only performance.now() for the whole file, preparation included.
beforeAll(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
afterAll(() => { vi.useRealTimers(); });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pin = heldoutDigest('d17-multifact-offline');
type Prepared = Awaited<ReturnType<typeof prepare>>;
let prepared: Prepared;
beforeAll(async () => { prepared = await prepare('d17mf-offline'); }, 120_000);

async function root() { const dir = await mkdtemp(join(tmpdir(), 'd17-multifact-')); dirs.push(dir); preflight.canonical = dir; return dir; }
function reply(init?: RequestInit, yes = 0.9) {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
    { type: 'choice', choice: yes >= 0.5 ? 'yes' : 'no', confidence: Math.max(yes, 1 - yes), probabilities: { yes, no: 1 - yes } }])),
    usage: { input_tokens: 20, output_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
}
function approval(bundle: Pick<HeldoutBundle, 'corpus' | 'preregistration'>, runId: string, calibrationArtifactDigest: string, approvalReference = 'fixture-only') {
  const value = { ...structuredClone(prepared.approvalTemplate), approved: true, runId, reviewer: 'fixture-reviewer', approvalReference,
    sourceCommit: 'a'.repeat(40), exactHeadCi: 'fixture-ci', stagingWorkspace: 'fixture-workspace', region: 'fixture-region',
    credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin, corpusDigest: heldoutDigest(bundle.corpus),
    preregistrationDigest: heldoutDigest(bundle.preregistration), executionDigest: pin, calibration: { mode: 'artifact', calibrationArtifactDigest },
    providerTermsReference: 'fixture-synthetic-only', priceBound: { ...prepared.approvalTemplate.priceBound, approvalReference: 'fixture-attestation' },
    priorStudySpendUsd: 0.892652, priorPortfolioSpendUsd: 2.192652 } as unknown as HeldoutBundle['approval'];
  value.executionDigest = heldoutExecutionDigest(bundle.corpus, bundle.preregistration, value);
  return value;
}
function review(reviewedAt = '2026-10-02T00:00:00Z') {
  const value = structuredClone(prepared.reviewTemplate) as any;
  Object.assign(value, { reviewer: 'fixture-reviewer', preregistrationReview: 'fixture review of the D17-MF preregistration' });
  for (const item of value.assessments) Object.assign(item, { reviewedAt, goldAuditLabel: prepared.gold.labels[item.rowId],
    goldAmbiguousOrIncorrect: false, rationale: 'fixture: the facts and rule decide the label' });
  return value;
}

describe('D17-MF generator', () => {
  it('allocates the preregistered factorial cells and the text oracle reproduces every gold label', () => {
    expect(D17MF_ROWS).toBe(5778);
    const test = D17MF_CELLS.filter(c => c.split === 'test');
    expect(test.filter(c => c.outcome.startsWith('missing') && c.layout === 'equalized').every(c => c.count === 220)).toBe(true);
    expect(test.filter(c => c.layout === 'equalized')).toHaveLength(33);
    expect(test.filter(c => c.outcome === 'missing-absence').map(c => c.hops)).toEqual([3, 3, 3]);
    expect(test.filter(c => c.layout === 'd17-faithful').map(c => c.count)).toEqual([30, 30, 30, 30, 30, 30]);
    const counts = new Map<string, number>();
    for (const row of prepared.corpus.rows) {
      expect(d17MfTextOracle(String(row.input.payload))).toBe(prepared.gold.labels[row.id]);
      counts.set(`${row.split}:${row.slice}`, (counts.get(`${row.split}:${row.slice}`) ?? 0) + 1);
    }
    for (const cell of D17MF_CELLS) expect(counts.get(`${cell.split}:${cellKey(cell)}`)).toBe(cell.count);
    // Deterministic: regeneration from the row seed is byte-identical.
    const row = prepared.corpus.rows[1234]!;
    expect(heldoutDigest(d17MfGenerateCase(row.provenance.seed).row)).toBe(row.provenance.outputDigest);
    // Absence breaks an interior link only; equalized rules are exhaustive and link-only; names have distinct two-letter prefixes.
    for (const r of prepared.corpus.rows) {
      const world = prepared.gold.worlds[r.id]!, payload = String(r.input.payload);
      if (world.outcome === 'missing-absence') expect([1, 2]).toContain(world.failurePosition);
      if (world.layout === 'equalized') {
        expect(payload).toContain('; no other relation counts.');
        const names = [...new Set(payload.match(/\b[A-Z][a-z]\d{3}\b/g))];
        expect(new Set(names.map(n => n.slice(0, 2))).size).toBe(names.length);
      }
    }
  });
  it('keeps pools disjoint, paired words length-matched and cue counts independent of the label', () => {
    const words = D17MF_POOL_IDS.map(id => { const p = D17MF_POOLS[id]; return [p.relation, p.base, p.contrastive, p.unrelated, p.enabled, p.disabled]; });
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) expect(words[i]!.filter(w => words[j]!.includes(w))).toEqual([]);
    for (const id of D17MF_POOL_IDS) {
      const p = D17MF_POOLS[id];
      expect(new Set([p.relation.length, p.contrastive.length, p.unrelated.length]).size).toBe(1);
      // The non-connective verb shares no letter position with the contrastive verb except a final "s".
      expect([...p.unrelated.slice(0, -1)].filter((ch, i) => p.contrastive[i] === ch)).toEqual([]);
      expect(p.enabled.length).toBe(p.disabled.length);
    }
    // Equalized rows: the fact-line count is exactly the sum of the label-independent cue targets (plus the rule), and the
    // distinct-entity count is fixed per pool x hops, so neither can carry the label.
    const groups = new Map<string, Array<{ y: boolean; lines: number; entities: number }>>();
    for (const row of prepared.corpus.rows.filter(r => r.split === 'test')) {
      const world = prepared.gold.worlds[row.id]!;
      if (world.layout !== 'equalized') continue;
      const payload = String(row.input.payload), facts = payload.split('\nFacts:\n')[1]!.split('\nQuestion:')[0]!.split('\n');
      expect(facts.length).toBe(Object.values(world.targets).reduce((n, t) => n + t, 0) + 1);
      const key = `${world.pool}:${world.hops}`;
      groups.set(key, [...(groups.get(key) ?? []), { y: prepared.gold.labels[row.id] === 'yes', lines: facts.length,
        entities: new Set(facts.join(' ').match(/\b[A-Z][a-z]\d{3}\b/g)).size }]);
    }
    for (const rows of groups.values()) {
      expect(rows.some(r => r.y) && rows.some(r => !r.y)).toBe(true);
      expect(new Set(rows.map(r => r.entities)).size).toBe(1);
    }
  });
  it('registers d17-multifact/v1 without moving the D17 or D29 generator pins, and reuses the D17 definition', async () => {
    expect(studyHeldoutGeneratorDigest('d17-entailment/v1')).toBe(registeredHeldoutGeneratorDigest('d17-entailment/v1'));
    expect(studyHeldoutGeneratorDigest('d29-synthetic/v8')).toBe(registeredHeldoutGeneratorDigest('d29-synthetic/v8'));
    expect(prepared.corpus.provenance.generatorDigest).toBe(studyHeldoutGeneratorDigest(D17_MULTIFACT_GENERATOR_ID));
    expect(() => validateHeldoutInputs(prepared.corpus, prepared.preregistration)).not.toThrow();
    const d17 = await prepareD17('d17-2611-v1');
    // Same DecisionDefinition, so the registered D17 member calibrator's identity applies.
    expect(heldoutDigest(prepared.corpus.definitions)).toBe(heldoutDigest(d17.corpus.definitions));
  }, 120_000);
});

describe('D17-MF preregistration and shortcut audit', () => {
  it('preregisters artifact-mode calibration, the hypotheses and decision rules, and a passing shortcut audit', () => {
    expect(prepared.preregistration.calibration).toEqual({ scope: 'calibrated', allowedModes: ['artifact'] });
    expect(prepared.preregistration.studyAnalysisDigest).toBe(heldoutDigest(prepared.analysis));
    expect(prepared.approvalTemplate).toMatchObject({ approved: false, budget: D17MF_BUDGET, calibration: { mode: 'artifact', calibrationArtifactDigest: null } });
    expect(D17MF_PROTOCOL.hypotheses.map(h => h.id)).toEqual(['H1', 'H2', 'H3', 'H3a', 'H4']);
    expect(D17MF_PROTOCOL.multiplicity).toMatchObject({ method: 'holm', alpha: 0.05 });
    expect(D17MF_PROTOCOL.metrics.primary[0]).toContain('raw native answer');
    expect(prepared.audit.equalizedPasses).toBe(true);
    expect(prepared.audit.equalizedMax).toBeLessThanOrEqual(0.6);
    // The D17-faithful control reproduces D17's rendering, where the contrastive verb alone gives the answer away.
    expect(prepared.audit.controlMax).toBeGreaterThan(0.9);
    expect(prepared.analysis.auditDigest).toBe(heldoutDigest(prepared.audit));
    // Dispatch interleaves cells: the first 200 test rows already cover most test cells, in the preregistered order.
    const firstTest = prepared.corpus.rows.filter(r => r.split === 'test').slice(0, 200);
    expect(new Set(firstTest.map(r => r.slice)).size).toBeGreaterThan(30);
    expect(prepared.analysis.dispatchOrderDigest).toBe(heldoutDigest(prepared.corpus.rows.map(r => r.id)));
  });
  it('positive control: the earlier chain-first line order fails the audit through its order features', () => {
    // Re-impose the head-of-round layout: chain links in order, then relay states, then decoys spliced at seeded positions.
    const corpus = structuredClone(prepared.corpus);
    for (const row of corpus.rows) {
      const world = prepared.gold.worlds[row.id]!;
      if (world.layout !== 'equalized' || row.split !== 'test') continue;
      const payload = String(row.input.payload), [head, rest] = payload.split('\nFacts:\n'), [factBlock, question] = rest!.split('\nQuestion:');
      const lines = factBlock!.split('\n'), rule = lines.pop()!, chain = world.chain;
      const words = (l: string) => l.replace(/\.$/, '').split(' ');
      const linkIndex = (l: string) => { const w = words(l); const a = chain.indexOf(w[0]!), b = chain.indexOf(w.at(-1)!); return a >= 0 && b === a + 1 ? a : -1; };
      const stateIndex = (l: string) => { const w = words(l); return w[1] === 'is' && chain.indexOf(w[0]!) > 0 ? chain.indexOf(w[0]!) : -1; };
      const links = lines.filter(l => linkIndex(l) >= 0).sort((a, b) => linkIndex(a) - linkIndex(b));
      const states = lines.filter(l => linkIndex(l) < 0 && stateIndex(l) >= 0).sort((a, b) => stateIndex(a) - stateIndex(b));
      const decoys = lines.filter(l => linkIndex(l) < 0 && stateIndex(l) < 0), facts = [...links, ...states];
      decoys.forEach((line, k) => facts.splice(createHash('sha256').update(`${row.id}:${k}`).digest().readUInt32BE(0) % (facts.length + 1), 0, line));
      row.input = { payload: `${head}\nFacts:\n${[...facts, rule].join('\n')}\nQuestion:${question}` };
    }
    const audit = d17MultifactShortcutAudit(corpus, prepared.gold as any);
    expect(audit.equalizedPasses).toBe(false);
    expect(audit.equalizedMax).toBeGreaterThan(0.6);
  }, 120_000);
  it('requires a complete development review that agrees with gold and the oracle', () => {
    const value = review(), digest = heldoutDigest(value);
    expect(() => validateD17MultifactReview(prepared, value, digest)).not.toThrow();
    expect(new Set(value.assessments.map((a: any) => prepared.gold.worlds[a.rowId]!.outcome)).size).toBe(6);
    expect(value.assessments.every((a: any) => prepared.corpus.rows.find(r => r.id === a.rowId)!.split === 'tuning')).toBe(true);
    for (const [mutate, reason] of [[(v: any) => { v.assessments[0].goldAmbiguousOrIncorrect = true; }, 'development-gold-invalid'],
      [(v: any) => { v.assessments[1].goldAuditLabel = v.assessments[1].goldAuditLabel === 'yes' ? 'no' : 'yes'; }, 'development-review-incomplete'],
      [(v: any) => { v.assessments[2].rationale = null; }, 'development-review'], [(v: any) => { v.reviewer = null; }, 'development-review']] as const) {
      const changed = structuredClone(value); mutate(changed);
      expect(() => validateD17MultifactReview(prepared, changed, heldoutDigest(changed))).toThrow(reason);
    }
    expect(() => validateD17MultifactReview(prepared, value, pin)).toThrow('development-review');
  });
  it('builds blind-then-unblind development review material in the D17 format, and the CLI refuses public seeds', async () => {
    const material = d17MultifactDevReviewMaterial(prepared, { preparedDirectory: '/prepared' });
    expect(material.items).toHaveLength(40);
    expect(material.reviewTemplateDigest).toBe(heldoutDigest(prepared.reviewTemplate));
    material.items.forEach((item, i) => {
      const expected = prepared.reviewTemplate.assessments[i]!;
      expect(Object.keys(item.blind)).toEqual(['payload']);
      expect(item.blind.payload).toBe(expected.payload);
      expect(item.unblind.goldLabel).toBe(prepared.gold.labels[item.rowId]);
      expect(item.unblind.textOracleLabel).toBe(item.unblind.goldLabel);
      expect(item.unblind.variant).toBe(expected.cell);
      expect(cellKey(item.unblind.factors)).toBe(expected.cell);
      expect(prepared.corpus.rows.find(row => row.id === item.rowId)!.split).toBe('tuning');
    });
    expect(new Set(material.items.map(item => item.unblind.factors.outcome)).size).toBe(6);
    const dir = await root(), dirPrepared = join(dir, 'prepared');
    const { writeHeldoutFile } = await import('../../../src/decision/heldout/journal.js');
    await mkdir(dirPrepared);
    for (const name of ['corpus', 'preregistration', 'gold'] as const) await writeHeldoutFile(join(dirPrepared, `${name}.json`), prepared[name]);
    await expect(runDevReviewMaterial([dirPrepared, join(dir, 'material.json')])).rejects.toThrow('public-seed');
    await expect(readFile(join(dir, 'material.json'))).rejects.toThrow();
    await expect(runDevReviewMaterial([dirPrepared])).rejects.toThrow('usage');
  }, 120_000);

  it('refuses public seeds and gates bundles on the cited review and a plan that fits the allowance', async () => {
    expect(() => assertD17MultifactPrivateSeed('d17mf-offline')).toThrow('public-seed');
    expect(() => assertD17MultifactPrivateSeed('review-sweep-3')).toThrow('public-seed');
    expect(() => assertD17MultifactPrivateSeed(privateSeed())).not.toThrow();
    const dir = await root(), dirPrepared = join(dir, 'prepared');
    const { writeHeldoutFile } = await import('../../../src/decision/heldout/journal.js');
    await mkdir(dirPrepared);
    for (const name of ['corpus', 'preregistration', 'gold'] as const) await writeHeldoutFile(join(dirPrepared, `${name}.json`), prepared[name]);
    const value = review(), digest = heldoutDigest(value);
    await writeFile(join(dir, 'review.json'), JSON.stringify(value)); await writeFile(join(dir, 'context.json'), '{}');
    const cited = approval(prepared, 'd17mf-01', pin, `approval citing ${digest}`);
    await writeFile(join(dir, 'cited.json'), JSON.stringify(cited));
    // The CLI refuses this public test seed before any review, calibration or plan work.
    await expect(runBundle([dirPrepared, join(dir, 'cited.json'), join(dir, 'review.json'), digest, join(dir, 'b.json'), join(dir, 'context.json')]))
      .rejects.toThrow('public-seed');
    await expect(readFile(join(dir, 'b.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The gates it applies for a private seed: review binding and the allowance fit.
    expect(() => assertD17ReviewBoundToApproval(approval(prepared, 'd17mf-01', pin), digest)).toThrow('development-review-not-bound');
    expect(() => assertD17ReviewBoundToApproval(cited, digest)).not.toThrow();
    const plan = await d17MultifactPlan(prepared, cited);
    expect(d17MultifactFit(plan, d17MultifactFreshAllowance(cited)).fits).toBe(true);
    expect(d17MultifactFit(plan, d17MultifactFreshAllowance({ ...cited, budget: { ...cited.budget, calls: 1000 } })).fits).toBe(false);
    expect(plan).toMatchObject({ rows: 5778, firstAttempts: 5778, maximumAttempts: 11556 });
  }, 120_000);
});

/** A fresh private seed per call: committed seeds are public and refused at the collector boundary. */
const privateSeed = () => `unit-${randomBytes(12).toString('hex')}`;
/** A one-row D17-MF corpus for a private seed, at the allocation index of the `nth` row of `split`. */
function privateSmall(seed = privateSeed(), split = 'test', nth = 0) {
  const index = prepared.corpus.rows.map((row, i) => row.split === split ? i : -1).filter(i => i >= 0)[nth]!;
  const small = structuredClone(prepared);
  small.corpus.rows = [generateStudyHeldoutRow(D17_MULTIFACT_GENERATOR_ID, `${seed}:${index}:single`)];
  small.corpus.provenance.seed = seed;
  small.preregistration.corpusDigest = heldoutDigest(small.corpus);
  return small;
}
function offline(transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init))) {
  return { transport, host: { resolveCredential: async () => new TextEncoder().encode('fake-d17mf-reader'), dispose: () => {} } };
}
async function collectAt(dir: string, bundle: HeldoutBundle, startMs: number, transport?: ReturnType<typeof vi.fn>) {
  let time = startMs;
  return collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: dir, sourceRoot: process.cwd(),
    offline: offline(transport as any), now: () => time, sleep: async (ms: number) => { time += ms; } });
}

describe('D17-MF collector-boundary guards', () => {
  it('refuses public, committed and low-entropy seeds and non-artifact calibration in validateHeldoutBundle, before any call', async () => {
    const pub = { corpus: prepared.corpus, preregistration: prepared.preregistration } as HeldoutBundle;
    pub.approval = approval(pub, 'd17mf-pub', pin);
    expect(() => validateHeldoutBundle(pub, heldoutDigest(pub.approval))).toThrow('public-demo-seed');
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init));
    await expect(collectAt(await root(), pub, Date.parse('2026-10-05T00:00:00Z'), transport)).rejects.toThrow('public-demo-seed');
    expect(transport).not.toHaveBeenCalled();
    for (const seed of ['d17mf-offline', 'd17mf-offline2', 'd17mf-0ffline', 'd17mfoffline', 'd17-mf-offline', 'offline-d17mf', 'review-x', 'reviewx',
      'd17mf-7f3a9c2e1b', 'd17mf-01', 'd17mf-template', `review-${randomBytes(12).toString('hex')}`, `d17mf-sweep-${randomBytes(12).toString('hex')}`]) {
      expect(() => assertD17MultifactPrivateSeed(seed), seed).toThrow('public-seed');
    }
    expect(() => assertD17MultifactPrivateSeed(`d17mf-${randomBytes(12).toString('hex')}`)).not.toThrow();
    const small = privateSmall(), ok = { corpus: small.corpus, preregistration: small.preregistration } as HeldoutBundle;
    ok.approval = approval(ok, 'd17mf-ok', pin);
    expect(() => validateHeldoutBundle(ok, heldoutDigest(ok.approval))).not.toThrow();
    const staged = structuredClone(ok); (staged.approval as any).calibration = { mode: 'uncalibrated-diagnostic' };
    staged.approval.executionDigest = heldoutExecutionDigest(staged.corpus, staged.preregistration, staged.approval);
    expect(() => validateHeldoutBundle(staged, heldoutDigest(staged.approval))).toThrow('calibration-scope');
  }, 120_000);

  it('never dispatches past the calibrator expiry, and refuses a private seed already frozen under another corpus', async () => {
    const notAfter = Date.parse(D17_MULTIFACT_CALIBRATION_NOT_AFTER), limit = prepared.preregistration.sessionLimitMs;
    for (const start of [Date.parse('2026-11-05T12:00:00Z'), notAfter - limit + 1]) {
      const small = privateSmall(), bundle = { corpus: small.corpus, preregistration: small.preregistration } as HeldoutBundle;
      bundle.approval = approval(bundle, 'd17mf-late', pin);
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)), dir = await root();
      await expect(collectAt(dir, bundle, start, transport)).rejects.toThrow('calibration-expired');
      expect(transport).not.toHaveBeenCalled();
    }
    const seed = privateSeed(), dir = await root();
    const first = privateSmall(seed, 'test', 0), a = { corpus: first.corpus, preregistration: first.preregistration } as HeldoutBundle;
    a.approval = approval(a, 'd17mf-seed-a', pin);
    expect(await collectAt(dir, a, notAfter - limit - 60_000)).toMatchObject({ status: 'complete', completedRows: 1 });
    const second = privateSmall(seed, 'test', 1), b = { corpus: second.corpus, preregistration: second.preregistration } as HeldoutBundle;
    b.approval = approval(b, 'd17mf-seed-b', pin);
    await expect(collectAt(dir, b, Date.parse('2026-10-05T00:00:00Z'))).rejects.toThrow('seed-reused');
  }, 120_000);

  it('bounds collection end by digest-covered session starts: rewriting qualification.json cannot move it, rewriting frozen.json breaks the evidence pin', async () => {
    const small = privateSmall(), bundle = { corpus: small.corpus, preregistration: small.preregistration } as HeldoutBundle;
    bundle.approval = approval(bundle, 'd17mf-clock', pin);
    const dir = await root(), start = Date.parse('2026-10-20T12:00:00Z');
    const summary = await collectAt(dir, bundle, start) as { evidenceDigest: string };
    const run = join(heldoutRunsRoot(dir), 'd17mf-clock');
    const bound = d17MultifactCollectionEnd([await readHeldoutFrozen(run)]);
    expect(bound).toBe(new Date(start + small.preregistration.sessionLimitMs).toISOString());
    // The review probe: backdate (and forward-date) the undigested qualification.json time; the bound does not move.
    for (const generatedAt of ['2026-10-03T00:00:00.000Z', '2026-12-01T00:00:00.000Z']) {
      const path = join(run, 'qualification.json'), q = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...q, generatedAt }));
      expect(d17MultifactCollectionEnd([await readHeldoutFrozen(run)])).toBe(bound);
    }
    // Moving the bound needs a frozen.json edit, which the trusted evidence digest detects at scoring.
    const frozenPath = join(run, 'frozen.json'), frozen = JSON.parse(await readFile(frozenPath, 'utf8'));
    await writeFile(frozenPath, JSON.stringify({ ...frozen, collectionStartedAt: '2026-10-03T00:00:00.000Z' }));
    expect(await heldoutEvidenceDigest(run, await readHeldoutJournal(run))).not.toBe(summary.evidenceDigest);
    const integrity = { sample_n: 1, uncertainty: null, paired_baseline: null, integrity_mode: 'standard', fresh_workspace_required: false,
      fresh_workspace_verified: false, integrity_state: 'not-assessed', trusted_score_source: 'local-unverified', compromise_labels: [],
      weak_signal_reason: 'offline-control', release_gate: { decision: 'HOLD', reasons: ['offline-control'] } } as QualificationIntegrityMetadata;
    const score = vi.fn(async () => ({ calibrated: true }));
    await expect(scoreHeldoutStudy({ run, trustedEvidenceDigest: summary.evidenceDigest as any, trustedApprovalDigest: heldoutDigest(bundle.approval),
      module: { prepare: async () => small, score } as any, moduleDigest: small.preregistration.scorerDigest, gold: small.gold, integrity,
      trustedIntegrityDigest: heldoutDigest(integrity) })).rejects.toThrow('evidence-pin');
    expect(score).not.toHaveBeenCalled();
    // A run recorded without a session start (before #2850) has no bound and cannot be scored.
    expect(() => d17MultifactCollectionEnd([{ bundle: small }])).toThrow('collection-clock');
  }, 120_000);
});


describe('D17-MF calibrated scoring', () => {
  let template: HeldoutAttempt;
  beforeAll(async () => {
    // One real receipt from an offline collection through the shared collector (artifact mode, new generator).
    const dir = await root();
    const small = privateSmall();
    const bundle = { corpus: small.corpus, preregistration: small.preregistration, approval: approval(small, 'd17mf-template', pin) } as HeldoutBundle;
    let time = Date.parse('2026-10-02T20:00:00Z');
    const summary = await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: dir,
      sourceRoot: process.cwd(), offline: { transport: vi.fn(async (_url: unknown, init?: RequestInit) => reply(init)),
        host: { resolveCredential: async () => new TextEncoder().encode('fake-d17mf-reader'), dispose: () => {} } },
      now: () => time, sleep: async (ms: number) => { time += ms; } });
    expect(summary).toMatchObject({ status: 'complete', completedRows: 1 });
    template = (await readHeldoutJournal(join(heldoutRunsRoot(dir), 'd17mf-template'))).find(e => e.attempt.result?.disposition === 'success')!.attempt;
  }, 120_000);
  /** A qualifying member calibrator for this definition: monotone, approved, within the frozen D17 profile. */
  function calibrator() {
    const mapping = { schemaVersion: 'decision-d17-calibration-mapping/v1', role: 'member', calibrator: { id: 'd17-single-call-isotonic', version: '1' },
      method: 'isotonic-pav-laplace-v1', model: 'jev-1.13.0', splitDigest: pin, definitionDigest: heldoutDigest(prepared.corpus.definitions), evidenceDigest: pin,
      n: 400, rows: 400, blocks: fitD17Isotonic([...Array.from({ length: 200 }, () => ({ score: 0.1, label: 0 as const })), ...Array.from({ length: 200 }, () => ({ score: 0.9, label: 1 as const }))]),
      qualification: {} } as any;
    const payload: Omit<CalibrationArtifact, 'digest'> = { schemaVersion: 'decision-calibration-artifact/v1', id: 'd17-member-fixture',
      identity: { provider: 'jev', backend: 'api', actualModel: 'jev-1.13.0', primitive: 'choice', definitionDigest: heldoutDigest(prepared.corpus.definitions),
        adapterVersion: '1.0.0', dataset: { id: 'd17-calibration', hash: pin }, slice: { id: 'd17-all-calibration-slices', hash: pin },
        calibrator: { id: 'd17-single-call-isotonic', version: '1', parametersDigest: heldoutDigest(mapping) } },
      splitProvenance: { id: 'd17-calibration', hash: pin, holdoutAccessedAt: null }, profile: structuredClone(D17_CALIBRATION.profile) as CalibrationArtifact['profile'],
      metrics: { totalSamples: 400, perSliceSamples: 100, calibrationError: 0.01, selectiveRisk: 0.0125, confidenceIntervals: { selectiveRisk: { lower: 0.005, upper: 0.03 } } },
      effectiveAt: '2026-10-02T10:02:38.000Z', limitations: ['offline fixture'], approval: { state: 'approved', reference: 'reviewer=fixture; offline' } };
    const artifact = { ...payload, digest: calibrationArtifactDigest(payload) } as CalibrationArtifact;
    const set = { member: { artifactId: artifact.id, artifactDigest: artifact.digest, mappingDigest: heldoutDigest(mapping) } };
    return { mapping, artifact, set, setDigest: heldoutDigest({ fixture: set }) };
  }
  /** Synthetic behaviour: contrastive missing links are read as links (pool-c always, pool-b mostly, pool-a sometimes); everything else is right. */
  function attempts() {
    const pins = { corpusDigest: heldoutDigest(prepared.corpus), preregistrationDigest: heldoutDigest(prepared.preregistration) };
    return prepared.corpus.rows.map((row, i) => {
      const world = prepared.gold.worlds[row.id]!, gold = prepared.gold.labels[row.id]!;
      const permissive = world.outcome === 'missing-contrastive' && (world.pool === 'pool-c' || world.pool === 'pool-b' && i % 10 < 7 || world.pool === 'pool-a' && i % 10 < 3);
      const yes = permissive ? 0.9 : gold === 'yes' ? 0.9 : 0.1;
      const attempt = structuredClone(template);
      Object.assign(attempt, { rowId: row.id, requestId: 'champion', ordinal: 1, ...pins });
      const q0 = attempt.result!.receipt!.spec.evaluations.q0 as any;
      q0.spec.value = yes >= 0.5 ? 'yes' : 'no'; q0.spec.uncertainty.distribution = { yes, no: 1 - yes };
      attempt.result!.receiptDigest = heldoutDigest(attempt.result!.receipt);
      return attempt;
    });
  }
  const integrity: QualificationIntegrityMetadata = { sample_n: 5778, uncertainty: null, paired_baseline: null, integrity_mode: 'standard',
    fresh_workspace_required: false, fresh_workspace_verified: false, integrity_state: 'not-assessed', trusted_score_source: 'local-unverified',
    compromise_labels: [], weak_signal_reason: 'offline-control', release_gate: { decision: 'HOLD', reasons: ['offline-control'] } };
  it('applies the registered member calibrator, reports every cell and evaluates the preregistered hypotheses', async () => {
    const cal = calibrator(), all = attempts();
    const context = { set: cal.set as any, trustedCalibrationSetDigest: cal.setDigest, member: { artifact: cal.artifact, mapping: cal.mapping },
      collectionEndedAt: '2026-10-02T23:00:00.000Z', nowEpochMs: Date.parse('2026-10-03T00:00:00Z') };
    const input = { corpus: prepared.corpus, preregistration: prepared.preregistration, attempts: all, gold: prepared.gold, integrity,
      approvedCalibration: { mode: 'artifact', calibrationArtifactDigest: cal.setDigest }, calibrated: null };
    const report = await scoreD17Multifact(input, prepared, context);
    expect(report).toMatchObject({ schemaVersion: 'decision-d17mf-report/v2', calibrated: true, decision: 'HOLD',
      calibration: { mode: 'artifact', memberArtifactDigest: cal.artifact.digest, compatibility: { action: 'allow' }, collectionEndedAt: '2026-10-02T23:00:00.000Z' },
      coverage: { testRows: 5700, observed: 5700, developmentRows: 78, complete: true } });
    expect(Object.keys(report.cells)).toHaveLength(39);
    expect(report.cells['pool-c_h1_missing-contrastive_equalized']).toMatchObject({ raw: { accuracy: 0, saidYesRate: 1 } });
    expect(report.cells['pool-c_h1_missing-negation_equalized']).toMatchObject({ raw: { accuracy: 1 } });
    expect(report.cells['pool-c_h3_missing-absence_equalized']).toMatchObject({ raw: { accuracy: 1 } });
    expect(report.hypotheses.H1.verdict).toBe(true);
    expect(report.hypotheses.H1.tests.every((t: any) => t.holmP === null || t.holmP + 1e-6 >= t.p)).toBe(true);
    expect(report.hypotheses.H2.verdict).toBe(false);
    expect(report.hypotheses.H3a.verdict).toBe('contrastive-specific');
    expect(report.hypotheses.replication.verdict).toBe(true);
    expect(report.hypotheses.calibrationUnderShift.unreliableCells).toContain('pool-c_h1_missing-contrastive_equalized');
    expect(report.hypotheses.H4.byPool.every((p: any) => p.matchedPosition === 'last link')).toBe(true);
    const c1 = report.auroc.find((a: any) => a.pool === 'pool-c' && a.hops === 1)!;
    expect(c1.byEncoding['missing-contrastive']).toMatchObject({ auroc: 0.5 });
    expect(c1.byEncoding['missing-negation']).toMatchObject({ auroc: 1 });
    expect(Object.keys(report.byFailurePosition).some(k => k.endsWith(':interior'))).toBe(true);
    // Coverage gate: an under-covered cell withholds every verdict.
    const pcRows = new Set(prepared.corpus.rows.filter(r => r.slice === 'pool-c_h1_missing-negation_equalized' && r.split === 'test').map(r => r.id));
    const thin = await scoreD17Multifact({ ...input, attempts: all.filter((a, i) => !pcRows.has(a.rowId) || i % 2 === 0) }, prepared, context);
    expect(thin.coverage.complete).toBe(false);
    expect(thin.hypotheses.H1.verdict).toBe('insufficient'); expect(thin.hypotheses.H3a.verdict).toBe('insufficient');
    // Refusals: the binding, the artifact, its definition, the clock and the scope.
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ approvedCalibration: { mode: 'artifact', calibrationArtifactDigest: pin } }, 'approved-calibration'],
      [{ approvedCalibration: { mode: 'uncalibrated-diagnostic' } }, 'approved-calibration'], [{ calibrated: false }, 'approved-calibration']];
    for (const [patch, reason] of refusals) await expect(scoreD17Multifact({ ...input, ...patch }, prepared, context)).rejects.toThrow(reason);
    const unapproved = { ...cal.artifact, approval: { state: 'observed', reference: null } } as CalibrationArtifact;
    await expect(scoreD17Multifact(input, prepared, { ...context, member: { ...context.member, artifact: unapproved } })).rejects.toThrow('calibration-artifact');
    await expect(scoreD17Multifact(input, prepared, { ...context, nowEpochMs: Date.parse('2026-12-01T00:00:00Z') })).rejects.toThrow('calibration-unqualified');
    // The scoring clock may not precede the recorded collection end; an expired calibrator at collection end refuses too.
    await expect(scoreD17Multifact(input, prepared, { ...context, nowEpochMs: Date.parse('2026-10-02T22:00:00Z') })).rejects.toThrow('scoring-clock');
    await expect(scoreD17Multifact(input, prepared, { ...context, collectionEndedAt: '2026-11-02T00:00:00.000Z', nowEpochMs: Date.parse('2026-11-03T00:00:00Z') }))
      .rejects.toThrow('calibration-unqualified');
    await expect(scoreD17Multifact({ ...input, gold: { ...prepared.gold, labels: {} } }, prepared, context)).rejects.toThrow('frozen-pins');
  }, 120_000);
  it('computes Holm adjustments, two-proportion p-values and Hanley-McNeil AUROC intervals', () => {
    expect(holmAdjust([0.01, 0.04, null, 0.03])).toEqual([0.03, 0.06, null, 0.06]);
    expect(twoProportionP(50, 100, 50, 100)).toBeCloseTo(1, 6);
    expect(twoProportionP(10, 100, 50, 100)!).toBeLessThan(1e-6);
    expect(auroc([0.9, 0.8], [0.1, 0.2])).toMatchObject({ auroc: 1 });
    expect(auroc([0.5], [0.5])).toMatchObject({ auroc: 0.5 });
    expect(auroc([], [0.1])).toBeNull();
  });
  it('computes Newcombe hybrid-score intervals for independent proportions', () => {
    expect(newcombeDifference(0, 250, 250, 250)).toMatchObject({ difference: -1 });
    const d = newcombeDifference(200, 250, 150, 250)!;
    expect(d.difference).toBe(0.2); expect(d.lower).toBeGreaterThan(0.11); expect(d.upper).toBeLessThan(0.29);
    expect(newcombeDifference(1, 0, 1, 1)).toBeNull();
  });
});

describe('D17-MF CLI', () => {
  it('describes its modes and refuses unknown or open configs', async () => {
    const help = spawnSync(process.execPath, ['tools/decision/d17-multifact.mjs', '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(help.status, help.stderr).toBe(0);
    for (const word of ['--dry-run', '--prepare', '--dev-review-material', '--bundle', '--dry-run-ledger', '--score', 'd17CalibrationRun', 'exact approved source commit']) expect(help.stdout).toContain(word);
    const dir = await root(), config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ run: dir, unexpected: true }));
    const refused = spawnSync(process.execPath, ['tools/decision/d17-multifact.mjs', '--score', config, join(dir, 'out.json')], { encoding: 'utf8', timeout: 20000 });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain('D17-MF refused'); expect(refused.stdout).toBe('');
  }, 60_000);
});
