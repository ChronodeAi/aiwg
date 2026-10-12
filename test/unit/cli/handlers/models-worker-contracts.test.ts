import { writeExecutable } from '../../../helpers/write-executable.js';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelsHandler } from '../../../../src/cli/handlers/models.js';
import { mcHandler } from '../../../../src/cli/handlers/mc.js';
import { capabilityProviderId, normalizeProviderId } from '../../../../src/cli/provider-resolution.js';
import { listProviderDefinitions } from '../../../../src/providers/provider-definitions.js';
import { loadCapabilityMatrix } from '../../../../src/providers/capability-matrix.js';
import { compileModelPolicy, loadProviderModelCapabilities } from '../../../../src/models/provider-policy.js';
import { fixtureJson, fixtureRoot, validators } from '../../../conformance/mission-v1/worker-contract-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(readFile(path.join(root, 'models.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describe('CLI vocabulary and legacy compatibility (T-OG-01/15)', () => {
  it('freezes direct flags, --json alias, and existing owner extensions without mc groups', () => {
    const vocabulary = fixtureJson('public-vocabulary.json').cli;
    expect(Object.keys(vocabulary.flags)).toEqual([
      '--role', '--task', '--group', '--brief', '--workdir', '--final-output', '--transport', '--format',
    ]);
    expect(vocabulary.aliases['--json']).toEqual({ format: 'json' });
    expect(vocabulary.shellRenderer).toBe('POSIX sh/bash');
    expect(vocabulary.otherSurfaces.map((surface: any) => surface.command[0]))
      .toEqual(['config', 'config', 'doctor', 'steward', 'mc', 'ralph-external']);
    expect(vocabulary.otherSurfaces.some((surface: any) => surface.command.join(' ') === 'mc groups')).toBe(false);
    expect(vocabulary.forbiddenNamespaces).toEqual([['mc', 'groups']]);
  });

  it.each(['codex', 'muse'])('preserves %s native resolve and JSON output in a fresh project with no managed state', async provider => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-contract-'));
    roots.push(root);
    const skillDir = path.join(root, 'agentic/code/frameworks/fixture/skills/check');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: check\ndescription: Synthetic check\ncommandHint:\n  model: haiku\n---\nCheck.\n');
    const models = fixtureJson('legacy-vectors.json').find((v: any) => v.id === 'legacy-native-models').value;
    const bytes = JSON.stringify(models);
    await writeFile(path.join(root, 'models.json'), bytes);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await modelsHandler.execute({ args: ['resolve', '--skill', 'check', '--provider', provider, '--json'], rawArgs: ['models', 'resolve'], cwd: root, frameworkRoot: root });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))[0]).toMatchObject({ policy: { role: 'efficiency', tier: 'economy' }, compiled: { outcome: 'unsupported' } });
    expect(await readFile(path.join(root, 'models.json'), 'utf8')).toBe(bytes);
    expect((await readdir(root)).sort()).toEqual(['agentic', 'models.json']);
  });

  it('validates the opted-in direct schema pair without creating MC, activation, executor or receipt files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-schema-'));
    roots.push(root);
    await mkdir(path.join(root, '.aiwg'));
    const vectors = fixtureJson('shared-vectors.json');
    const configBytes = JSON.stringify(vectors.find((v: any) => v.id === 'direct-config-no-managed-state').value);
    const modelBytes = JSON.stringify(vectors.find((v: any) => v.id === 'direct-model-no-effort').value);
    await writeFile(path.join(root, '.aiwg/aiwg.config'), configBytes);
    await writeFile(path.join(root, 'models.json'), modelBytes);
    const { draft07, draft2020, schemas } = validators();
    expect(draft07.getSchema(schemas.config.$id)!(JSON.parse(configBytes))).toBe(true);
    expect(draft2020.getSchema(schemas.models.$id)!(JSON.parse(modelBytes))).toBe(true);
    expect((await readdir(root)).sort()).toEqual(['.aiwg', 'models.json']);
    expect(await readdir(path.join(root, '.aiwg'))).toEqual(['aiwg.config']);
    expect(await readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8')).toBe(configBytes);
    expect(await readFile(path.join(root, 'models.json'), 'utf8')).toBe(modelBytes);
  });

  it('the existing mc help retains queue/run vocabulary and has no groups namespace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcHandler.execute({ args: ['--help'], rawArgs: ['mc', '--help'], cwd: process.cwd(), frameworkRoot: process.cwd() });
    const help = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(help).toContain('does NOT execute');
    expect(help).toContain('Launch queued missions');
    expect(help).not.toMatch(/mc groups/);
  });

  it('the frozen POSIX command preserves exact argv, cwd, stdin and output paths through a fake binary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-shell-contract-'));
    roots.push(root);
    const invocation = fixtureJson('mission-vectors.json').find((v: any) => v.id === 'resolved-shell').value;
    const bindPath = (value: string) => value.replaceAll('/fixture', root);
    await mkdir(path.join(root, 'bin'));
    await mkdir(bindPath(invocation.cwd));
    const binary = path.join(root, 'bin/worker');
    await writeExecutable(binary, await readFile(path.join(fixtureRoot, 'fake-worker.mjs'), 'utf8'));
    const brief = 'Synthetic brief: quotes \' " Unicode 雪\n--leading-dash\n';
    await writeFile(bindPath(invocation.briefPath), brief);
    await promisify(execFile)('/bin/sh', ['-c', bindPath(invocation.shellCommand)], {
      cwd: root, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, timeout: 5000, maxBuffer: 65536,
    });
    const observed = JSON.parse(await readFile(bindPath(invocation.stdoutPath), 'utf8'));
    expect(observed.argv).toEqual(invocation.argv.map(bindPath));
    expect(observed.cwd).toBe(bindPath(invocation.cwd));
    expect(observed.stdin).toBe(brief);
    expect(observed.finalPath).toBe(bindPath(invocation.finalPath));
    // The POSIX shell adds working-directory bookkeeping after structural cd.
    expect(observed.envNames).toEqual(['OLDPWD', 'PATH', 'PWD']);
    expect(await readFile(bindPath(invocation.stderrPath), 'utf8')).toBe('');
    const { draft2020, schemas } = validators();
    const validateClaims = draft2020.compile({ $ref: `${schemas.mission.$id}#/$defs/workerClaims` });
    expect(validateClaims(JSON.parse(await readFile(bindPath(invocation.finalPath), 'utf8')))).toBe(true);
    await expect(readFile(path.join(root, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).sort()).toEqual(['bin', 'brief 雪.md', 'errors.log', 'events.jsonl', 'final.json', 'tree with spaces']);
  });
});

