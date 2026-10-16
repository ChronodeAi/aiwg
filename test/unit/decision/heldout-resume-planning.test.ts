import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeExecutable } from '../../helpers/write-executable.js';
import { prepare } from '../../../agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs';
import { collectHeldoutStudy } from '../../../src/decision/heldout/collector.js';
import { HeldoutError, heldoutDigest, heldoutExecutionDigest, heldoutRequestSize, heldoutReservationMicros, heldoutReservationTokens, planHeldoutCollection } from '../../../src/decision/heldout/contract.js';
import { heldoutCollectionAllowance, scanHeldoutSpend } from '../../../src/decision/heldout/journal.js';
import { generateHeldoutRow } from '../../../src/decision/heldout/generators.js';
import { D17_MULTIFACT_GENERATOR_ID, generateStudyHeldoutRow, studyHeldoutGeneratorDigest } from '../../../src/decision/heldout/study-generators.js';
import { D17MF_DEFINITION } from '../../../src/decision/ensemble-study/multifact.js';
import { D17CalibrationError } from '../../../src/decision/ensemble-study/calibration.js';
import { D17MF_ARTIFACT_EXPIRY, prepareD17MultifactStudy } from '../../../src/decision/ensemble-study/multifact-study.js';
import { runLedgerDryRun } from '../../../tools/decision/d17-multifact.mjs';
import { decisionRefusalCode } from '../../../tools/decision/refusal-code.mjs';
import type { HeldoutBundle } from '../../../src/decision/heldout/types.js';

const fixture = vi.hoisted(() => ({ root: '', bundle: null as HeldoutBundle | null, now: Date.parse('2026-10-15T00:00:00Z') }));
vi.mock('../../../src/decision/context-live-qualification.js', async original => ({
  ...await original<typeof import('../../../src/decision/context-live-qualification.js')>(),
  assertContextLiveSource: vi.fn(async () => {}),
  assertContextArtifactRoot: vi.fn(async (_source: string, root: string) => { if (root !== fixture.root) throw new Error('root'); }),
}));
// Only calibration verification is injected; resume selection, request sizing and durable spend scanning are real.
vi.mock('../../../src/decision/heldout/calibration.js', async original => ({
  ...await original<typeof import('../../../src/decision/heldout/calibration.js')>(),
  readHeldoutCalibrationPhase: vi.fn(async () => ({ bundle: fixture.bundle })),
}));
vi.mock('../../../src/decision/ensemble-study/calibration.js', async original => ({
  ...await original<typeof import('../../../src/decision/ensemble-study/calibration.js')>(),
  verifyD17CalibrationSet: vi.fn(() => ({ set: {}, setDigest: 'sha256:' + 'a'.repeat(64),
    member: { artifact: { effectiveAt: '2026-10-02T10:02:34.263Z', profile: { expiresAfterDays: 30 } }, mapping: {} } })),
}));
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pin = heldoutDigest('resume-fixture');

