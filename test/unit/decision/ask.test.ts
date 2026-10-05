import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('answers yes-no using truth probability', async () => {
    const result = await askDecision({ question: 'Proceed?', mode: { kind: 'yes-no' } }, { env: enabledEnv(), adapter: new FakeAdapter(0.93) });
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
      mode: { kind: 'choices', choices: ['alpha', 'beta'] },
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
    const result = await askDecision({ question: 'Severity of: production login is down', mode: { kind: 'scale', low: 1, high: 5 } }, {
      env: enabledEnv(),
      createAdapter: ({ region }) => new JevDecisionAdapter({ region, fetch: fetch as unknown as typeof globalThis.fetch }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'answered', answer: 5, confidence: 0.98, model: 'jev-1.13.0' });
  });
});
