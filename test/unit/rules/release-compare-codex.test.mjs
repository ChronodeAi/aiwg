import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyComparisonReport } from '../../../tools/release/release-evidence.mjs';
import { codexAdapter, runCodex } from '../../../tools/rules/release-compare-codex.mjs';
import { validateSubject, comparisonPlan, executeComparison, runnerAdapter, DIMENSIONS } from '../../../tools/rules/release-compare.mjs';

const roots = [];
function setup() {
  const isolation = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-codex-')); roots.push(isolation);
  const root = path.join(isolation, 'project'); fs.mkdirSync(root);
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-account-')); roots.push(account); fs.writeFileSync(path.join(account, 'auth.json'), '{}', { mode: 0o600 });
  const binary = path.join(isolation, 'codex'); fs.writeFileSync(binary, 'fake binary');
  const home = path.join(isolation, 'home'); fs.mkdirSync(home); fs.mkdirSync(path.join(isolation, 'tmp'));
  return { root, env: { PATH: '/bin', HOME: home, CODEX_HOME: path.join(isolation, 'codex-home'), TMPDIR: path.join(isolation, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    AIWG_ARTIFACTS_PATH: path.join(isolation, 'artifacts'), AIWG_PROJECT_ARTIFACTS_PATH: path.join(isolation, 'artifacts'),
    OPENAI_API_KEY: 'allowed-key', AIWG_RELEASE_CODEX_AUTH_SOURCE: 'account-home', AIWG_RELEASE_CODEX_ACCOUNT_HOME: account, OTHER_SECRET: 'must-not-pass', AIWG_RELEASE_CODEX_BINARY: binary, AIWG_RELEASE_CODEX_EFFORT: 'low', AIWG_RELEASE_CODEX_JUDGE_EFFORT: 'medium' },
    request: { protocol: 'aiwg-release-subject/v1', provider: 'codex', model: 'gpt-5.6', prompt: 'Return JSON', settings: { read_only: true }, fixture_identity: { package_version: '2026.10.3' } } };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const stdout = [
  { type: 'thread.started', thread_id: 'thread' }, { type: 'turn.started' },
  { type: 'item.started', item: { id: '1', type: 'command_execution' } },
  { type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'aiwg show rule delivery-policy', aggregated_output: 'body', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: '2', type: 'agent_message', text: '{"action":"follow"}' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } },
].map(event => JSON.stringify(event)).join('\n');

describe('Codex release comparison subject adapter', () => {
  it('pins invocation settings and records observed tool results without claiming backend identity', async () => {
    const { root, env, request } = setup(); let observed;
    const result = await codexAdapter(request, { env, cwd: root, spawn: (command, args, tier, options) => {
      observed = { command, args, tier, options }; fs.writeFileSync(args[args.indexOf('-o') + 1], '{\"action\":\"follow\"}'); return { status: 0, stdout };
    } });
    expect(observed.command).toBe(env.AIWG_RELEASE_CODEX_BINARY);
    expect(observed.args).toContain('permissions.eval.extends=":read-only"'); expect(observed.options.env.OPENAI_API_KEY).toBeUndefined(); expect(observed.options.env.CODEX_HOME).toBe(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME); expect(observed.args).toContain('model_reasoning_effort="low"');
    expect(observed.args).toContain('--no-daemon'); expect(observed.args).toContain('shell_environment_policy.inherit="none"');
    expect(observed.args.slice(0, 6)).toEqual(['--no-daemon', '--disable', 'apps', '--disable', 'plugins', 'exec']);
    expect(observed.args.find(arg => arg.startsWith('shell_environment_policy.set='))).not.toContain('allowed-key');
    expect(observed.args.find(arg => arg.startsWith('shell_environment_policy.set='))).toContain('PATH');
    const filesystem = observed.args.find(arg => arg.startsWith('permissions.eval.filesystem='));
    for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'AIWG_ARTIFACTS_PATH']) expect(filesystem).toContain(`${JSON.stringify(env[key])}="write"`);
    expect(filesystem).not.toContain(`${JSON.stringify(env.HOME)}="write"`); expect(filesystem).not.toContain(`${JSON.stringify(root)}="write"`);
    expect(observed.args).toContain('--ignore-user-config'); expect(observed.options.input).toBe(request.prompt);
    expect(observed.options.timeout).toBe(180000); expect(observed.options.env.OTHER_SECRET).toBeUndefined();
    expect(result.trace.tools[0].success).toBe(true);
    for (const key of ['adapter_source_sha256', 'runtime_source_sha256', 'trace_parser_sha256']) expect(result.runtime_receipt[key]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runtime_receipt).toMatchObject({ authenticated: false, requested_model: request.model, requested_effort: 'low', reported_remote_model: null, reported_remote_backend: null });
    expect(validateSubject(result, request.model, 'codex').runtime_receipt).toEqual(result.runtime_receipt);
    expect(() => validateSubject({ ...result, runtime_receipt: { ...result.runtime_receipt, authenticated: true } }, request.model, 'codex')).toThrow(/runtime observation/);
  });
  it('runs a fake CLI through the real process boundary', async () => {
    const { root, env, request } = setup();
    fs.writeFileSync(env.AIWG_RELEASE_CODEX_BINARY, `#!${process.execPath}\nrequire("fs").writeFileSync(process.argv[process.argv.indexOf("-o")+1], '{"action":"follow"}'); process.stdin.resume(); process.stdout.write(${JSON.stringify(stdout)});\n`, { mode: 0o755 });
    fs.chmodSync(env.AIWG_RELEASE_CODEX_BINARY, 0o755);
    const result = await codexAdapter(request, { env, cwd: root });
    expect(result.trace.text).toBe('{"action":"follow"}');
    expect(result.runtime_receipt.authenticated).toBe(false);
  });
  it('terminates an unresponsive process group at the deadline', async () => {
    const { root, env } = setup();
    const pidfile = path.join(root, 'child.pid');
    fs.writeFileSync(env.AIWG_RELEASE_CODEX_BINARY, `#!${process.execPath}\nconst c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));setInterval(()=>{},1000);\n`);
    fs.chmodSync(env.AIWG_RELEASE_CODEX_BINARY, 0o755);
    await expect(runCodex(env.AIWG_RELEASE_CODEX_BINARY, [], 'long', { cwd: root, env, input: '', timeout: 500, maxBuffer: 1024 })).rejects.toThrow(/timed out|confirm.*exit/);
    expect(fs.existsSync(pidfile)).toBe(true);
    const pid = Number(fs.readFileSync(pidfile, 'utf8'));
    // Linux may retain a reparented zombie briefly; it is no longer executing.
    const statFile = `/proc/${pid}/stat`;
    if (fs.existsSync(statFile)) expect(fs.readFileSync(statFile, 'utf8').split(') ')[1][0]).toBe('Z');
  });
  it('retains the observation when the actual harness selects the adapter', () => {
    const { root, env } = setup();
    const judgeAnswer = JSON.stringify({ winner: 'tie', reason: 'same', scores: Object.fromEntries(['left', 'right'].map(side => [side, Object.fromEntries(Object.keys(DIMENSIONS).map(key => [key, 4]))])) });
    const judgeEvents = [{ type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'judge', type: 'agent_message', text: judgeAnswer } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n');
    fs.writeFileSync(env.AIWG_RELEASE_CODEX_BINARY, `#!${process.execPath}\nconst judge = process.argv[process.argv.indexOf('--model')+1] === 'judge'; require("fs").writeFileSync(process.argv[process.argv.indexOf("-o")+1], judge ? ${JSON.stringify(judgeAnswer)} : '{"action":"follow"}'); process.stdin.resume(); process.stdout.write(judge ? ${JSON.stringify(judgeEvents)} : ${JSON.stringify(stdout)});\n`);
    fs.chmodSync(env.AIWG_RELEASE_CODEX_BINARY, 0o755);
    const fixtures = Object.fromEntries(['A', 'B'].map(side => {
      const fixtureRoot = path.join(root, side), project = path.join(fixtureRoot, 'project'), packageRoot = path.join(fixtureRoot, 'package');
      fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"version":"2026.10.3"}');
      fs.writeFileSync(path.join(packageRoot, 'bin/aiwg.mjs'), '');
      const identity = side === 'A' ? { spec: 'aiwg@2026.10.2', package_version: '2026.10.2', tarball_sha256: null, deployed_context_sha256: '1'.repeat(64), package_tree_sha256: '2'.repeat(64), installation_lock_sha256: '3'.repeat(64) } : { spec: 'tarball:/release/aiwg-2026.10.3.tgz', package_version: '2026.10.3', tarball_sha256: '4'.repeat(64), deployed_context_sha256: '5'.repeat(64), package_tree_sha256: '6'.repeat(64), installation_lock_sha256: '7'.repeat(64) };
      return [side, { root: fixtureRoot, project, packageRoot, identity: identity.spec, content_identity: identity }];
    }));
    const scenario = { id: 'case', domain: 'delivery', providers: ['codex'], prompt: 'Return JSON', files: {}, assertions: [{ type: 'json-equals', path: 'action', value: 'follow' }] };
    const plan = comparisonPlan([scenario], { provider: 'codex', model: 'gpt-5.6', judgeModel: 'judge', n: 1, seed: 'test' });
    const previousBinary = process.env.AIWG_RELEASE_CODEX_BINARY, previousEffort = process.env.AIWG_RELEASE_CODEX_EFFORT, previousAuth = process.env.AIWG_RELEASE_CODEX_AUTH_SOURCE, previousKey = process.env.OPENAI_API_KEY, previousAccount = process.env.AIWG_RELEASE_CODEX_ACCOUNT_HOME, previousJudgeEffort = process.env.AIWG_RELEASE_CODEX_JUDGE_EFFORT;
    process.env.AIWG_RELEASE_CODEX_BINARY = env.AIWG_RELEASE_CODEX_BINARY; process.env.AIWG_RELEASE_CODEX_EFFORT = 'low'; process.env.AIWG_RELEASE_CODEX_JUDGE_EFFORT = 'medium'; process.env.AIWG_RELEASE_CODEX_AUTH_SOURCE = 'account-home'; process.env.AIWG_RELEASE_CODEX_ACCOUNT_HOME = env.AIWG_RELEASE_CODEX_ACCOUNT_HOME; process.env.OPENAI_API_KEY = 'dummy-key';
    let report;
    try {
      report = executeComparison(plan, fixtures, { subject: runnerAdapter(path.resolve('tools/rules/release-compare-codex.mjs')),
        judge: runnerAdapter(path.resolve('tools/rules/release-compare-codex.mjs')) });
    } finally {
      if (previousAuth === undefined) delete process.env.AIWG_RELEASE_CODEX_AUTH_SOURCE; else process.env.AIWG_RELEASE_CODEX_AUTH_SOURCE = previousAuth;
      if (previousJudgeEffort === undefined) delete process.env.AIWG_RELEASE_CODEX_JUDGE_EFFORT; else process.env.AIWG_RELEASE_CODEX_JUDGE_EFFORT = previousJudgeEffort;
      if (previousAccount === undefined) delete process.env.AIWG_RELEASE_CODEX_ACCOUNT_HOME; else process.env.AIWG_RELEASE_CODEX_ACCOUNT_HOME = previousAccount;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      if (previousBinary === undefined) delete process.env.AIWG_RELEASE_CODEX_BINARY; else process.env.AIWG_RELEASE_CODEX_BINARY = previousBinary;
      if (previousEffort === undefined) delete process.env.AIWG_RELEASE_CODEX_EFFORT; else process.env.AIWG_RELEASE_CODEX_EFFORT = previousEffort;
    }
    expect(report.pass).toBe(true);
    const fullReport = { ...report, fixture_inputs: { A: 'aiwg@2026.10.2', B: 'tarball:/release/aiwg-2026.10.3.tgz' }, bundles: ['sdlc'],
      adapters: { subject: path.resolve('tools/rules/release-compare-codex.mjs'), judge: path.resolve('tools/rules/release-compare-codex.mjs') } };
    const file = path.join(root, 'report.json'); fs.writeFileSync(file, JSON.stringify(fullReport));
    const candidate = { manifest: { package_version: '2026.10.3' }, package_tarball: 'aiwg-2026.10.3.tgz', package_tarball_sha256: '4'.repeat(64) };
    const binding = verifyComparisonReport({ file, report: fullReport, plan, candidate, baselineVersion: '2026.10.2', expectedBundles: ['sdlc'] });
    expect(binding.provider).toBe('codex');
    fullReport.adapters.judge = path.resolve('tools/rules/release-compare-claude.mjs'); fs.writeFileSync(file, JSON.stringify(fullReport));
    expect(() => verifyComparisonReport({ file, report: fullReport, plan, candidate, baselineVersion: '2026.10.2', expectedBundles: ['sdlc'] })).toThrow(/same reviewed adapter/);
    fullReport.adapters.judge = path.resolve('tools/rules/release-compare-codex.mjs');
    const receipt = fullReport.scenarios[0].evidence[0].judgment.runtime_receipt;
    const originalHash = receipt.runtime_source_sha256; receipt.runtime_source_sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(fullReport));
    expect(() => verifyComparisonReport({ file, report: fullReport, plan, candidate, baselineVersion: '2026.10.2', expectedBundles: ['sdlc'] })).toThrow(/runtime observation/); receipt.runtime_source_sha256 = originalHash;
    fullReport.scenarios[0].evidence[0].runs.A.runtime_receipt.authenticated = true;
    fs.writeFileSync(file, JSON.stringify(fullReport));
    expect(() => verifyComparisonReport({ file, report: fullReport, plan, candidate, baselineVersion: '2026.10.2', expectedBundles: ['sdlc'] })).toThrow(/unauthenticated/);
    report.scenarios[0].evidence[0].runs.A.runtime_receipt.authenticated = false;
    for (const side of ['A', 'B']) expect(report.scenarios[0].evidence[0].runs[side].runtime_receipt).toMatchObject({ authenticated: false, requested_model: 'gpt-5.6', requested_effort: 'low' });
  });
  it('judges blinded input and rejects any observed tool attempt', async () => {
    const { root, env } = setup();
    const request = { protocol: 'aiwg-release-judge/v1', model: 'judge-model', prompt: 'decide', rubric: {}, scale: '0-4', left: { text: 'one' }, right: { text: 'two' }, instructions: 'Exact judge schema with INTEGER_0_TO_4.' };
    const answer = JSON.stringify({ winner: 'tie', reason: 'same', scores: { left: {}, right: {} } });
    const events = [{ type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: '1', type: 'agent_message', text: answer } }, { type: 'turn.completed' }];
    const invoke = extra => codexAdapter(request, { env, cwd: root, spawn: (_cmd, args, _tier, options) => {
      expect(options.input).not.toContain('judge-model');
      expect(options.input).not.toContain('fixture_identity');
      expect(JSON.parse(options.input).instructions).toContain(request.instructions);
      fs.writeFileSync(args[args.indexOf('-o') + 1], answer);
      return { status: 0, stdout: [...events.slice(0, 2), ...extra, ...events.slice(2)].map(JSON.stringify).join('\n') };
    } });
    const judged = await invoke([]);
    expect(judged.model).toBe('judge-model'); expect(judged.runtime_receipt.requested_effort).toBe('medium');
    await expect(invoke([{ type: 'item.started', item: { id: 'tool', type: 'command_execution' } }])).rejects.toThrow(/tool use/);
    await expect(invoke([{ type: 'item.started', item: { id: 'unknown', type: 'new_tool' } }])).rejects.toThrow(/unknown item/);
  });
  it('rejects account context and symlinked fixture paths before spawning', async () => {
    const { root, env, request } = setup();
    const noSpawn = () => { throw new Error('unexpected spawn'); };
    fs.writeFileSync(path.join(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME, 'AGENTS.md'), 'untrusted');
    await expect(codexAdapter(request, { env, cwd: root, spawn: noSpawn })).rejects.toThrow(/only a regular auth.json/);
    fs.unlinkSync(path.join(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME, 'AGENTS.md'));
    const escape = path.join(root, 'account-link'); fs.symlinkSync(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME, escape);
    await expect(codexAdapter(request, { env, cwd: escape, spawn: noSpawn })).rejects.toThrow(/isolation root/);
    await expect(codexAdapter(request, { env: { ...env, AIWG_ROOT: escape }, cwd: root, spawn: noSpawn })).rejects.toThrow(/isolation root/);
    await expect(codexAdapter(request, { env: { ...env, PATH: escape }, cwd: root, spawn: noSpawn })).rejects.toThrow(/PATH overlaps/);
  });
  it('accepts only the declared private canonical auth symlink and denies both roots', async () => {
    const { root, env, request } = setup();
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-auth-')); roots.push(canonical);
    const target = path.join(canonical, 'auth.json'); fs.writeFileSync(target, 'fake', { mode: 0o600 });
    const accountAuth = path.join(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME, 'auth.json'); fs.unlinkSync(accountAuth); fs.symlinkSync(target, accountAuth);
    const configured = { ...env, AIWG_RELEASE_CODEX_AUTH_TARGET: target };
    const spawn = (_cmd, args) => {
      const permission = args.find(arg => arg.startsWith('permissions.eval.filesystem='));
      expect(permission).toContain(JSON.stringify(canonical)); expect(permission).toContain(JSON.stringify(env.AIWG_RELEASE_CODEX_ACCOUNT_HOME));
      expect(args).toContain('cli_auth_credentials_store="file"');
      fs.writeFileSync(args[args.indexOf('-o') + 1], '{"action":"follow"}'); return { status: 0, stdout };
    };
    await codexAdapter(request, { env: configured, cwd: root, spawn });
    const deniedBinary = path.join(canonical, 'codex'); fs.writeFileSync(deniedBinary, 'binary');
    await expect(codexAdapter(request, { env: { ...configured, AIWG_RELEASE_CODEX_BINARY: deniedBinary }, cwd: root, spawn: () => { throw new Error('unexpected spawn'); } })).rejects.toThrow(/executable.*outside denied/);
    await expect(codexAdapter(request, { env, cwd: root, spawn })).rejects.toThrow(/explicit matching/);
    fs.chmodSync(target, 0o644);
    await expect(codexAdapter(request, { env: configured, cwd: root, spawn })).rejects.toThrow(/private owned/);
  });
  it('checks intrinsic skills against an explicit sealed reference before and after execution', async () => {
    const { root, env, request } = setup();
    const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'system-reference-')); roots.push(reference);
    fs.mkdirSync(path.join(reference, 'builtin')); fs.writeFileSync(path.join(reference, 'builtin', 'SKILL.md'), 'builtin');
    const configured = { ...env, AIWG_RELEASE_CODEX_SKILLS_REFERENCE: reference };
    const account = env.AIWG_RELEASE_CODEX_ACCOUNT_HOME;
    const spawn = (_cmd, args) => {
      const skills = path.join(account, 'skills', '.system'); fs.mkdirSync(skills, { recursive: true });
      fs.cpSync(reference, skills, { recursive: true }); fs.writeFileSync(path.join(account, 'installation_id'), 'fake');
      fs.writeFileSync(args[args.indexOf('-o') + 1], '{"action":"follow"}'); return { status: 0, stdout };
    };
    await codexAdapter(request, { env: configured, cwd: root, spawn });
    fs.writeFileSync(path.join(account, 'skills', '.system', 'builtin', 'SKILL.md'), 'tampered');
    await expect(codexAdapter(request, { env: configured, cwd: root, spawn })).rejects.toThrow(/sealed reference/);
    fs.writeFileSync(path.join(account, 'skills', '.system', 'builtin', 'SKILL.md'), 'builtin');
    fs.mkdirSync(path.join(account, 'skills', 'operator'));
    await expect(codexAdapter(request, { env: configured, cwd: root, spawn })).rejects.toThrow(/sealed reference/);
    fs.rmSync(path.join(account, 'skills', 'operator'), { recursive: true });
    fs.writeFileSync(path.join(account, 'config.toml'), 'untrusted');
    await expect(codexAdapter(request, { env: configured, cwd: root, spawn })).rejects.toThrow(/qualified runtime state/);
  });
  it('admits only the qualified Codex host-state names and preserves bounded postcheck diagnostics', async () => {
    const { root, env, request } = setup();
    const account = env.AIWG_RELEASE_CODEX_ACCOUNT_HOME;
    for (const name of ['.sandbox_migration', 'installation_id', 'models_cache.json', 'goals_1.sqlite', 'logs_2.sqlite',
      'memories_1.sqlite', 'memories_1.sqlite-shm', 'memories_1.sqlite-wal', 'queue_1.sqlite', 'queue_1.sqlite-wal',
      'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal']) fs.writeFileSync(path.join(account, name), 'host-state');
    fs.mkdirSync(path.join(account, 'shell_snapshots')); fs.mkdirSync(path.join(account, 'tmp'));
    const success = (_cmd, args) => { fs.writeFileSync(args[args.indexOf('-o') + 1], '{"action":"follow"}'); return { status: 0, stdout }; };
    await codexAdapter(request, { env, cwd: root, spawn: success });
    fs.writeFileSync(path.join(account, 'state_6.sqlite'), 'unknown');
    await expect(codexAdapter(request, { env, cwd: root, spawn: success })).rejects.toThrow(/qualified runtime state/);
    fs.unlinkSync(path.join(account, 'state_6.sqlite'));
    let failure;
    try {
      await codexAdapter(request, { env, cwd: root, spawn: (_cmd, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], '{"action":"follow"}');
        fs.writeFileSync(path.join(account, 'config.toml'), 'unexpected');
        return { status: 0, stdout, stderr: 'host diagnostic' };
      } });
    } catch (error) { failure = error; }
    expect(failure?.message).toMatch(/account lifecycle validation failed/);
    expect(failure?.diagnostic).toMatchObject({ schema: 'aiwg-codex-evaluation-failure/v1', phase: 'account-postcheck', status: 0,
      stdout: { truncated: false }, stderr: { text: 'host diagnostic', truncated: false } });
    expect(failure.diagnostic.trace.completed).toBe(true);
  });
  it('fails on invalid settings, partial output, model errors, malformed output and binary mutation', async () => {
    const { root, env, request } = setup();
    await expect(codexAdapter(request, { env: { ...env, AIWG_RELEASE_CODEX_EFFORT: 'auto' }, cwd: root })).rejects.toThrow(/effort/);
    await expect(codexAdapter(request, { env: { ...env, AIWG_RELEASE_CODEX_AUTH_SOURCE: 'ambient' }, cwd: root })).rejects.toThrow(/authentication/);
    await expect(codexAdapter(request, { env, cwd: root, spawn: () => ({ status: 0, stdout }) })).rejects.toThrow(/final file/);
    for (const output of ['', '{"type":"turn.started"}', 'not json', `${stdout}\n{"type":"turn.failed"}`]) {
      await expect(codexAdapter(request, { env, cwd: root, spawn: () => ({ status: 0, stdout: output }) })).rejects.toThrow();
    }
    await expect(codexAdapter(request, { env, cwd: root, spawn: () => ({ status: 1, stdout: '' }) })).rejects.toThrow(/failed/);
    await expect(codexAdapter(request, { env, cwd: root, spawn: () => { fs.writeFileSync(env.AIWG_RELEASE_CODEX_BINARY, 'changed'); return { status: 0, stdout }; } })).rejects.toThrow(/changed/);
  });
});