async function checkpoint(multifact = false, fits = true, budget = 'calls', stopped = false) {
  const root = await mkdtemp(join(tmpdir(), 'heldout-resume-')); dirs.push(root); fixture.root = root;
  const seed = `unit-${randomBytes(12).toString('hex')}`;
  const { corpus, preregistration } = await prepare(seed);
  corpus.rows = [0, 1, 2].map(i => multifact ? generateStudyHeldoutRow(D17_MULTIFACT_GENERATOR_ID, `${seed}:${i}:single`)
    : generateHeldoutRow('heldout-lamp/v1', `${seed}:${i}:single`));
  if (multifact) {
    corpus.definitions = [structuredClone(D17MF_DEFINITION)];
    corpus.provenance.generatorDigest = studyHeldoutGeneratorDigest(D17_MULTIFACT_GENERATOR_ID);
    preregistration.calibration = { scope: 'calibrated', allowedModes: ['artifact'] };
  }
  preregistration.sessionLimitMs = 6000;
  preregistration.corpusDigest = heldoutDigest(corpus);
  const bundle: HeldoutBundle = { corpus, preregistration, approval: { schemaVersion: 'decision-heldout-approval/v1', approved: true,
    study: 'D17', runId: 'checkpoint-01', reviewer: 'fixture-reviewer', approvalReference: 'fixture-only', sourceCommit: 'a'.repeat(40),
    exactHeadCi: 'fixture-ci', stagingHost: 'titan', stagingWorkspace: 'fixture-workspace', model: 'jev-1.13.0', servedModel: 'jev-1.13.0',
    region: 'fixture-region', credentialRef: 'openbao-approle.fixture.typesafe-jev', credentialResolverDigest: pin,
    corpusDigest: heldoutDigest(corpus), preregistrationDigest: heldoutDigest(preregistration), executionDigest: pin,
    calibration: multifact ? { mode: 'artifact', calibrationArtifactDigest: heldoutDigest({}) } : { mode: 'uncalibrated-diagnostic' },
    providerTermsReference: 'fixture-only', priceBound: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0, perRequestUsd: 0,
      evidenceReferences: ['fixture-rate'], approvalReference: 'fixture-attestation' }, budget: { calls: 1000, tokens: 4_000_000, usd: 1 },
    priorStudySpendUsd: 0, priorPortfolioSpendUsd: 0 } };
  bundle.approval.executionDigest = heldoutExecutionDigest(corpus, preregistration, bundle.approval);
  const fresh = await planHeldoutCollection(bundle, heldoutDigest(bundle.approval));
  const demand = budget === 'calls' ? fresh.maximumAttempts : budget === 'tokens' ? fresh.reservedTokens : fresh.reservedUsdMicros;
  const row = corpus.rows[0]!;
  const { estimatedTokens } = await heldoutRequestSize(corpus, preregistration, bundle.approval, row, row.requests[0]!);
  const spent = budget === 'calls' ? 1 : budget === 'tokens' ? heldoutReservationTokens(preregistration, estimatedTokens)
    : heldoutReservationMicros(bundle.approval, estimatedTokens);
  // The first success spends one reservation and removes its retry from the remaining demand.
  const ceiling = demand - spent;
  if (budget === 'usd') bundle.approval.budget.usd = (ceiling + (fits ? 1 : -1)) / 800_000;
  else bundle.approval.budget[budget as 'calls' | 'tokens'] = Math.ceil(ceiling / 0.8) + (fits ? 0 : -2);
  let time = fixture.now;
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
    time += 1000;
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: stopped ? 'unexpected-fixture-model' : 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
      { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } }])), usage: { input_tokens: 20, output_tokens: 4 } }));
  });
  const host = { resolveCredential: vi.fn(async () => new TextEncoder().encode('fixture-reader')), dispose: vi.fn() };
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  expect(await collectHeldoutStudy({ enabled: true, bundle, trustedApprovalDigest: heldoutDigest(bundle.approval), artifactRoot: root,
    sourceRoot: process.cwd(), offline: { transport, host }, ...clock }))
    .toMatchObject({ status: stopped ? 'stopped' : 'checkpoint', completedRows: stopped ? 0 : 1 });
  expect(transport).toHaveBeenCalledOnce();
  bundle.approval.runId = 'resume-02'; fixture.bundle = bundle;
  const bundlePath = join(root, 'bundle.json'); await writeFile(bundlePath, JSON.stringify(bundle));
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeExecutable(join(bin, 'aiwg'), '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify({ artifact_root: root })) + ');\n');
  await writeExecutable(join(bin, 'git'), '#!/usr/bin/env node\nif (process.argv.includes("rev-parse")) process.stdout.write("a".repeat(40)); else if (!process.argv.includes("status")) process.exit(2);\n');
  return { root, bundle, bundlePath, bin, transport, host, clock };
}

