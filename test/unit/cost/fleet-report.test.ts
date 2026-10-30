/** @issue #1187 */

import { mkdtempSync, promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatFleetSpendReport,
  generateFleetSpendReport,
  keyEnvironmentName,
  loadFleetConfig,
  loadFleetKey,
} from '../../../src/cost/fleet-report.js';
import { costReportHandler } from '../../../src/cli/handlers/cost-report.js';
import { buildHandlerMap } from '../../../src/cli/handlers/index.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aiwg-fleet-report-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function context(cwd: string, args: string[]): HandlerContext {
  return { cwd, frameworkRoot: cwd, args, rawArgs: ['cost-report', ...args] };
}

describe('OpenRouter fleet cost reporting', () => {
  it('uses a deterministic environment variable name for a key reference', () => {
    expect(keyEnvironmentName('openrouter-eride-quickbooksbot')).toBe(
      'AIWG_OPENROUTER_KEY_OPENROUTER_ERIDE_QUICKBOOKSBOT',
    );
  });

  it('rejects credentials embedded in fleet config', async () => {
    const directory = await temporaryDirectory();
    const config = path.join(directory, 'fleet.yaml');
    await fs.writeFile(config, [
      'fleet:',
      '  - bot: unsafe',
      '    machine: local',
      '    key_ref: unsafe-key',
      '    openrouter_api_key: sk-or-should-never-live-here',
      '    monthly_cap: 10',
      '',
    ].join('\n'));

    await expect(loadFleetConfig(config)).rejects.toThrow(/credential-like/);
  });

  it('loads credential files only when private and not symlinked', async () => {
    const homeDir = await temporaryDirectory();
    const keyDirectory = path.join(homeDir, '.config', 'aiwg', 'keys');
    const keyFile = path.join(keyDirectory, 'fleet-bot');
    await fs.mkdir(keyDirectory, { recursive: true });
    await fs.chmod(keyDirectory, 0o700);
    await fs.writeFile(keyFile, 'private-token\n', { mode: 0o600 });

    await expect(loadFleetKey('fleet-bot', { homeDir, env: {} })).resolves.toBe('private-token');

    await fs.chmod(keyFile, 0o644);
    await expect(loadFleetKey('fleet-bot', { homeDir, env: {} })).rejects.toThrow(/group or other/);

    await fs.chmod(keyFile, 0o600);
    await fs.symlink(keyFile, path.join(keyDirectory, 'linked-bot'));
    await expect(loadFleetKey('linked-bot', { homeDir, env: {} })).rejects.toThrow(/symlink/);
    await fs.link(keyFile, path.join(keyDirectory, 'hardlinked-bot'));
    await expect(loadFleetKey('hardlinked-bot', { homeDir, env: {} })).rejects.toThrow(/hard link/);
  });

  it('refuses a credential file owned by another user', async () => {
    const homeDir = await temporaryDirectory();
    const keyDirectory = path.join(homeDir, '.config', 'aiwg', 'keys');
    await fs.mkdir(keyDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(keyDirectory, 'owned-bot'), 'synthetic-foreign-token', { mode: 0o600 });
    const uid = process.getuid!();
    // Keep the directory's owner check valid and model a different file owner
    // without changing ownership on the host.
    vi.spyOn(process, 'getuid').mockReturnValueOnce(uid).mockReturnValue(uid + 1);
    await expect(loadFleetKey('owned-bot', { homeDir, env: {} })).rejects.toThrow(/not owned by the current user/);
  });

  it('keeps legacy environment precedence over the same private file without probing the store', async () => {
    const homeDir = await temporaryDirectory();
    const keyDirectory = path.join(homeDir, '.config', 'aiwg', 'keys');
    await fs.mkdir(keyDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(keyDirectory, 'legacy-bot'), 'synthetic-file-token', { mode: 0o600 });
    const readStore = vi.fn();
    await expect(loadFleetKey('legacy-bot', {
      homeDir, env: { AIWG_OPENROUTER_KEY_LEGACY_BOT: 'synthetic-env-token' }, readStore,
    })).resolves.toBe('synthetic-env-token');
    await expect(loadFleetKey('legacy-bot', {
      homeDir, env: { AIWG_OPENROUTER_KEY_LEGACY_BOT: ' ' }, readStore,
    })).resolves.toBe('synthetic-file-token');
    expect(readStore).not.toHaveBeenCalled();
  });

  it('loads a named store for one reference and refuses missing entries without cross-key fallback', async () => {
    const homeDir = await temporaryDirectory();
    const readStore = vi.fn(async (name: string) => name === 'bot-a-store' ? 'synthetic-a-key' : null);
    const env = { AIWG_OPENROUTER_KEY_BOT_A: 'synthetic-env-a', AIWG_OPENROUTER_KEY_BOT_B: 'synthetic-env-b' };
    await expect(loadFleetKey('bot-a', { homeDir, env, readStore, store: 'bot-a-store' })).resolves.toBe('synthetic-a-key');
    await expect(loadFleetKey('bot-b', { homeDir, env, readStore, store: 'bot-b-store' })).rejects.toThrow(/--key-store received no key/);
    await expect(loadFleetKey('bot-missing', { homeDir, env, readStore })).rejects.toThrow(/AIWG_OPENROUTER_KEY_BOT_MISSING/);
    expect(readStore.mock.calls).toEqual([['bot-a-store'], ['bot-b-store']]);
  });

  it('loads per-entry fleet store references without spawning children or writing the value', async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'fleet.yaml');
    await fs.writeFile(configPath, 'fleet:\n  - bot: a\n    machine: local\n    key_ref: bot-a\n    key_store: bot-a-store\n    monthly_cap: 10\n  - bot: b\n    machine: local\n    key_ref: bot-b\n    key_store: bot-b-store\n    monthly_cap: 10\n');
    const credential = 'synthetic-store-secret';
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const spawn = vi.spyOn(childProcess, 'spawn');
    const execFile = vi.spyOn(childProcess, 'execFile');
    const execFileSync = vi.spyOn(childProcess, 'execFileSync');
    const readStore = vi.fn(async (name: string) => {
      if (name === 'bot-a-store') return credential;
      throw new Error(`helper reflected ${credential}`);
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credential}`);
      throw new Error(`request reflected ${credential}`);
    });
    const report = await generateFleetSpendReport({ cwd: directory, configPath, homeDir: directory, env: {}, readStore, fetchImpl });
    for (const output of [JSON.stringify(report), formatFleetSpendReport(report), JSON.stringify(stdout.mock.calls), JSON.stringify(stderr.mock.calls)]) {
      expect(output).not.toContain(credential);
    }
    expect(report.bots[0].error).toContain('request could not complete');
    expect(report.bots[1].error).toContain('--key-store: native store entry could not be read');
    expect(readStore.mock.calls).toEqual([['bot-a-store'], ['bot-b-store']]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('aggregates per-bot MTD usage and correlates tagged generation activity', async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'fleet.yaml');
    await fs.mkdir(path.join(directory, '.aiwg'), { recursive: true });
    await fs.writeFile(configPath, [
      'provider: openrouter',
      'fleet:',
      '  - bot: quickbooksbot',
      '    machine: eride',
      '    key_ref: qb-key',
      '    monthly_cap: 10',
      '  - bot: hermesclaw',
      '    machine: oci',
      '    key_ref: hermes-key',
      '    monthly_cap: 20',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(directory, '.aiwg', 'activity.log'), [
      '## [2026-08-13 15:00] query | bot=quickbooksbot session=invoice-a generation_id=gen-qb-1',
      '## [2026-08-13 15:05] query | bot=quickbooksbot session=invoice-a generation_id=gen-qb-2',
      '## [2026-08-13 15:10] query | bot=hermesclaw session=review-b generation_id=gen-h-1',
      '',
    ].join('\n'));

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.endsWith('/key')) {
        const usage = authorization === 'Bearer qb-secret' ? 8.5 : 4;
        return new Response(JSON.stringify({ data: { usage_monthly: usage } }), { status: 200 });
      }
      const id = new URL(url).searchParams.get('id');
      const generation = id === 'gen-qb-1'
        ? { total_cost: 5, model: 'openai/gpt-5', service_tier: 'tier-2', created_at: '2026-08-13T15:00:00Z' }
        : id === 'gen-qb-2'
          ? { total_cost: 1, model: 'openai/gpt-5', service_tier: 'tier-2', created_at: '2026-07-31T23:59:00Z' }
          : { total_cost: 2, model: 'anthropic/claude', service_tier: 'tier-1', created_at: '2026-08-13T15:10:00Z' };
      return new Response(JSON.stringify({ data: generation }), { status: 200 });
    });

    const report = await generateFleetSpendReport({
      cwd: directory,
      configPath,
      env: {
        AIWG_OPENROUTER_KEY_QB_KEY: 'qb-secret',
        AIWG_OPENROUTER_KEY_HERMES_KEY: 'hermes-secret',
      },
      fetchImpl,
      apiBaseUrl: 'https://openrouter.test/api/v1',
      now: new Date('2026-08-13T16:00:00Z'),
    });

    expect(report.enforcement).toBe('openrouter');
    expect(report.bots[0]).toMatchObject({
      bot: 'quickbooksbot',
      spend_mtd: 8.5,
      cap: 10,
      percent_used: 85,
      anomalies: ['cap-near-limit', 'single-session-spike'],
      top_sessions: [{ session: 'invoice-a', cost: 5, generations: 1 }],
      model_tier_breakdown: { 'tier-2': 5 },
    });
    expect(report.bots[1].top_sessions[0]).toMatchObject({ session: 'review-b', cost: 2 });
    const formatted = formatFleetSpendReport(report);
    expect(formatted).toMatch(/bot\s+\| machine \| spend MTD \| cap/);
    expect(formatted).toContain('AIWG observes and correlates spend; OpenRouter enforces');
    expect(formatted).not.toContain('qb-secret');
  });

  it('keeps key-level spend when generation correlation is partially unavailable', async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(path.join(directory, '.aiwg'), { recursive: true });
    await fs.writeFile(
      path.join(directory, '.aiwg', 'activity.log'),
      '## [2026-08-13 15:00] query | session=solo generation_id=gen-unavailable\n',
    );
    const fetchImpl = vi.fn(async (input: string | URL | Request) => (
      String(input).endsWith('/key')
        ? new Response(JSON.stringify({ data: { usage_monthly: 2, limit: 5, limit_reset: 'monthly' } }), { status: 200 })
        : new Response('{}', { status: 503 })
    ));

    const report = await generateFleetSpendReport({
      cwd: directory,
      fleet: [{ bot: 'solo', machine: 'local', key_ref: 'solo-key', monthly_cap: 0 }],
      env: { AIWG_OPENROUTER_KEY_SOLO_KEY: 'solo-secret' },
      fetchImpl,
      apiBaseUrl: 'https://openrouter.test/api/v1',
      now: new Date('2026-08-13T16:00:00Z'),
    });

    expect(report.bots[0]).toMatchObject({
      spend_mtd: 2,
      cap: 5,
      percent_used: 40,
      anomalies: ['generation-correlation-partial'],
      top_sessions: [],
    });
    expect(report.bots[0].error).toBeUndefined();
  });

  it('never exposes a credential in API failure reports', async () => {
    const directory = await temporaryDirectory();
    const credential = 'secret-that-must-not-appear';
    const report = await generateFleetSpendReport({
      cwd: directory,
      fleet: [{ bot: 'private', machine: 'local', key_ref: 'private-key', monthly_cap: 10 }],
      env: { AIWG_OPENROUTER_KEY_PRIVATE_KEY: credential },
      fetchImpl: vi.fn(async () => new Response('{}', { status: 401 })),
      apiBaseUrl: 'https://openrouter.test/api/v1',
    });

    expect(report.bots[0].error).toContain('status 401');
    expect(JSON.stringify(report)).not.toContain(credential);
    expect(formatFleetSpendReport(report)).toContain('status 401');
    expect(formatFleetSpendReport(report)).not.toContain(credential);
  });

  it('redacts credentials reflected by successful generation metadata', async () => {
    const directory = await temporaryDirectory();
    const credential = 'synthetic-reflected-metadata-key';
    await fs.mkdir(path.join(directory, '.aiwg'), { recursive: true });
    await fs.writeFile(path.join(directory, '.aiwg', 'activity.log'), 'session=solo generation_id=gen-reflection\n');
    const report = await generateFleetSpendReport({
      cwd: directory, homeDir: directory,
      fleet: [{ bot: 'solo', machine: 'local', key_ref: 'solo-key', monthly_cap: 10 }],
      env: { AIWG_OPENROUTER_KEY_SOLO_KEY: credential },
      fetchImpl: vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify({
        data: String(input).endsWith('/key') ? { usage_monthly: 1 } : { total_cost: 1, service_tier: credential },
      }), { status: 200 })),
    });
    expect(report.bots[0].model_tier_breakdown).toEqual({ '[REDACTED]': 1 });
    expect(JSON.stringify(report)).not.toContain(credential);
    expect(formatFleetSpendReport(report)).not.toContain(credential);
  });

  it.each(['transport Error', 'transport string', 'response decoding'] as const)(
    'sanitizes untrusted %s diagnostics in structured and rendered reports', async failure => {
      const directory = await temporaryDirectory();
      const credential = 'synthetic-fleet-regression-key';
      const untrusted = `untrusted-diagnostic Authorization: Bearer ${credential}`;
      const fetchImpl = vi.fn(async () => {
        if (failure === 'transport Error') throw new Error(untrusted);
        if (failure === 'transport string') throw untrusted;
        const response = new Response('{}', { status: 200 });
        vi.spyOn(response, 'json').mockRejectedValue(new SyntaxError(untrusted));
        return response;
      });
      const report = await generateFleetSpendReport({
        cwd: directory,
        homeDir: directory,
        fleet: [{ bot: 'synthetic', machine: 'local', key_ref: 'synthetic-key', monthly_cap: 10 }],
        env: { AIWG_OPENROUTER_KEY_SYNTHETIC_KEY: credential },
        fetchImpl,
        apiBaseUrl: 'https://openrouter.test/api/v1',
      });
      const diagnostic = failure === 'response decoding'
        ? 'OpenRouter returned unreadable JSON. Check the API response format.'
        : 'OpenRouter request could not complete. Check connectivity, timeout, or cancellation.';
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(report.bots[0]).toMatchObject({
        spend_mtd: null, percent_used: null, cap: 10, top_sessions: [],
        model_tier_breakdown: {}, anomalies: ['observation-error'], error: diagnostic,
      });
      for (const output of [JSON.stringify(report), formatFleetSpendReport(report)]) {
        expect(output).toContain(diagnostic);
        expect(output).toContain('observation-error');
        expect(output).not.toContain(credential);
        expect(output).not.toContain(untrusted);
        expect(output).not.toContain('Authorization');
        expect(output).not.toContain('untrusted-diagnostic');
      }
    },
  );

  it('returns helpful guidance when fleet.yaml is absent', async () => {
    const directory = await temporaryDirectory();
    const result = await costReportHandler.execute(context(directory, [
      '--fleet',
      '--config',
      'missing-fleet.yaml',
    ]));

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('No fleet config found');
    expect(result.message).toContain('store only key_ref values');
  });

  it('documents single-key observation mode in CLI help', async () => {
    const directory = await temporaryDirectory();
    const result = await costReportHandler.execute(context(directory, ['--help']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('--key <key_ref>');
    expect(result.message).toContain('--key-store <name>');
    expect(result.message).toContain('OpenRouter enforces');
  });

  it('requires a single key reference for the CLI store source and validates missing source names', async () => {
    const directory = await temporaryDirectory();
    const fleetResult = await costReportHandler.execute(context(directory, ['--fleet', '--key-store', 'store-a']));
    expect(fleetResult).toMatchObject({ exitCode: 2, message: expect.stringContaining('use per-entry key_store') });
    const missingResult = await costReportHandler.execute(context(directory, ['--key', 'bot-a', '--key-store']));
    expect(missingResult).toMatchObject({ exitCode: 1, message: expect.stringContaining('--key-store requires a value') });
  });

  it.skipIf(process.platform === 'win32').each(['legacy-env', 'legacy-file', 'store'])(
    'confines %s keys to HTTP with native helpers and NODE_DEBUG enabled', async source => {
      const directory = await temporaryDirectory();
      const bin = path.join(directory, 'bin');
      const children = path.join(directory, 'children.jsonl');
      const requests = path.join(directory, 'requests.jsonl');
      const credential = 'synthetic-cost-debug-secret';
      await fs.mkdir(bin);
      await fs.mkdir(path.join(directory, '.config', 'aiwg', 'keys'), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, '.config', 'aiwg', 'keys', 'bot-a'), credential, { mode: 0o600 });
      await fs.mkdir(path.join(directory, '.aiwg'));
      await fs.writeFile(path.join(directory, '.aiwg', 'activity.log'), 'session=solo generation_id=gen-reflection\n');
      const helper = `#!${process.execPath}\nconst fs = require('node:fs');\n`
        + `fs.appendFileSync(${JSON.stringify(children)}, JSON.stringify({argv:process.argv,env:process.env})+'\\n');\n`
        + `if(process.argv.includes('lookup')||process.argv.includes('find-generic-password'))process.stdout.write(${JSON.stringify(credential)});\n`;
      for (const name of ['secret-tool', 'security']) await fs.writeFile(path.join(bin, name), helper, { mode: 0o755 });
      const runner = path.join(directory, 'runner.mjs');
      const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.resolve('dist/src', name)).href);
      const args = ['--key', 'bot-a', '--json', ...(source === 'store' ? ['--key-store', 'cost-entry'] : [])];
      await fs.writeFile(runner,
        `import fs from 'node:fs';\nimport {costReportHandler} from ${moduleUrl('cli/handlers/cost-report.js')};\n`
        + `import {defaultCommandRunner} from ${moduleUrl('auth/credential-store.js')};\nlet fail=false;\n`
        + `globalThis.fetch=async(url,init)=>{const key=init.headers.Authorization.slice(7);\n`
        + `fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({url,init})+'\\n');\n`
        + `if(fail)throw new Error('Transport reflected '+key);\n`
        + `return new Response(JSON.stringify({data:url.endsWith('/key')?{usage_monthly:1}:{total_cost:1,service_tier:key}}));};\n`
        + `const ctx={cwd:process.cwd(),frameworkRoot:process.cwd(),args:${JSON.stringify(args)},rawArgs:[]};\n`
        + `console.log(JSON.stringify(await costReportHandler.execute(ctx)));\nfail=true;\n`
        + `console.error(JSON.stringify(await costReportHandler.execute(ctx)));\n`
        + `await defaultCommandRunner('secret-tool',['clear','service','fixture','account','fixture']);\n`,
      );
      const result = childProcess.spawnSync(process.execPath, [runner], {
        cwd: directory, encoding: 'utf8', timeout: 20_000,
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: directory,
          NODE_DEBUG: 'child_process', UNRELATED_SECRET: credential,
          ...(source === 'legacy-env' ? { AIWG_OPENROUTER_KEY_BOT_A: credential } : {}),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain(credential);
      expect(result.stdout).toContain('[REDACTED]');
      expect(result.stderr).toContain('request could not complete');
      const observedChildren = await fs.readFile(children, 'utf8');
      expect(observedChildren).not.toContain(credential);
      const observedRequests = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(observedRequests).toHaveLength(3);
      for (const request of observedRequests) {
        expect(request.url).not.toContain(credential);
        expect(request.init.headers.Authorization).toBe(`Bearer ${credential}`);
        expect(request.init.body ?? '').not.toContain(credential);
      }
    },
  );

  it('is registered as the aiwg cost-report command', () => {
    expect(buildHandlerMap().get('cost-report')).toBe(costReportHandler);
  });
});
