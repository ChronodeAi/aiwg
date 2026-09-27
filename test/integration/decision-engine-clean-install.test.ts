import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireDirectoryLock } from '../../src/artifacts/prebuilt-build-lock.js';

// Clean-install evidence for the decision-engine addon (#2641): pack the
// repository, unpack the tarball as an empty project's node_modules/aiwg, deploy
// the addon from the installed package, and run the deployed dispatcher on the
// shipped fixture request. Requires `npm run build` (the packaging lane builds first).
//
// Only the packed files are under test. Third-party dependencies resolve from
// the repository's locked install (linked one level above the project), so the
// test needs no registry or npm cache: an offline `npm install` of the tarball
// fails in CI because `npm ci` does not cache every packument npm resolves.
const ROOT = path.resolve(import.meta.dirname, '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SKILL = path.join('.claude', '.aiwg', 'skills', 'decision-evaluate');
const PLAYGROUND = path.join('.claude', '.aiwg', 'skills', 'decision-playground');
const EXAMPLES = path.join('node_modules', 'aiwg', 'agentic', 'code', 'addons', 'decision-engine', 'examples');

let tempRoot = '';
let consumer = '';
let installRoot = '';
let home = '';

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: options.cwd, env: options.env, encoding: 'utf8',
    timeout: options.timeout ?? 180_000, maxBuffer: 64 * 1024 * 1024,
  });
}

function ok(result: SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, [result.stderr, result.stdout].join('\n')).toBe(0);
  return result;
}

// No AIWG_ROOT, npm config, provider credentials or PATH: the deployed script
// must find the runtime from the project install alone.
function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NO_UPDATE_NOTIFIER: '1', AIWG_LOG_LEVEL: 'silent', ...extra,
  };
}

function aiwg(args: string[], cwd = consumer): SpawnSyncReturns<string> {
  return run(process.execPath, [path.join(installRoot, 'bin', 'aiwg.mjs'), ...args], {
    cwd, env: isolatedEnv({ PATH: process.env.PATH }), timeout: 300_000,
  });
}

function dispatch(script: string, request: string, cwd: string, extra: NodeJS.ProcessEnv = {},
  args: string[] = []): SpawnSyncReturns<string> {
  return run(process.execPath, [script, '--request', request, ...args], { cwd, env: isolatedEnv(extra), timeout: 120_000 });
}