async function calibrationContext(c: Awaited<ReturnType<typeof checkpoint>>) {
  vi.stubEnv('PATH', c.bin + ':' + process.env.PATH);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(fixture.now);
  const calibrationDir = join(c.root, 'calibration'); await mkdir(calibrationDir);
  for (const name of ['calibration-set', 'member-artifact', 'aggregate-artifact', 'member-mapping', 'aggregate-mapping']) {
    await writeFile(join(calibrationDir, `${name}.json`), '{}');
  }
  const source = join(c.root, 'source'); await mkdir(join(source, 'tools/decision'), { recursive: true });
  await writeFile(join(source, 'tools/decision/d17-study.mjs'), 'export async function prepare() { return {}; }\n');
  const context = join(c.root, 'context.json');
  await writeFile(context, JSON.stringify({ d17CalibrationDir: calibrationDir, d17CalibrationReviewFile: context,
    d17CalibrationRun: c.root, d17DevelopmentReviewFile: context, d17SourceRoot: source,
    trustedD17CalibrationReviewDigest: pin, trustedD17DevelopmentReviewDigest: pin }));
  return context;
}

describe('resume-aware dry-run planning (#2870)', () => {
  const budgets = ['calls', 'tokens', 'usd'].flatMap(budget => [true, false].map(fits => [budget, fits] as const));
  it.each(budgets)('heldout CLI retains retries after a checkpoint: %s fits=%s', async (budget, fits) => {
    const c = await checkpoint(false, fits, budget);
    const dry = spawnSync(process.execPath, [resolve('tools/decision/heldout-study.mjs'), '--dry-run', c.bundlePath, heldoutDigest(c.bundle.approval), c.root],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: c.bin + ':' + process.env.PATH } });
    expect(dry.status, dry.stderr).toBe(fits ? 0 : 1);
    expect(JSON.parse(dry.stdout)).toMatchObject({ maximumAttempts: 4,
      ready: fits, reason: fits ? null : 'budget-exceeded', providerCalls: 0 });
    if (!fits) expect(dry.stderr).toContain('refused (budget-exceeded)');
  });

  it.each(budgets)('D17-MF ledger dry-run retains retries after a checkpoint: %s fits=%s', async (budget, fits) => {
    const c = await checkpoint(true, fits, budget);
    const context = await calibrationContext(c);
    const result = await runLedgerDryRun([c.bundlePath, heldoutDigest(c.bundle.approval), c.root, context]);
    expect(result).toMatchObject({ plan: { maximumAttempts: 4 }, ledger: { fits },
      ready: fits, reason: fits ? null : 'budget-exceeded', providerCalls: 0, sessionWindowOpen: true });
    expect(c.transport).toHaveBeenCalledOnce(); expect(c.host.resolveCredential).toHaveBeenCalledOnce();
    if (fits && budget === 'calls') {
      vi.setSystemTime(Date.parse(D17MF_ARTIFACT_EXPIRY) - c.bundle.preregistration.sessionLimitMs + 1);
      expect(await runLedgerDryRun([c.bundlePath, heldoutDigest(c.bundle.approval), c.root, context]))
        .toMatchObject({ ready: false, reason: 'calibration-expired', sessionWindowOpen: false });
    }
  });

  it.each([false, true])('retains the prior-stop refusal when multifact=%s', async multifact => {
    const c = await checkpoint(multifact, true, 'calls', true);
    if (multifact) {
      const context = await calibrationContext(c);
      expect(await runLedgerDryRun([c.bundlePath, heldoutDigest(c.bundle.approval), c.root, context]))
        .toMatchObject({ ready: false, reason: 'prior-stop' });
    } else {
      const dry = spawnSync(process.execPath, [resolve('tools/decision/heldout-study.mjs'), '--dry-run', c.bundlePath, heldoutDigest(c.bundle.approval), c.root],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: c.bin + ':' + process.env.PATH } });
      expect(dry.status).toBe(1); expect(JSON.parse(dry.stdout)).toMatchObject({ ready: false, reason: 'prior-stop' });
      expect(dry.stderr).toContain('refused (prior-stop)');
    }
  });

  it('excludes successes from every prior checkpoint under the same corpus and preregistration', async () => {
    const c = await checkpoint();
    expect(await collectHeldoutStudy({ enabled: true, bundle: c.bundle, trustedApprovalDigest: heldoutDigest(c.bundle.approval),
      artifactRoot: c.root, sourceRoot: process.cwd(), offline: { transport: c.transport, host: c.host }, ...c.clock }))
      .toMatchObject({ status: 'checkpoint', completedRows: 2 });
    c.bundle.approval.runId = 'resume-03';
    const prior = await scanHeldoutSpend(c.root, 'D17', c.bundle.approval);
    expect(prior.runs).toHaveLength(2);
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), prior.attempts)).toMatchObject({ maximumAttempts: 2 });
    expect(heldoutCollectionAllowance(c.bundle.approval, prior).calls).toBe(3);
    expect(c.transport).toHaveBeenCalledTimes(2);
  });

  it('shares observations across sessions, ignores other corpora, preserves only unspent attempts and rejects changed preregistration', async () => {
    const c = await checkpoint();
    const prior = await scanHeldoutSpend(c.root, 'D17', c.bundle.approval);
    const [success] = prior.attempts;
    const retry = { ...success!, rowId: c.bundle.corpus.rows[1]!.id, runId: 'other-session', result: { ...success!.result!, disposition: 'retryable' as const } };
    const plan = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), [...prior.attempts, retry]);
    expect(plan.maximumAttempts).toBe(3);
    const full = await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval));
    expect(full.maximumAttempts).toBe(6);
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), [{ ...success!, corpusDigest: pin }])).toEqual(full);
    expect(await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), [{ ...success!, study: 'D29' }])).toEqual(full);
    const later = { ...success!, ordinal: 2, result: { ...success!.result!, disposition: 'retryable' as const } };
    for (const observations of [[success!, later], [later, success!]]) {
      expect((await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), observations)).maximumAttempts).toBe(4);
    }
    const exhausted = { ...retry, ordinal: 2, result: { ...retry.result, disposition: 'measurement-failure' as const } };
    expect((await planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), [...prior.attempts, exhausted])).maximumAttempts).toBe(2);
    await expect(planHeldoutCollection(c.bundle, heldoutDigest(c.bundle.approval), [{ ...success!, preregistrationDigest: pin }]))
      .rejects.toThrow('changed-preregistration');
    const allowance = heldoutCollectionAllowance(c.bundle.approval, prior);
    expect(plan.maximumAttempts).toBeLessThanOrEqual(allowance.calls);
  });
});