describe('provider inventory contract (T-OG-19; no live qualification claim)', () => {
  it.each(Object.keys(loadProviderModelCapabilities().providers))('models consumes registry provider %s without managed services', async provider => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-provider-consumer-'));
    roots.push(root);
    const skillDir = path.join(root, 'agentic/code/frameworks/fixture/skills/check');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: check\ndescription: Synthetic check\ncommandHint:\n  model: haiku\n---\nCheck.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Exercise the consumer guard without unrelated native account discovery.
    const result = await modelsHandler.execute({ args: ['list', '--skill', 'check', '--provider', provider, '--json'], rawArgs: ['models', 'list'], cwd: root, frameworkRoot: root });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toHaveLength(1);
    expect(compileModelPolicy({ provider: provider as any, artifact: 'skill', policy: { role: 'efficiency', tier: 'economy' } }).provider).toBe(provider);
    expect(await readdir(root)).toEqual(['agentic']);
  });

  it('every matrix/registry provider and alias has a frozen scope, owner and consumer', () => {
    const rows = fixtureJson('provider-coverage.json').rows;
    const definitions = listProviderDefinitions();
    const matrix = loadCapabilityMatrix();
    expect(rows.filter((row: any) => row.kind === 'deployment-provider').map((row: any) => row.provider).sort())
      .toEqual(definitions.map(provider => provider.id).sort());
    for (const provider of definitions) {
      const row = rows.find((item: any) => item.provider === provider.id);
      expect(row.owner).toMatch(/^B-OG-\d+$/);
      expect(row.consumer).toContain('models resolve');
      expect(row.qualification).toBe('unqualified');
      for (const alias of provider.aliases) expect(normalizeProviderId(alias)).toBe(provider.id);
      if (provider.id !== 'generic') expect(matrix.providers[capabilityProviderId(provider.id)!]).toBeDefined();
    }
    for (const id of Object.keys(matrix.providers)) expect(rows.some((row: any) => row.provider === normalizeProviderId(id))).toBe(true);
    expect(rows.find((row: any) => row.provider === 'local-text')).toMatchObject({ kind: 'worker-adapter', scope: 'IN', owner: 'B-OG-09' });
    expect(rows.find((row: any) => row.provider === 'codex').nativeMcp).toBe('version-blocked');
    expect(rows.find((row: any) => row.provider === 'muse').nativeMcp).toBe('msp-not-mcp');
    expect(rows.find((row: any) => row.provider === 'hermes').nativeMcp).toBe('conversation-tools-only');
    expect(rows.find((row: any) => row.provider === 'claude').nativeMcp).toBe('coding-tools-only');
  });
});
