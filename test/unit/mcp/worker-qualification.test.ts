import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerRegistry, workerServerDigest, type McpWorkerQualificationInput } from '../../../src/mcp/registry.js';
import * as RuntimeRegistryModule from '../../../src/mcp/registry.mjs';
import { McpServerRegistry as RuntimeRegistry } from '../../../src/mcp/registry.mjs';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';
import { workerInputSchema } from '../../fixtures/ralph-worker-protocol.mjs';

const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const evidence = { scopeDigest: digest('installation'), fixtureDigest: digest('negative-fixtures'),
  verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
let root: string;
let registry: McpServerRegistry;
let authorizedServerDigest: string;
function qualification(): McpWorkerQualificationInput {
  const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.qualification = { status: 'qualified', fixtureDigest: evidence.fixtureDigest,
    verifiedAt: evidence.verifiedAt, evidenceRef: evidence.evidenceRef };
  const profile = adapter.invocationProfiles['fixture-shell'];
  profile.transport = 'mcp';
  for (const control of Object.values(profile.controls) as any[]) control.support = 'native';
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  profile.installationQualification = { ...evidence };
  profile.mcp = { serverRef: 'synthetic', tool: 'fixture-worker', inputSchemaDigest: digest(workerInputSchema),
    outputSchemaDigest: digest({ type: 'object' }), sessionIsolation: 'per-call', cancel: 'uncertain' };
  adapter.invocationProfiles = { 'fixture-mcp': profile };
  return { policy: {}, permissions: { sandbox: 'workspace-write', approval: 'never' }, authorizedServerDigest, requiredControls: ['model'], adapter, profile: 'fixture-mcp', cliVersion: '1.0.0', mcp: structuredClone(profile.mcp),
    installationQualification: { status: 'ENABLED', ...evidence, cliVersion: '1.0.0', platform: 'linux', serverDigest: authorizedServerDigest } };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-mcp-qualification-'));
  registry = new McpServerRegistry(root);
  await registry.add({ name: 'synthetic', type: 'stdio', command: process.execPath,
    args: [resolve('test/fixtures/ralph-worker-mcp.mjs')], cwd: root,
    env: { AIWG_FAKE_WORKER_CONFIG: join(root, 'fixture.json') } });
  authorizedServerDigest = workerServerDigest((await registry.get('synthetic'))!);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await expect(readFile(join(root, 'mcp-servers.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('S1 registered MCP worker qualification (T-OG-03/10/17/19)', () => {
  it('requires trusted installation evidence despite global qualification and injection', async () => {
    const input = qualification();
    await registry.recordInjection('synthetic', 'codex');
    await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/missing or changed/);
    delete input.adapter.invocationProfiles![input.profile].installationQualification;
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/trusted installation/);
  });

  it('rejects installation evidence for a different registered command', async () => {
    const input = qualification();
    input.installationQualification.serverDigest = digest('other-command');
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow('does not cover');
  });

  it('binds exact registration without copying ambient credentials, and survives reload', async () => {
    vi.stubEnv('UNRELATED_SECRET', 'synthetic-secret-must-not-propagate');
    const input = qualification();
    await registry.recordWorkerQualification('synthetic', input);
    registry.clearCache();
    const server = await registry.assertWorkerQualified('synthetic', input);
    expect(server.env).toEqual({ AIWG_FAKE_WORKER_CONFIG: join(root, 'fixture.json') });
    const stored = await readFile(registry.getPath(), 'utf8');
    expect(stored).not.toContain('synthetic-secret-must-not-propagate');
    expect(stored).not.toContain('UNRELATED_SECRET');
    expect(server.workerQualification?.serverDigest).toBe(workerServerDigest(server));
    await registry.update('synthetic', { description: 'Display metadata only' });
    await registry.assertWorkerQualified('synthetic', input);
  });

  it('rechecks persisted config instead of accepting a stale in-memory registration', async () => {
    const input = qualification();
    await registry.recordWorkerQualification('synthetic', input);
    const stored = JSON.parse(await readFile(registry.getPath(), 'utf8'));
    stored.servers.synthetic.args = ['--changed-outside-cache'];
    await writeFile(registry.getPath(), JSON.stringify(stored));
    await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/host authorization/);
  });

  it.each(['command', 'args', 'cwd', 'env', 'url', 'headerEnv', 'enabled', 'timeout'])(
    'invalidates a changed %s in both typed and runtime registry writers', async field => {
      const changes: Record<string, unknown> = { command: '/synthetic/replaced', args: ['--weaker'], cwd: '/',
        env: { AIWG_FAKE_WORKER_CONFIG: 'changed' }, url: 'https://unexpected.invalid',
        headerEnv: { Authorization: 'UNAUTHORIZED_TOKEN' }, enabled: false, timeout: 999 };
      for (const runtime of [false, true]) {
        const input = qualification();
        const baseline = (await registry.get('synthetic'))!;
        await registry.recordWorkerQualification('synthetic', input);
        const writer = runtime ? new RuntimeRegistry(root) : registry;
        await writer.update('synthetic', { [field]: changes[field] });
        registry.clearCache();
        expect((await registry.get('synthetic'))?.workerQualification).toBeUndefined();
        await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow();
        await registry.remove('synthetic');
        await registry.add({ ...baseline, workerQualification: baseline.workerQualification });
        expect((await registry.get('synthetic'))?.workerQualification).toBeUndefined();
      }
    },
  );

  it.each(['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef', 'cliVersion', 'platform'] as const)(
    'rejects installation %s drift', async field => {
      const input = qualification();
      await registry.recordWorkerQualification('synthetic', input);
      input.installationQualification[field] += '-changed';
      await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/trusted installation/);
    },
  );

  it('refuses to mint qualification for a different command or endpoint than the host authorized', async () => {
    const input = qualification();
    await registry.update('synthetic', { command: '/unapproved/worker' });
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/host authorization/);
    expect((await registry.get('synthetic'))?.workerQualification).toBeUndefined();
  });

  it.each([
    { type: 'stdio' as const, command: 'https://download.invalid/worker' },
    { type: 'http' as const, url: 'file:///synthetic/worker' },
    { type: 'http' as const, url: 'https://user:synthetic-secret@worker.invalid' },
    { type: 'http' as const, url: 'https://worker.invalid/#fragment' },
  ])('rejects nonlocal commands and invalid endpoint identities: %j', async update => {
    const input = qualification();
    await registry.update('synthetic', update);
    input.authorizedServerDigest = workerServerDigest((await registry.get('synthetic'))!);
    input.installationQualification.serverDigest = input.authorizedServerDigest;
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/absolute local command|endpoint/);
  });

  it.each(['children', 'fallback'] as const)('rejects unbounded %s even with a pinned server', async control => {
    const input = qualification();
    input.requiredControls = [control];
    input.adapter.invocationProfiles![input.profile].controls[control].support = 'external';
    input.adapter.capabilities[control === 'children' ? 'nestedAgentsControllable' : 'nativeFallbackControllable'] = false;
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/Required worker control/);
  });

  it('invalidates profile/control changes and rejects unrelated environment names', async () => {
    const input = qualification();
    await registry.recordWorkerQualification('synthetic', input);
    input.adapter.invocationProfiles![input.profile].controls.model.mapping = 'changed model control';
    await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/missing or changed/);
    await registry.update('synthetic', { env: { UNRELATED_SECRET: 'synthetic-value' } });
    input.authorizedServerDigest = workerServerDigest((await registry.get('synthetic'))!);
    input.installationQualification.serverDigest = input.authorizedServerDigest;
    await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/allowlist/);
  });

  it.each(['tool', 'inputSchemaDigest', 'outputSchemaDigest', 'sessionIsolation', 'cancel'] as const)(
    'rejects changed MCP %s before any worker call', async field => {
      const input = qualification();
      await registry.recordWorkerQualification('synthetic', input);
      (input.mcp as Record<string, string>)[field] = 'changed';
      await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/schema/);
    },
  );

  it('pins tools/list schemas from a bounded fake stdio server and rejects schema drift', async () => {
    const input = qualification();
    await registry.recordWorkerQualification('synthetic', input);
    for (const scenario of ['success', 'schema-change']) {
      await writeFile(join(root, 'fixture.json'), JSON.stringify({ scenario, recordPath: join(root, 'record.json') }));
      const server = (await registry.get('synthetic'))!;
      const response = await new Promise<any>((done, reject) => {
        const child = spawn(server.command!, server.args, { cwd: server.cwd, env: server.env, stdio: 'pipe' });
        let output = '';
        const watchdog = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 64 * 1024) child.kill('SIGKILL'); });
        child.once('error', error => { clearTimeout(watchdog); reject(error); });
        child.once('close', code => {
          clearTimeout(watchdog);
          if (code !== 0) reject(new Error('Bounded fake MCP probe failed'));
          else { try { done(JSON.parse(output)); } catch (error) { reject(error); } }
        });
        child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      });
      const advertised = response.result.tools[0];
      const observed = { ...input, mcp: { ...input.mcp, tool: advertised.name, inputSchemaDigest: digest(advertised.inputSchema) } };
      if (scenario === 'success') await registry.assertWorkerQualified('synthetic', observed);
      else await expect(registry.assertWorkerQualified('synthetic', observed)).rejects.toThrow(/schema/);
    }
  });
});