describe('redacted refusal codes', () => {
  it.each([
    [new HeldoutError('payload-bound'), 'payload-bound'],
    [new D17CalibrationError('frozen-study-mismatch'), 'frozen-study-mismatch'],
    [{ reason: 'seed-too-long' }, 'seed-too-long'],
    [new Error('D17-MF plan exceeds the approval allowance'), 'budget-exceeded'],
    [new Error('D17 sealed source commit mismatch'), 'source-pin-mismatch'],
    [new Error('TV-12 evidence must use the canonical artifact root'), 'artifact-root'],
    [new Error('usage'), 'usage'], [new Error('config'), 'config'], [new Error('gate'), 'live-gate'],
    [new Error('credential=fixture-secret gold=yes seed=private-value'), 'check-failed'],
    [{ category: 'private-value', reason: 'fixture-secret' }, 'check-failed'], [null, 'check-failed'],
  ])('returns only a source-defined code for %j', (error, code) => { expect(decisionRefusalCode(error)).toBe(code); });

  it.each([['x'.repeat(33), 'seed-too-long'], ['invalid seed', 'seed-invalid']])('reports seed validation without values', (seed, code) => {
    try { prepareD17MultifactStudy(seed!, pin, { source: pin }); expect.fail('expected refusal'); }
    catch (error) { expect(decisionRefusalCode(error)).toBe(code); expect(String(error)).not.toContain(seed); }
  });
  it('reports source pin validation separately from the seed', () => {
    try { prepareD17MultifactStudy('valid-seed', pin, {}); expect.fail('expected refusal'); }
    catch (error) { expect(decisionRefusalCode(error)).toBe('source-pin-mismatch'); }
  });
  it('prints the seed-too-long code at the D17-MF CLI boundary without the value', () => {
    const seed = 'private-' + 'x'.repeat(33);
    const result = spawnSync(process.execPath, ['tools/decision/d17-multifact.mjs', '--dry-run', seed], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1); expect(result.stderr).toBe('D17-MF refused (seed-too-long).\n');
    expect(result.stdout).toBe(''); expect(result.stderr).not.toContain(seed);
  });
});
