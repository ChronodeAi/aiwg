import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAiwgConfigCandidate, writeAiwgConfig, emptyConfig } from '../../../src/config/aiwg-config.js';
import {
  askDecision,
  DecisionAskUsageError,
  JEV_CREDENTIAL_REF,
  jevCredentialPath,
  lookupJevCredential,
  JevDecisionAdapter,
  setupJev,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionAdapterRequest,
} from '../../../src/decision/index.js';

const SECRET = 'fixture-token-never-print';

class FakeAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version = '1.0.0';
  constructor(private readonly confidence = 0.93) {}

  async capabilities() {
    return {
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as const,
      features: ['typed-output', 'structured-entries'],
      maxOptions: 255,
      maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      executable: true,
      egress: { mode: 'network' as const, origin: 'https://api.typesafe.ai', region: 'us' },
    };
  }

  async evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation> {
    const token = new TextDecoder().decode(await request.resolveCredential(JEV_CREDENTIAL_REF));
    expect(token).toBe(SECRET);
    const kind = request.definition.spec.answer.kind;
    const usage = { inputTokens: 12, outputTokens: 3, costUsd: null };
    if (kind === 'truth-probability') return {
      status: 'success',
      reason: 'none',
      value: this.confidence,
      uncertainty: { source: 'provider', profile: 'typesafe-truth-v1', calibration: 'vendor-claimed', confidence: null, distribution: null, calibrationRef: null },
      actualModel: 'jev-1.13.0',
      usage,
      requestId: null,
    };
    if (kind === 'ordinal-score') return {
      status: 'success',
      reason: 'none',
      value: 2,
      uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: this.confidence, distribution: { 0: 0.05, 1: 0.05, 2: 0.9, 3: 0, 4: 0 }, calibrationRef: null },
      actualModel: 'jev-1.13.0',
      usage,
      requestId: null,
    };
    return {
      status: 'success',
      reason: 'none',
      value: 'beta',
      uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: this.confidence, distribution: { alpha: 1 - this.confidence, beta: this.confidence }, calibrationRef: null },
      actualModel: 'jev-1.13.0',
      usage,
      requestId: null,
    };
  }
}

function enabledEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AIWG_DECISION_ENABLED: '1', JEV_API_KEY: SECRET, ...extra };
}

