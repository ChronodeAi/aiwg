import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyComparisonReport, quarterlySourceAvailability } from '../../../tools/release/release-evidence.mjs';
import { buildHermesArgs, hermesAdapter, parseHermesStream, runHermes } from '../../../tools/rules/release-compare-hermes.mjs';
import { validateSubject, DIMENSIONS, comparisonPlan, executeComparison, runnerAdapter } from '../../../tools/rules/release-compare.mjs';

const roots = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const line = events => events.map(JSON.stringify).join('\n');
function stream({ model = 'hermes-model', text = '{"action":"follow"}', tools = [] } = {}) {
  return line([{ type: 'system', subtype: 'init', model, session_id: 's', timestamp: 1 },
    ...tools, { type: 'text', text, timestamp: 2 },
    { type: 'result', session_id: 's', exit_code: 0, text, tokens: { input: 10, output: 4, total: 14, cache_read: 0, cache_write: 0 }, duration_ms: 2, timestamp: 3 }]);
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-hermes-')); roots.push(root);
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const launcher = path.join(root, 'launcher'); fs.writeFileSync(launcher, 'qualified launcher', { mode: 0o700 });
  const launcherHash = hash(fs.readFileSync(launcher));
  const receiptFile = path.join(root, 'qualification.json');
  const receipt = { schema: 'aiwg-hermes-boundary-qualification/v1', qualified: true, authenticated: false,
    controller: 'release-controller', producer: 'boundary-review', qualification_id: 'qualification-1', launcher_sha256: launcherHash,
    hermes_executable_sha256: '1'.repeat(64), hermes_version: '0.21.6+387.gdce1e9b', profile_sha256: '2'.repeat(64),
    controls: ['credential-isolation', 'owned-process-tree', 'stdout-jsonl', 'tool-network-deny', 'workspace-read-only'] };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
  const env = { PATH: '/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), HERMES_HOME: path.join(root, 'home/.hermes'),
    AIWG_ROOT: '/package', OPENAI_API_KEY: 'must-not-pass', ANTHROPIC_API_KEY: 'must-not-pass',
    AIWG_RELEASE_HERMES_LAUNCHER: launcher, AIWG_RELEASE_HERMES_LAUNCHER_SHA256: launcherHash,
    AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT: receiptFile, AIWG_RELEASE_HERMES_QUALIFICATION_CONTROLLER: receipt.controller,
    AIWG_RELEASE_HERMES_QUALIFICATION_PRODUCER: receipt.producer, AIWG_RELEASE_HERMES_QUALIFICATION_ID: receipt.qualification_id,
    AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256: hash(fs.readFileSync(receiptFile)), AIWG_RELEASE_HERMES_EXECUTABLE_SHA256: receipt.hermes_executable_sha256,
    AIWG_RELEASE_HERMES_BOUNDARY_PROFILE_SHA256: receipt.profile_sha256,
    AIWG_RELEASE_HERMES_AUTH_SOURCE: 'qualified-launcher', AIWG_RELEASE_HERMES_PROVIDER: 'openrouter',
    AIWG_RELEASE_HERMES_EFFORT: 'low', AIWG_RELEASE_HERMES_JUDGE_EFFORT: 'medium' };
  fs.mkdirSync(env.HOME); fs.mkdirSync(env.TMPDIR);
  const request = { protocol: 'aiwg-release-subject/v1', provider: 'hermes', model: 'hermes-model', prompt: 'Inspect applicable rules.', settings: { read_only: true }, fixture_identity: { package_version: '2026.10.4' } };
  return { root, cwd, launcher, receiptFile, receipt, env, request };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('Hermes release comparison adapter', () => {
  it('pins the official stream-json invocation and retains an explicitly unauthenticated boundary observation', async () => {
    const { cwd, env, request, launcher } = setup(); const calls = [];
    const output = stream({ tools: [
      { type: 'tool_use', name: 'terminal', input: { command: 'aiwg show rule delivery-policy' }, tool_call_id: 't1', timestamp: 2 },
      { type: 'tool_result', name: 'terminal', output: 'rule body', duration_ms: 1, is_error: false, tool_call_id: 't1', timestamp: 2 },
    ] });
    const result = await hermesAdapter(request, { cwd, env, spawn: (command, args, tier, options) => {
      calls.push({ command, args, tier, options });
      return calls.length === 1 ? { status: 0, stdout: 'Hermes Agent v0.21.6+387.gdce1e9b (test)' } : { status: 0, stdout: output, stderr: '' };
    } });
    expect(calls).toHaveLength(2); expect(calls[0].args).toEqual(['--version']); expect(calls[1].command).toBe(launcher);
    expect(calls[1].args).toEqual(['chat', '--query-file', '-', '--oneshot', '--quiet', '--format', 'stream-json', '--ignore-user-config', '--ignore-rules', '--source', 'tool', '--provider', 'openrouter', '-m', 'hermes-model', '--reasoning', 'low', '-t', 'terminal']);
    expect(calls[1].options.input).toBe(request.prompt); expect(calls[1].options.timeout).toBe(180000);
    expect(calls[1].options.env.OPENAI_API_KEY).toBeUndefined(); expect(calls[1].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[1].options.env.AIWG_RELEASE_HERMES_LAUNCHER).toBeUndefined();
    expect(result.trace.tools).toEqual([{ name: 'terminal', input: { command: 'aiwg show rule delivery-policy' }, output: 'rule body', success: true }]);
    expect(result.runtime_receipt).toMatchObject({ authenticated: false, provider: 'hermes', requested_provider: 'openrouter', requested_effort: 'low', qualification_authenticated: false, reported_remote_model: null, reported_remote_backend: null });
    expect(validateSubject(result, request.model, 'hermes').runtime_receipt).toEqual(result.runtime_receipt);
  });

  it('rejects missing or forged qualification before any process spawn', async () => {
    const { cwd, env, request, launcher, receiptFile, receipt } = setup(); let spawns = 0;
    const spawn = () => { spawns++; throw new Error('unexpected spawn'); };
    await expect(hermesAdapter(request, { cwd, env: { ...env, AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT: undefined }, spawn })).rejects.toThrow(/absolute/);
    expect(spawns).toBe(0);
    fs.writeFileSync(launcher, 'changed launcher', { mode: 0o700 });
    await expect(hermesAdapter(request, { cwd, env, spawn })).rejects.toThrow(/digest mismatch/);
    expect(spawns).toBe(0);
    fs.writeFileSync(launcher, 'qualified launcher', { mode: 0o700 });
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, launcher_sha256: 'f'.repeat(64) }), { mode: 0o600 });
    await expect(hermesAdapter(request, { cwd, env: { ...env, AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256: hash(fs.readFileSync(receiptFile)) }, spawn })).rejects.toThrow(/qualification/);
    expect(spawns).toBe(0);
  });

  it('requires explicit provider, effort, authentication source, and exact pinned version before inference', async () => {
    const { cwd, env, request } = setup(); let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: 'Hermes Agent v0.21.6+387.gdce1e9b' }; };
    for (const bad of [
      { AIWG_RELEASE_HERMES_AUTH_SOURCE: 'ambient' }, { AIWG_RELEASE_HERMES_PROVIDER: 'auto' }, { AIWG_RELEASE_HERMES_EFFORT: 'ultra' },
    ]) { calls = 0; await expect(hermesAdapter(request, { cwd, env: { ...env, ...bad }, spawn })).rejects.toThrow(); expect(calls).toBe(0); }
    await expect(hermesAdapter(request, { cwd, env, spawn: () => { calls++; return { status: 0, stdout: 'Hermes Agent v0.21.5' }; } })).rejects.toThrow(/pinned Hermes version/);
    expect(calls).toBe(1);
  });

  it('requires private boundary material outside fixture roots and detects execution-time mutation', async () => {
    const { cwd, env, request, launcher, receiptFile, receipt } = setup(); let calls = 0;
    const noSpawn = () => { calls++; throw new Error('unexpected spawn'); };
    fs.chmodSync(receiptFile, 0o644);
    await expect(hermesAdapter(request, { cwd, env, spawn: noSpawn })).rejects.toThrow(/unsafe permissions/);
    expect(calls).toBe(0); fs.chmodSync(receiptFile, 0o600);
    const fixtureLauncher = path.join(cwd, 'launcher'); fs.copyFileSync(launcher, fixtureLauncher); fs.chmodSync(fixtureLauncher, 0o700);
    const fixtureHash = hash(fs.readFileSync(fixtureLauncher));
    const fixtureReceipt = { ...receipt, launcher_sha256: fixtureHash }; fs.writeFileSync(receiptFile, JSON.stringify(fixtureReceipt), { mode: 0o600 });
    const fixtureEnv = { ...env, AIWG_RELEASE_HERMES_LAUNCHER: fixtureLauncher, AIWG_RELEASE_HERMES_LAUNCHER_SHA256: fixtureHash,
      AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256: hash(fs.readFileSync(receiptFile)) };
    await expect(hermesAdapter(request, { cwd, env: fixtureEnv, spawn: noSpawn })).rejects.toThrow(/outside fixture/);
    expect(calls).toBe(0);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    const stableEnv = { ...env, AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256: hash(fs.readFileSync(receiptFile)) };
    calls = 0;
    await expect(hermesAdapter(request, { cwd, env: stableEnv, spawn: () => {
      calls++; fs.writeFileSync(launcher, 'mutated by version probe', { mode: 0o700 });
      return { status: 0, stdout: 'Hermes Agent v0.21.6+387.gdce1e9b' };
    } })).rejects.toThrow(/changed during execution/);
    expect(calls).toBe(1);
    fs.writeFileSync(launcher, 'qualified launcher', { mode: 0o700 }); calls = 0;
    await expect(hermesAdapter(request, { cwd, env: stableEnv, spawn: (_command, _args, _tier, options) => {
      calls++; if (calls === 1) return { status: 0, stdout: 'Hermes Agent v0.21.6+387.gdce1e9b' };
      fs.writeFileSync(launcher, 'mutated after spawn', { mode: 0o700 }); return { status: 0, stdout: stream(), stderr: '' };
    } })).rejects.toThrow(/changed during execution/);
  });

  it('kills and rejects a successful launcher that leaves a descendant process alive', async () => {
    const { root, cwd } = setup(); const pidFile = path.join(root, 'descendant.pid'), launcher = path.join(root, 'leaky-launcher');
    fs.writeFileSync(launcher, `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdout.write('done');\n`, { mode: 0o700 });
    const started = Date.now();
    await expect(runHermes(launcher, [], 'long', { cwd, env: { PATH: '/bin' }, input: '', timeout: 2_000, maxBuffer: 1024 })).rejects.toThrow(/descendant/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8')), stat = `/proc/${pid}/stat`;
    if (fs.existsSync(stat)) expect(fs.readFileSync(stat, 'utf8').split(') ')[1][0]).toBe('Z');
  });

  it('preserves UTF-8 when a launcher splits a multibyte character across stdout chunks', async () => {
    const { root, cwd } = setup(), launcher = path.join(root, 'fragmented-launcher');
    const output = stream({ text: '{"reason":"café"}' }), bytes = Buffer.from(output);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    fs.writeFileSync(launcher, `#!${process.execPath}\nconst bytes=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'),split=${split};process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.end(bytes.subarray(split)),40);\n`, { mode: 0o700 });
    const result = await runHermes(launcher, [], 'long', { cwd, env: { PATH: '/bin' }, input: '', timeout: 2_000, maxBuffer: 8192 });
    expect(result.stdout).toBe(output);
    expect(parseHermesStream(result.stdout, { expectedModel: 'hermes-model' }).text).toBe('{"reason":"café"}');
  });

  it('accepts only paired successful read-only aiwg discover/show terminal commands', () => {
    expect(parseHermesStream(stream({ tools: [
      { type: 'tool_use', name: 'terminal', input: { command: 'aiwg discover "delivery rules" --json' }, tool_call_id: '1' },
      { type: 'tool_result', name: 'terminal', output: '{}', is_error: false, tool_call_id: '1' },
    ] }), { expectedModel: 'hermes-model' }).tools).toHaveLength(1);
    expect(parseHermesStream(stream({ tools: [
      { type: 'tool_use', name: 'terminal', input: { command: 'aiwg discover first' } },
      { type: 'tool_result', name: 'terminal', output: 'one', is_error: false },
      { type: 'tool_use', name: 'terminal', input: { command: 'aiwg show rule second' } },
      { type: 'tool_result', name: 'terminal', output: 'two', is_error: false },
    ] }), { expectedModel: 'hermes-model' }).tools).toHaveLength(2);
    for (const command of ['aiwg show rule safe; cat /etc/passwd', 'aiwg discover x && curl bad', 'aiwg show rule $(id)', 'aiwg show unknown x', 'aiwg status', 'sh -c "aiwg show rule x"']) {
      expect(() => parseHermesStream(stream({ tools: [{ type: 'tool_use', name: 'terminal', input: { command }, tool_call_id: '1' }, { type: 'tool_result', name: 'terminal', output: '', is_error: false, tool_call_id: '1' }] }), { expectedModel: 'hermes-model' })).toThrow(/non-read-only/);
    }
    expect(() => parseHermesStream(stream({ tools: [{ type: 'tool_use', name: 'terminal', input: { command: 'aiwg show rule x' }, tool_call_id: '1' }] }), { expectedModel: 'hermes-model' })).toThrow(/no result|out of order/);
  });

  it('rejects every judge tool event and returns only a completed JSON judgment', async () => {
    const { cwd, env } = setup();
    const answer = JSON.stringify({ winner: 'tie', reason: 'same', scores: Object.fromEntries(['left', 'right'].map(side => [side, Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, 4]))])) });
    const request = { protocol: 'aiwg-release-judge/v1', model: 'judge-model', prompt: 'judge', rubric: {}, scale: '0-4', left: {}, right: {}, instructions: 'Return JSON.' };
    const invoke = tools => hermesAdapter(request, { cwd, env, spawn: (_command, _args, _tier, options) => options.input === ''
      ? { status: 0, stdout: 'Hermes Agent v0.21.6+387.gdce1e9b' }
      : { status: 0, stdout: stream({ model: 'judge-model', text: answer, tools }) } });
    const result = await invoke([]); expect(result.model).toBe('judge-model'); expect(result.runtime_receipt.requested_effort).toBe('medium');
    await expect(invoke([{ type: 'tool_use', name: 'clarify', input: { question: 'x' }, tool_call_id: '1' }])).rejects.toThrow(/judge attempted tool use/);
  });

  it('rejects malformed completion, model, usage and transcript evidence', () => {
    expect(() => parseHermesStream(stream({ model: 'other' }), { expectedModel: 'hermes-model' })).toThrow(/model initialization/);
    const duplicate = `${stream()}\n${JSON.stringify({ type: 'result', exit_code: 0, text: 'x' })}`;
    expect(() => parseHermesStream(duplicate, { expectedModel: 'hermes-model' })).toThrow(/complete successfully/);
    const events = stream().split('\n').map(JSON.parse); events.at(-1).tokens.output = -1;
    expect(() => parseHermesStream(line(events), { expectedModel: 'hermes-model' })).toThrow(/usage/);
    events.at(-1).tokens.output = 1; events[1].text = 'different';
    expect(() => parseHermesStream(line(events), { expectedModel: 'hermes-model' })).toThrow(/differs/);
    const lateInit = stream().split('\n').map(JSON.parse); [lateInit[0], lateInit[1]] = [lateInit[1], lateInit[0]];
    expect(() => parseHermesStream(line(lateInit), { expectedModel: 'hermes-model' })).toThrow(/initialization/);
    const command = { type: 'tool_use', name: 'terminal', input: { command: 'aiwg show rule safe' }, tool_call_id: 'same' };
    const completed = { type: 'tool_result', name: 'terminal', output: 'body', is_error: false, tool_call_id: 'same' };
    const duplicateId = [{ type: 'system', subtype: 'init', model: 'hermes-model' }, command, completed, command, completed,
      { type: 'result', exit_code: 0, text: 'ok', tokens: {} }];
    expect(() => parseHermesStream(line(duplicateId), { expectedModel: 'hermes-model' })).toThrow(/duplicated/);
    const outOfOrder = [{ type: 'system', subtype: 'init', model: 'hermes-model' }, { ...command, tool_call_id: 'one' },
      { ...command, tool_call_id: 'two' }, { ...completed, tool_call_id: 'one' }, { ...completed, tool_call_id: 'two' },
      { type: 'result', exit_code: 0, text: 'ok', tokens: {} }];
    expect(() => parseHermesStream(line(outOfOrder), { expectedModel: 'hermes-model' })).toThrow(/out of order/);
    const textBeforeResult = [{ type: 'system', subtype: 'init', model: 'hermes-model' }, command, { type: 'text', text: 'early' }, completed,
      { type: 'result', exit_code: 0, text: 'early', tokens: {} }];
    expect(() => parseHermesStream(line(textBeforeResult), { expectedModel: 'hermes-model' })).toThrow(/completion is out of order/);
  });

  it('retains and revalidates Hermes stream, source and boundary digests in a complete report', () => {
    const { root, launcher, receiptFile, receipt, env } = setup();
    const answer = JSON.stringify({ winner: 'tie', reason: 'same', scores: Object.fromEntries(['left', 'right'].map(side => [side, Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, 4]))])) });
    fs.writeFileSync(launcher, `#!${process.execPath}\nconst fs=require('fs'); if(process.argv[2]==='--version'){console.log('Hermes Agent v0.21.6+387.gdce1e9b (fixture)');process.exit(0)}; const model=process.argv[process.argv.indexOf('-m')+1]; const judge=model==='judge-model'; fs.readFileSync(0); const text=judge?${JSON.stringify(answer)}:'{"action":"follow"}'; for(const event of [{type:'system',subtype:'init',model,session_id:'s',timestamp:1},{type:'text',text,timestamp:2},{type:'result',session_id:'s',exit_code:0,text,tokens:{input:1,output:1,total:2,cache_read:0,cache_write:0},duration_ms:1,timestamp:3}]) console.log(JSON.stringify(event));\n`, { mode: 0o700 });
    receipt.launcher_sha256 = hash(fs.readFileSync(launcher)); fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    const configured = { ...env, AIWG_RELEASE_HERMES_LAUNCHER_SHA256: receipt.launcher_sha256,
      AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256: hash(fs.readFileSync(receiptFile)) };
    const previous = Object.fromEntries(Object.keys(configured).filter(key => key.startsWith('AIWG_RELEASE_HERMES_')).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(configured)) if (key.startsWith('AIWG_RELEASE_HERMES_')) process.env[key] = value;
    try {
      const fixtures = Object.fromEntries(['A', 'B'].map(side => {
        const fixtureRoot = path.join(root, side), project = path.join(fixtureRoot, 'project'), packageRoot = path.join(fixtureRoot, 'package');
        fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"version":"2026.10.4"}'); fs.writeFileSync(path.join(packageRoot, 'bin/aiwg.mjs'), '');
        const identity = side === 'A' ? { spec: 'aiwg@2026.10.3', package_version: '2026.10.3', tarball_sha256: null, deployed_context_sha256: '1'.repeat(64), package_tree_sha256: '2'.repeat(64), installation_lock_sha256: '3'.repeat(64) }
          : { spec: 'tarball:/release/aiwg-2026.10.4.tgz', package_version: '2026.10.4', tarball_sha256: '4'.repeat(64), deployed_context_sha256: '5'.repeat(64), package_tree_sha256: '6'.repeat(64), installation_lock_sha256: '7'.repeat(64) };
        return [side, { root: fixtureRoot, project, packageRoot, identity: identity.spec, content_identity: identity }];
      }));
      const scenario = { id: 'hermes-case', domain: 'delivery', providers: ['hermes'], prompt: 'Return JSON', files: {}, assertions: [{ type: 'json-equals', path: 'action', value: 'follow' }] };
      const plan = comparisonPlan([scenario], { provider: 'hermes', model: 'hermes-model', judgeModel: 'judge-model', n: 1, seed: 'hermes-test' });
      const adapter = path.resolve('tools/rules/release-compare-hermes.mjs');
      const report = executeComparison(plan, fixtures, { subject: runnerAdapter(adapter), judge: runnerAdapter(adapter) });
      const full = { ...report, fixture_inputs: { A: 'aiwg@2026.10.3', B: 'tarball:/release/aiwg-2026.10.4.tgz' }, bundles: ['sdlc'], adapters: { subject: adapter, judge: adapter } };
      const file = path.join(root, 'report.json'); fs.writeFileSync(file, JSON.stringify(full));
      const candidate = { manifest: { package_version: '2026.10.4' }, package_tarball: 'aiwg-2026.10.4.tgz', package_tarball_sha256: '4'.repeat(64) };
      expect(verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] }).provider).toBe('hermes');
      const subjectReceipt = full.scenarios[0].evidence[0].runs.A.runtime_receipt;
      const adapterHash = subjectReceipt.adapter_source_sha256; subjectReceipt.adapter_source_sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/runtime observation/);
      subjectReceipt.adapter_source_sha256 = adapterHash;
      subjectReceipt.boundary_profile_sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/boundary|settings|observation/);
      subjectReceipt.boundary_profile_sha256 = receipt.profile_sha256;
      const requestedEffort = subjectReceipt.requested_effort; subjectReceipt.requested_effort = 'ultra'; fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/runtime observation/);
      subjectReceipt.requested_effort = requestedEffort;
      const argvHash = subjectReceipt.argv_sha256; subjectReceipt.argv_sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/runtime observation/);
      subjectReceipt.argv_sha256 = argvHash; subjectReceipt.requested_effort = 'medium';
      subjectReceipt.argv_sha256 = hash(JSON.stringify(buildHermesArgs({ model: 'hermes-model', provider: 'openrouter', effort: 'medium' })));
      fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/settings differ/);
      subjectReceipt.requested_effort = requestedEffort; subjectReceipt.argv_sha256 = argvHash;
      full.scenarios[0].evidence[0].judgment.runtime_receipt.qualification_authenticated = true; fs.writeFileSync(file, JSON.stringify(full));
      expect(() => verifyComparisonReport({ file, report: full, plan, candidate, baselineVersion: '2026.10.3', expectedBundles: ['sdlc'] })).toThrow(/unauthenticated Hermes/);
      expect(quarterlySourceAvailability(path.resolve('.')).filter(problem => problem.includes('hermes'))).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 30_000);
});