describe('decision-engine clean install from the packed tarball', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-decision-clean-install-'));
    home = path.join(tempRoot, 'home');
    consumer = path.join(tempRoot, 'consumer');
    await mkdir(home, { recursive: true });
    await mkdir(consumer, { recursive: true });
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.toLowerCase().startsWith('npm_config_') && key !== 'AIWG_ROOT' && key !== 'NODE_OPTIONS'));

    const releasePackLock = await acquireDirectoryLock(path.join(ROOT, 'prebuilt', 'fortemi-core', '.framework-build.lock'));
    let pack: SpawnSyncReturns<string>;
    try {
      pack = run(NPM, ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot], { cwd: ROOT, env: cleanEnv, timeout: 120_000 });
    } finally {
      await releasePackLock();
    }
    ok(pack);
    const tarball = path.join(tempRoot, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);

    const unpacked = path.join(tempRoot, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    ok(run('tar', ['-xzf', tarball, '-C', unpacked], { cwd: tempRoot, env: cleanEnv }));
    await mkdir(path.join(consumer, 'node_modules'), { recursive: true });
    installRoot = path.join(consumer, 'node_modules', 'aiwg');
    await rename(path.join(unpacked, 'package'), installRoot);
    await symlink(path.join(ROOT, 'node_modules'), path.join(tempRoot, 'node_modules'), 'junction');
  }, 600_000);

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('ships the addon examples, runtime locator and compiled runtime', () => {
    for (const relative of [
      'dist/src/decision/index.js',
      'agentic/code/addons/decision-engine/manifest.json',
      'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/runtime-root.mjs',
      'agentic/code/addons/decision-engine/examples/dispatcher-request-llm.json',
      'agentic/code/addons/decision-engine/examples/fixture-llm-adapter.mjs',
      'agentic/code/addons/decision-engine/examples/binding-jev.json',
      'tools/decision/jev-live-smoke.mjs',
    ]) expect(existsSync(path.join(installRoot, relative)), relative).toBe(true);
  });

  it('imports experimental graph APIs and compiles their declarations from the tarball', async () => {
    const names = [
      'DecisionGraphError', 'planDecisionGraph', 'decisionGraphToFlow', 'decisionGraphApprovalGateId',
      'admittedDecisionFlowAdapter', 'decisionRulesetFlowInvoker', 'decisionResultNodeStatus',
      'decisionEvaluateSkillFlowInvoker', 'resolveDecisionEvaluateSkill', 'runDecisionEvaluateSkill',
      'GraphBudgetLedger', 'auditGraphEvidence', 'effectiveGraphCeilings', 'finalizeDecisionGraphRun',
      'FileGraphRunReceiptStore', 'decisionGraphParallelDispatch', 'selectDecisionBeam', 'graphBeamFlowInvoker',
      'shortlistRerankTemplate', 'taxonomyBeamTemplate', 'extractorVerifierFallbackTemplate',
    ];
    const probe = path.join(consumer, 'graph-probe.mjs');
    await writeFile(probe, `
      import assert from 'node:assert/strict';
      import * as graph from 'aiwg/decision/graph';
      for (const name of ${JSON.stringify(names)}) assert.equal(typeof graph[name], 'function', name);
      for (const name of ['decisionFlowNode', 'assertDecisionFlowPins', 'decisionFlowResponse', 'assertUnknownCostBound']) {
        assert.equal(name in graph, false, name);
      }
      assert.throws(() => graph.planDecisionGraph({}, new Set()), graph.DecisionGraphError);
      process.stdout.write('graph-import-ok');
    `);
    expect(ok(run(process.execPath, [probe], { cwd: consumer, env: isolatedEnv() })).stdout).toBe('graph-import-ok');

    const typeProbe = path.join(consumer, 'graph-probe.mts');
    await writeFile(typeProbe, `
      import { ${names.join(', ')} } from 'aiwg/decision/graph';
      import type {
        DecisionGraph, GraphPin, GraphPlan, GraphFlowRequest, GraphFlowResponse, GraphFlowEstimate,
        DecisionResultProjection, DecisionEvaluateSkill, DecisionSkillRequest, DecisionSkillRun,
        GraphObservation, GraphCeilings, GraphEvidenceReceipt, GraphFlowReport, GraphRunReceipt, DecisionGraphTemplate,
      } from 'aiwg/decision/graph';
      export const runtime = [${names.join(', ')}];
      export type Contracts = [DecisionGraph, GraphPin, GraphPlan, GraphFlowRequest, GraphFlowResponse,
        GraphFlowEstimate, DecisionResultProjection, DecisionEvaluateSkill, DecisionSkillRequest, DecisionSkillRun,
        GraphObservation, GraphCeilings, GraphEvidenceReceipt, GraphFlowReport, GraphRunReceipt, DecisionGraphTemplate];
      export const planner: (value: unknown, pins: ReadonlySet<string>) => GraphPlan = planDecisionGraph;
    `);
    ok(run(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'),
      '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', typeProbe],
    { cwd: consumer, env: isolatedEnv() }));
  }, 180_000);

  it('deploys the addon by name and runs the deployed dispatcher on the fixture request', async () => {
    ok(aiwg(['use', 'decision-engine', '--provider', 'claude']));
    const script = path.join(consumer, SKILL, 'scripts', 'decision-evaluate.mjs');
    expect(existsSync(script)).toBe(true);
    expect(existsSync(path.join(consumer, SKILL, 'scripts', 'runtime-root.mjs'))).toBe(true);

    const request = path.join(consumer, EXAMPLES, 'dispatcher-request-llm.json');
    const disabled = dispatch(script, request, consumer);
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('AIWG_DECISION_ENABLED=1');

    const result = ok(dispatch(script, request, consumer, { AIWG_DECISION_ENABLED: '1' }));
    const outcome = JSON.parse(result.stdout);
    expect(outcome.kind).toBe('RulesetResult');
    expect(outcome.spec.status).toBe('completed');
    expect(outcome.spec.ruleset.id).toBe('example-triage');
  }, 600_000);

  it('runs trusted host policies for native batching, replay and projection denial from the installed dispatcher', async () => {
    const script = path.join(consumer, SKILL, 'scripts', 'decision-evaluate.mjs');
    const state = path.join(tempRoot, 'host-policy-state');
    await mkdir(state, { recursive: true });
    const fakeAdapter = path.join(consumer, 'installed-fake-jev.mjs');
    await writeFile(fakeAdapter, [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { JevDecisionAdapter } from 'aiwg/decision';",
      "const logPath = join(process.env.AIWG_TEST_HOST_POLICY_STATE, 'dispatch-log.json');",
      "function log(body) { const prior = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []; prior.push(body); writeFileSync(logPath, JSON.stringify(prior)); }",
      "function answers(body) { return Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === 'choice'",
      "  ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }",
      "  : question.type === 'score' ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },",
      "    legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.', 2: 'Core functions unavailable.' }, confidence: 0.8 }",
      "  : { type: 'noul', noul: 0.05 }])); }",
      "export default new JevDecisionAdapter({ region: 'us', fetch: async (_url, init) => {",
      "  const body = JSON.parse(String(init.body)); log(body);",
      "  return new Response(JSON.stringify({ answers: answers(body), model: 'jev-fixture', usage: { input_tokens: 9, output_tokens: 3 } }), { status: 200 });",
      "} });",
    ].join('\n'), { mode: 0o600 });
    const networkAdapter = path.join(consumer, 'installed-network-jev.mjs');
    await writeFile(networkAdapter, [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { JevDecisionAdapter } from 'aiwg/decision';",
      "const logPath = join(process.env.AIWG_TEST_HOST_POLICY_STATE, 'network-dispatch-log.json');",
      "function log(body) { const prior = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []; prior.push(body); writeFileSync(logPath, JSON.stringify(prior)); }",
      "export default new JevDecisionAdapter({ region: 'us', fetch: async (_url, init) => {",
      "  const body = JSON.parse(String(init.body)); log(body);",
      "  return new Response(JSON.stringify({ answers: {}, model: 'jev-fixture', usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200 });",
      "} });",
    ].join('\n'), { mode: 0o600 });
    const hostModule = path.join(consumer, 'decision-host-policies.mjs');
    await writeFile(hostModule, [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { CanonicalJsonByteEstimator, DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION,",
      "  FileBatchReceiptStore, FileBatchResultStore, compareContextUsage, decisionBatchQuestionId, planDecisionContext } from 'aiwg/decision';",
      "const state = process.env.AIWG_TEST_HOST_POLICY_STATE;",
      "const input = JSON.parse(readFileSync(process.env.AIWG_TEST_HOST_POLICY_INPUT, 'utf8'));",
      "const lifecycle = { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface,",
      "  { classification: 'restricted', accessScopes: ['batch-owner'], retentionMs: 86400000, export: 'denied', deletion: 'tombstone', backup: 'expire-with-primary' }])) };",
      "const integrityKey = new Uint8Array(32).fill(11);",
      "const results = new FileBatchResultStore(join(state, 'results'), { integrityKey, lifecycle, encryptionKeyReference: 'test-key',",
      "  resolveEncryptionKey: async () => Buffer.from(new Uint8Array(32).fill(12)) });",
      "const estimator = new CanonicalJsonByteEstimator();",
      "const questionIds = ['category', 'severity', 'core_unavailable'].map(decisionBatchQuestionId);",
      "const contextInput = { subject: 'ticket:42', authorizedState: input, authorizationDigest: `sha256:${'a'.repeat(64)}`,",
      "  incompleteContext: false, questions: questionIds.map(id => ({ id, subject: 'ticket:42', entry: { question: id } })) };",
      "const contextProfile = { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version },",
      "  limits: { aggregateTokens: 100000, stateAndLongestQuestionTokens: 100000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 };",
      "const contextPlan = planDecisionContext(contextInput,",
      "  { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version },",
      "    limits: { aggregateTokens: 100000, stateAndLongestQuestionTokens: 100000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 }, estimator);",
      "const qualification = compareContextUsage([{ caseId: 'installed-host-policy', input: contextInput,",
      "  actualInputTokens: contextPlan.partitions[0].estimate.aggregateTokens, source: 'provider', usageRef: 'fixture:installed-host-policy' }], contextProfile, estimator);",
      "export const decisionHostPolicies = {",
      "  batching: { native: { enabled: true, evaluations: Object.fromEntries(['category', 'severity', 'core_unavailable'].map(alias => [alias,",
      "    { decisionSubject: 'ticket:42', independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'installed-host-v1' }])) } },",
      "  context: { qualified: { input: contextInput, profile: contextProfile, estimator, rollout: { mode: 'enforce', qualification } } },",
      "  batchReceipts: { durable: { store: new FileBatchReceiptStore(join(state, 'receipts'), { integrityKey, lifecycle, results }), resultStore: results,",
      "    tenantId: 'tenant', projectId: 'project', contextPlan, subjectHash: `sha256:${'b'.repeat(64)}` } }",
      "};",
    ].join('\n'), { mode: 0o600 });
    const requestPath = path.join(consumer, 'trusted-host-request.json');
    await writeFile(requestPath, JSON.stringify({
      rulesetPath: path.join(consumer, EXAMPLES, 'ruleset.json'),
      bindingPath: path.join(consumer, EXAMPLES, 'binding-jev.json'),
      definitionPaths: ['decision-category.json', 'decision-severity.json', 'decision-core_unavailable.json']
        .map(name => path.join(consumer, EXAMPLES, name)),
      inputPath: path.join(consumer, EXAMPLES, 'input.json'),
      projectionPolicyPath: path.join(consumer, EXAMPLES, 'projection-policy-jev.json'),
      runId: 'installed-host-policy-run', invocationId: 'installed-host-policy-invocation',
      credentials: { 'typesafe-api': 'AIWG_TEST_DISPATCH_TOKEN', 'receipt-key': 'AIWG_TEST_RECEIPT_KEY' },
      adapterModules: { jev: fakeAdapter },
      hostPolicies: { batching: 'native' },
    }));
    const env = { AIWG_DECISION_ENABLED: '1', AIWG_TEST_DISPATCH_TOKEN: 'synthetic-token',
      AIWG_TEST_RECEIPT_KEY: '11'.repeat(32),
      AIWG_TEST_HOST_POLICY_STATE: state, AIWG_TEST_HOST_POLICY_INPUT: path.join(consumer, EXAMPLES, 'input.json') };
    const args = ['--host-policy-module', hostModule];
    const first = ok(dispatch(script, requestPath, consumer, env, args));
    const firstOutcome = JSON.parse(first.stdout);
    expect(firstOutcome.spec.status).not.toBe('error');
    expect(Object.values(firstOutcome.spec.evaluations).map((value: any) => value.spec.attempts[0]?.batch?.mode))
      .toEqual(['native', 'native', 'native']);
    const deniedPolicy = JSON.parse(await readFile(path.join(consumer, EXAMPLES, 'projection-policy-jev.json'), 'utf8'));
    deniedPolicy.region = 'eu';
    const deniedPolicyPath = path.join(consumer, 'projection-denied.json');
    await writeFile(deniedPolicyPath, JSON.stringify(deniedPolicy));
    const deniedRequest = path.join(consumer, 'trusted-host-denied-request.json');
    await writeFile(deniedRequest, JSON.stringify({ ...JSON.parse(await readFile(requestPath, 'utf8')),
      invocationId: 'installed-host-policy-denied', projectionPolicyPath: deniedPolicyPath,
      receiptDirectory: path.join(state, 'denied-invocation-receipts'),
      adapterModules: { jev: networkAdapter } }));
    const denied = dispatch(script, deniedRequest, consumer, env, args);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('projection field is not authorized');
    await expect(readFile(path.join(state, 'network-dispatch-log.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  }, 600_000);

  it('runs the deployed decision-playground against the installed runtime', () => {
    const script = path.join(consumer, PLAYGROUND, 'scripts', 'decision-playground.mjs');
    expect(existsSync(path.join(consumer, PLAYGROUND, 'scripts', 'runtime-root.mjs'))).toBe(true);
    const listed = ok(run(process.execPath, [script, 'list'], { cwd: consumer, env: isolatedEnv(), timeout: 120_000 }));
    expect((JSON.parse(listed.stdout) as unknown[]).length).toBeGreaterThan(0);
    const receipt = ok(run(process.execPath, [script, 'run', 'guardrails', '--fixture', 'guardrail-noul-midpoint', '--summary'],
      { cwd: consumer, env: isolatedEnv(), timeout: 120_000 }));
    expect(JSON.parse(receipt.stdout)).toMatchObject({ executionMode: 'offline-recorded' });
  }, 180_000);

  // D18/G6 (#2606 AC18): the installed package runs the real file-store review
  // fixtures with network primitives disabled, and a non-permissive pinned
  // authorization produces zero unauthorized effects.
  it('runs the installed durable-review G6 fixtures with zero unauthorized effects', async () => {
    const state = path.join(tempRoot, 'review-g6-state');
    await mkdir(state, { recursive: true });
    const probe = path.join(consumer, 'review-g6-probe.mjs');
    await writeFile(probe, [
      "import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';",
      "import dns from 'node:dns'; import dgram from 'node:dgram'; import http2 from 'node:http2'; import { pathToFileURL } from 'node:url';",
      "let attempts = 0; const deny = () => { attempts += 1; throw new Error('review G6 probe forbids network access'); };",
      'net.connect = deny; net.createConnection = deny; tls.connect = deny; http.request = deny; http.get = deny;',
      'https.request = deny; https.get = deny; dns.lookup = deny; dns.resolve = deny; dns.promises.lookup = deny;',
      'dns.promises.resolve = deny; dgram.createSocket = deny; http2.connect = deny; globalThis.fetch = deny;',
      'const [entry, directory] = process.argv.slice(2);',
      'const api = await import(pathToFileURL(entry).href);',
      'const durable = await api.runOfflineDurableReviewFixture(directory);',
      'const matrix = await api.runOfflineReviewMatrixFixture(directory);',
      'const authorization = await api.runOfflineReviewAuthorizationFixture(directory);',
      'process.stdout.write(JSON.stringify({ durable, matrix, authorization, attempts }));',
    ].join('\n'), { mode: 0o600 });
    const entry = path.join(installRoot, 'dist', 'src', 'decision', 'index.js');
    const result = ok(run(process.execPath, [probe, entry, state], { cwd: consumer, env: isolatedEnv(), timeout: 120_000 }));
    const evidence = JSON.parse(result.stdout);
    expect(evidence.attempts).toBe(0);
    expect(evidence.durable).toMatchObject({ store: 'file-decision-review-store', restarted: true, executorCalls: 1 });
    expect(evidence.matrix).toMatchObject({ executorCalls: 1, lateDenied: true, duplicateResumeReturnedReceipt: true });
    expect(evidence.authorization).toMatchObject({ authorization: 'pinned-review-authorization', restarted: true,
      unauthorizedEffects: 0, authorizedEffects: 1, authorizationDeniedEvents: 2, duplicateResumeReturnedReceipt: true });
    expect(evidence.authorization.deniedAttempts).toHaveLength(11);
  }, 180_000);

  it('resolves the runtime through AIWG_ROOT when the script is outside any install', async () => {
    const detached = path.join(tempRoot, 'detached');
    await cp(path.join(consumer, SKILL), detached, { recursive: true });
    const script = path.join(detached, 'scripts', 'decision-evaluate.mjs');
    const request = path.join(consumer, EXAMPLES, 'dispatcher-request-llm.json');

    const missing = dispatch(script, request, tempRoot, { AIWG_DECISION_ENABLED: '1' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Cannot locate the aiwg decision runtime');

    const rooted = ok(dispatch(script, request, tempRoot, { AIWG_DECISION_ENABLED: '1', AIWG_ROOT: installRoot }));
    expect(JSON.parse(rooted.stdout).spec.status).toBe('completed');
  }, 120_000);

  it('keeps the addon out of bulk deploys', async () => {
    const bulk = path.join(tempRoot, 'bulk');
    await mkdir(bulk, { recursive: true });
    ok(aiwg(['use', 'all', '--copy-all', '--provider', 'claude', '--target', bulk], consumer));
    expect(existsSync(path.join(bulk, SKILL))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(installRoot, 'agentic/code/addons/decision-engine/manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ autoInstall: false, explicitInstall: true });
    // Other autoInstall:false addons (testing-quality here) are still deployed.
    expect(existsSync(path.join(bulk, '.claude', '.aiwg', 'skills', 'flaky-detect', 'SKILL.md'))).toBe(true);
  }, 600_000);
});