describe('round 1 MCP binding regressions', () => {
  it.each([undefined, null, 'sandbox', {}, [null], [''], ['unknown-control']])
    ('requires a validated requiredControls array: %j', async requiredControls => {
      const input = qualification();
      (input as any).requiredControls = requiredControls;
      await expect(registry.recordWorkerQualification('synthetic', input)).rejects.toThrow(/required controls/i);
    });

  it('invalidates qualification when the required control set changes', async () => {
    const input = qualification();
    input.adapter.invocationProfiles![input.profile].controls.sandbox = { support: 'native', mapping: '--sandbox', evidence: 'fixture:only' };
    await registry.recordWorkerQualification('synthetic', input);
    input.requiredControls = ['model', 'stepCap'];
    await expect(registry.assertWorkerQualified('synthetic', input)).rejects.toThrow(/missing or changed/);
  });

  it('uses the same canonical encoding and sha256 prefix in TS and runtime bindings', async () => {
    const server = (await registry.get('synthetic'))!;
    server.env = { z: 'last', Z: 'first', a: 'middle', absent: undefined } as any;
    const { workerQualification, description, injectedProviders, addedAt, updatedAt, ...execution } = server;
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
    const expected = digest(canonical(execution));
    expect(workerServerDigest(server)).toBe(expected);
    expect((RuntimeRegistryModule as any).workerServerDigest).toBeTypeOf('function');
    expect((RuntimeRegistryModule as any).workerServerDigest(server)).toBe(expected);
  });
});