describe('decision ask', () => {
  let directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    directories = [];
  });

  async function configHome(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'aiwg-ask-'));
    directories.push(directory);
    return directory;
  }

  function scripted(values: Array<number | 'abstain' | 'error'>, delayMs = 0) {
    let calls = 0;
    let active = 0;
    let peak = 0;
    const adapter = new FakeAdapter();
    const evaluate = vi.spyOn(adapter, 'evaluate').mockImplementation(async request => {
      const value = values[calls++ % values.length]!;
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (value === 'error') throw new Error('fake Jev failure');
        if (value === 'abstain') return { ...await new FakeAdapter().evaluate(request), status: 'abstained', reason: 'insufficient-information', value: undefined, uncertainty: null } as AdapterObservation;
        return new FakeAdapter(value).evaluate(request);
      } finally { active -= 1; }
    });
    return { adapter, evaluate, peak: () => peak };
  }

  it('runs ten independent unanimous passes with bounded concurrency and summed usage', async () => {
    const fake = scripted([0.93]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, escalationPasses: 20 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result).toMatchObject({ status: 'answered', answer: true, usage: { inputTokens: 120, outputTokens: 30 },
      aggregate: { passesRequested: 10, escalationPasses: 20, passesRun: 10, escalated: false, agreementRatio: 1, earlyStop: null,
        votes: { true: 10, false: 0 }, confidenceSummary: { count: 10, missing: 0 } } });
    expect(result.confidence).toBeCloseTo(0.93);
    expect(fake.evaluate).toHaveBeenCalledTimes(10);
    expect(fake.peak()).toBeLessThanOrEqual(4);
    expect(new Set(fake.evaluate.mock.calls.map(([request]) => request.invocationId)).size).toBe(10);
    expect(result.aggregate?.passes).toHaveLength(10);
  });

  it('escalates a split first round to twenty total and accepts a recovered modal answer', async () => {
    const fake = scripted([0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.05, 0.05, 0.05, 0.05, ...Array(10).fill(0.95)]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, escalationPasses: 20 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result).toMatchObject({ status: 'answered', answer: true,
      aggregate: { passesRun: 20, escalated: true, agreementRatio: 0.8, earlyStop: null } });
    expect(result.confidence).toBeCloseTo(0.8 * 0.95);
    expect(fake.evaluate).toHaveBeenCalledTimes(20);
  });

  it('falls back after twenty passes when the last wave preserves low agreement', async () => {
    const fake = scripted([...Array(9).fill(0.99), 0.01, ...Array(9).fill(0.99), 0.01]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, escalationPasses: 20, threshold: 0.95 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result).toMatchObject({ status: 'fallback', reason: 'low-agreement',
      aggregate: { escalated: true, passesRun: 20, agreementRatio: 0.9, earlyStop: null } });
  });

  it('stops a certain split failure early against the final escalation budget', async () => {
    const fake = scripted([0.95, 0.05]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, escalationPasses: 20 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result).toMatchObject({ status: 'fallback', reason: 'low-agreement',
      aggregate: { escalated: true, earlyStop: 'certain-failure', passesRun: 10, agreementRatio: 0.5 } });
  });

  it.each(['abstain', 'error'] as const)('handles a %s without trusting the other passes', async failure => {
    const fake = scripted([0.95, failure, 0.95, 0.95]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, escalationPasses: 20 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result.status).toBe('fallback');
    expect(result.aggregate).toMatchObject({ escalated: true, earlyStop: 'certain-failure', passesRun: 4 });
    expect(result.aggregate?.passes.some(pass => pass.status === (failure === 'abstain' ? 'abstained' : 'failed'))).toBe(true);
  });

  it('escalates low mean confidence and reports the confidence summary on fallback', async () => {
    const fake = scripted([0.75]);
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 2, escalationPasses: 4 }, {
      env: enabledEnv(), adapter: fake.adapter,
    });
    expect(result).toMatchObject({ status: 'fallback', reason: 'low-confidence',
      aggregate: { escalated: true, passesRun: 4, agreementRatio: 1, confidenceSummary: { mean: 0.75 } } });
  });

  it('shares one timeout across waves and aborts in-flight passes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const fake = scripted([0.95], 40);
      const resultPromise = askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 16, timeoutMs: 100 }, {
        env: enabledEnv(), adapter: fake.adapter,
      });
      const waitForCalls = async (count: number) => {
        for (let step = 0; step < 10000 && fake.evaluate.mock.calls.length < count; step++) {
          await new Promise(resolve => setImmediate(resolve));
        }
        expect(fake.evaluate).toHaveBeenCalledTimes(count);
      };
      await waitForCalls(4);
      await vi.advanceTimersByTimeAsync(40);
      await waitForCalls(8);
      await vi.advanceTimersByTimeAsync(40);
      await waitForCalls(12);
      await vi.advanceTimersByTimeAsync(20);
      const result = await resultPromise;
      expect(result).toMatchObject({ status: 'fallback', reason: 'timeout', latencyMs: 100,
        aggregate: { earlyStop: 'timeout', passesRun: 12 } });
      expect(fake.evaluate).toHaveBeenCalledTimes(12);
      expect(fake.peak()).toBeLessThanOrEqual(4);
      expect(fake.evaluate.mock.calls.at(-1)?.[0].signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.evaluate).toHaveBeenCalledTimes(12);
    } finally { vi.useRealTimers(); }
  });

  it('bounds an injected evaluator that never resolves by the same ask deadline', async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(() => new Promise<never>(() => {}));
      const pending = askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 10, timeoutMs: 50 }, {
        env: enabledEnv(), evaluate,
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ status: 'fallback', reason: 'timeout', aggregate: { passesRun: 4, earlyStop: 'timeout' } });
      expect(evaluate).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });

  it('uses modal scale buckets and choice ids across repeated samples', async () => {
    for (const mode of [{ kind: 'scale', low: 1, high: 5 }, { kind: 'choices', choices: ['alpha', 'beta'] }] as Array<Parameters<typeof askDecision>[0]['mode']>) {
      const result = await askDecision({ question: 'Pick', mode, passes: 3 }, { env: enabledEnv(), adapter: new FakeAdapter(0.9) });
      expect(result).toMatchObject({ status: 'answered', answer: mode.kind === 'scale' ? 3 : 'beta',
        aggregate: { passesRun: 3, agreementRatio: 1 } });
    }
  });

  it('loads project defaults, validates config on read/write, and applies explicit overrides', async () => {
    const cwd = await configHome();
    await mkdir(path.join(cwd, '.aiwg'));
    const defaultFake = scripted([0.93]);
    const defaultResult = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, { cwd, env: enabledEnv(), adapter: defaultFake.adapter });
    expect(defaultResult.aggregate).toMatchObject({ passesRequested: 5, escalationPasses: 10, passesRun: 5, escalated: false });
    expect(defaultFake.evaluate).toHaveBeenCalledTimes(5);
    const config = { ...emptyConfig(), decision: { ask: { passes: 3, escalation_passes: 6 } } };
    await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(config));
    expect((await readAiwgConfigCandidate(cwd))?.decision?.ask?.passes).toBe(3);
    const fromConfig = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, { cwd, env: enabledEnv(), adapter: new FakeAdapter() });
    expect(fromConfig.aggregate).toMatchObject({ passesRequested: 3, passesRun: 3, escalationPasses: 6 });
    const overridden = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 2, escalationPasses: 4 }, {
      cwd, env: enabledEnv(), adapter: new FakeAdapter(),
    });
    expect(overridden.aggregate).toMatchObject({ passesRequested: 2, passesRun: 2, escalationPasses: 4 });
    const verificationFake = scripted([0.93]);
    await setupJev({ token: SECRET, verify: true }, { cwd, configHome: cwd, env: {}, adapter: verificationFake.adapter });
    expect(verificationFake.evaluate).toHaveBeenCalledTimes(1);
    for (const ask of [{ passes: 0 }, { passes: 1.2 }, { passes: '10' }, { passes: 3, escalation_passes: 2 }, { escalation_passes: 0 }]) {
      const invalid = { ...config, decision: { ask } };
      await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(invalid));
      await expect(readAiwgConfigCandidate(cwd)).rejects.toThrow(/decision.ask/);
      await expect(writeAiwgConfig(cwd, invalid as any)).rejects.toThrow(/decision.ask/);
    }
  });

  it.each([{ passes: 0 }, { passes: 2.5 }, { passes: 3, escalationPasses: 2 }, { escalationPasses: NaN }])('rejects invalid sampling input %j', async sampling => {
    await expect(askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, ...sampling }, { env: enabledEnv(), adapter: new FakeAdapter() }))
      .rejects.toBeInstanceOf(DecisionAskUsageError);
  });

  it('answers yes-no using truth probability', async () => {
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' }, passes: 1 }, { env: enabledEnv(), adapter: new FakeAdapter(0.93) });
    expect(result).toMatchObject({
      schema: 'aiwg-decision-ask/v1',
      status: 'answered',
      answer: true,
      confidence: 0.93,
      probability: 0.93,
      fallback: null,
      model: 'jev-1.13.0',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('answers bounded choices', async () => {
    const result = await askDecision({
      question: 'Pick one',
      mode: { kind: 'choices', choices: ['alpha', 'beta'] }, passes: 1,
    }, { env: enabledEnv(), adapter: new FakeAdapter(0.91) });
    expect(result).toMatchObject({ status: 'answered', answer: 'beta', confidence: 0.91 });
  });

  it('answers ordinal scales in caller scale coordinates', async () => {
    const result = await askDecision({
      question: 'Severity?',
      mode: { kind: 'scale', low: 1, high: 5 },
    }, { env: enabledEnv(), adapter: new FakeAdapter(0.9) });
    expect(result).toMatchObject({ status: 'answered', answer: 3, confidence: 0.9 });
  });

  it('falls back below threshold', async () => {
    const result = await askDecision({
      question: 'Pick one',
      mode: { kind: 'choices', choices: ['alpha', 'beta'] },
      threshold: 0.8,
    }, { env: enabledEnv(), adapter: new FakeAdapter(0.6) });
    expect(result).toMatchObject({ status: 'fallback', fallback: 'llm', reason: 'low-confidence', answer: null, confidence: null });
  });

  it('falls back when not configured or not enabled', async () => {
    const home = await configHome();
    const result = await askDecision({
      question: 'Proceed?',
      mode: { kind: 'yes-no' },
    }, { env: { XDG_CONFIG_HOME: home }, configHome: home, adapter: new FakeAdapter() });
    expect(result).toMatchObject({ status: 'fallback', reason: 'not-configured', fallback: 'llm' });
  });

  it('refuses insecure credential files', async () => {
    const home = await configHome();
    const file = jevCredentialPath({ configHome: home });
    await setupJev({ token: SECRET }, { configHome: home, env: {} });
    await chmod(file, 0o644);
    await expect(lookupJevCredential({ configHome: home, env: {} })).rejects.toMatchObject({ category: 'denied' });
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, { configHome: home, env: {}, adapter: new FakeAdapter() });
    expect(result).toMatchObject({ status: 'fallback', reason: 'not-configured' });
  });

  it('never includes the token in ask or setup output', async () => {
    const home = await configHome();
    const setup = await setupJev({ token: SECRET, region: 'us' }, { configHome: home, env: {} });
    const ask = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
      configHome: home,
      env: {},
      adapter: new FakeAdapter(),
    });
    expect(JSON.stringify({ setup, ask })).not.toContain(SECRET);
    expect(await readFile(jevCredentialPath({ configHome: home }), 'utf8')).toContain(SECRET);
    expect((await stat(jevCredentialPath({ configHome: home }))).mode & 0o777).toBe(0o600);
  });

  it('rejects context over 32 KiB as a usage error', async () => {
    await expect(askDecision({
      question: 'Proceed?',
      mode: { kind: 'yes-no' },
      context: 'x'.repeat(32 * 1024 + 1),
    }, { env: enabledEnv(), adapter: new FakeAdapter() })).rejects.toBeInstanceOf(DecisionAskUsageError);
  });

  it('validates choice and scale usage', async () => {
    await expect(askDecision({ question: 'Pick', mode: { kind: 'choices', choices: ['a', 'a'] } }, {
      env: enabledEnv(), adapter: new FakeAdapter(),
    })).rejects.toMatchObject({ reason: 'invalid-choices' });
    await expect(askDecision({ question: 'Score', mode: { kind: 'scale', low: 1, high: 20 } }, {
      env: enabledEnv(), adapter: new FakeAdapter(),
    })).rejects.toMatchObject({ reason: 'invalid-scale' });
  });

  it('verifies setup through the injectable adapter path', async () => {
    const home = await configHome();
    const result = await setupJev({ token: SECRET, verify: true }, {
      configHome: home,
      env: {},
      adapter: new FakeAdapter(),
    });
    expect(result).toMatchObject({ configured: true, credentialSource: 'file', verified: true, model: 'jev-1.13.0' });
  });

  it('removes the credential file', async () => {
    const home = await configHome();
    await setupJev({ token: SECRET }, { configHome: home, env: {} });
    const result = await setupJev({ remove: true }, { configHome: home, env: {} });
    expect(result).toMatchObject({ configured: false });
    await expect(readFile(jevCredentialPath({ configHome: home }), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses injected evaluation for timeout-like fallback paths', async () => {
    const evaluate = vi.fn(async () => ({
      apiVersion: 'decision.aiwg.io/v1alpha2',
      kind: 'RulesetResult',
      metadata: { id: 'x', version: '1.0.0', description: 'x' },
      spec: {
        ruleset: { id: 'x', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
        binding: { id: 'x', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
        runId: 'x',
        invocationId: 'x',
        status: 'review',
        reason: 'timeout',
        matchedRules: [],
        evaluations: {},
      },
    } as any));
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
      env: enabledEnv(),
      evaluate,
    });
    expect(result).toMatchObject({ status: 'fallback', reason: 'timeout' });
  });

  it('accepts a live-recorded Jev score whose two-decimal rounding moves the mean by 0.02', async () => {
    // Recorded from jev-1.13.0 on 2026-10-05: weighted mean 3.98 against a reported score of 3.96.
    const legend = Object.fromEntries([1, 2, 3, 4, 5].map((level, index) => [String(index),
      `Level ${level} on a 1 to 5 scale${level === 1 ? ' (lowest)' : level === 5 ? ' (highest)' : ''}.`]));
    const body = { model: 'jev-1.13.0', answers: { answer: { type: 'score', score: 3.96, confidence: 0.97, legend,
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.02, 4: 0.98 } } }, usage: { input_tokens: 402, output_tokens: 17 } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await askDecision({ question: 'Severity of: production login is down', mode: { kind: 'scale', low: 1, high: 5 }, passes: 1 }, {
      env: enabledEnv(),
      createAdapter: ({ region }) => new JevDecisionAdapter({ region, fetch: fetch as unknown as typeof globalThis.fetch }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'answered', answer: 5, confidence: 0.98, model: 'jev-1.13.0' });
  });
});
