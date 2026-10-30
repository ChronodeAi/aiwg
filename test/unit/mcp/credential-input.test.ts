import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { McpServerRegistry, resolveMcpCredentialMaps, buildServerToml } from '../../../src/mcp/registry.js';
import { credentialReferenceInput, hasSecretLookingLiterals, renderCredentialMaps } from '../../../src/mcp/credentials.mjs';
import { ompServerConfig } from '../../../src/mcp/omp-config.mjs';
import { renderGrokMcpServer } from '../../../src/mcp/grok-build-config.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-mcp-sensitive-'));
  roots.push(root);
  return root;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Source CLI runs too, so inject the resolver/store at the existing owner boundary.
async function cliOwner() {
  return import(pathToFileURL(path.resolve('src/mcp/cli.mjs')).href);
}

describe('MCP per-value credential input', () => {
  it('keeps bare environment names and accepts durable file/store locators', () => {
    expect(credentialReferenceInput('FIXTURE_TOKEN')).toEqual({ env: 'FIXTURE_TOKEN' });
    expect(credentialReferenceInput('file:/synthetic/private-key')).toEqual({ file: '/synthetic/private-key' });
    expect(credentialReferenceInput('store:fixture-entry')).toEqual({ store: 'fixture-entry' });
    for (const invalid of ['', 'file:', 'file:relative', 'store:', 'store:../entry', 'stdin:entry', 'fixture-secret=value']) {
      let message = '';
      try { credentialReferenceInput(invalid); } catch (error) { message = (error as Error).message; }
      expect(message).toContain('--env-from/--header-env');
      expect(message).not.toContain('fixture-secret=value');
    }
  });

  it('resolves each value in memory without mutating its serializable definition or prompting', async () => {
    const root = fixture();
    const file = path.join(root, 'private');
    writeFileSync(file, 'fixture-file-value\n', { mode: 0o600 });
    const server = { env: { MODE: 'fixture' }, envFrom: { API_KEY: `file:${file}`, OTHER_TOKEN: 'FIXTURE_TOKEN' }, headerEnv: { Authorization: 'store:fixture-auth' } };
    const before = JSON.stringify(server);
    const prompt = vi.fn();
    const readStore = vi.fn(async () => 'fixture-store-value');
    expect(await resolveMcpCredentialMaps(server, { isTTY: true, prompt, readStore, environment: { FIXTURE_TOKEN: 'fixture-env-value' } })).toEqual({
      env: { MODE: 'fixture', API_KEY: 'fixture-file-value', OTHER_TOKEN: 'fixture-env-value' }, headers: { Authorization: 'fixture-store-value' },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(readStore).toHaveBeenCalledWith('fixture-auth');
    expect(JSON.stringify(server)).toBe(before);
  });

  it('refuses exposed, linked, empty and invalid files without returning their contents', async () => {
    const root = fixture();
    const file = path.join(root, 'private');
    writeFileSync(file, 'fixture-file-secret\n', { mode: 0o600 });
    const link = path.join(root, 'linked');
    symlinkSync(file, link);
    for (const reference of [`file:${link}`, `file:${path.join(root, 'missing')}`]) {
      await expect(resolveMcpCredentialMaps({ envFrom: { TOKEN: reference } })).rejects.toThrow('--env-from KEY=file:ABSOLUTE_PATH');
    }
    chmodSync(file, 0o644);
    await expect(resolveMcpCredentialMaps({ envFrom: { TOKEN: `file:${file}` } })).rejects.toThrow('group or other');
    chmodSync(file, 0o600);
    for (const content of ['', 'fixture-file-secret\nsecond-line']) {
      writeFileSync(file, content);
      const message = await resolveMcpCredentialMaps({ envFrom: { TOKEN: `file:${file}` } }).then(() => 'unexpected success', (error: Error) => error.message);
      expect(message).toMatch(/received no key|one non-empty line/);
      expect(message).not.toContain('fixture-file-secret');
    }
  });

  it('names source options when required values are missing and sanitizes store errors', async () => {
    await expect(resolveMcpCredentialMaps({ headerEnv: { Authorization: 'store:fixture-missing' } }, { readStore: async () => '' })).rejects.toThrow('--header-env KEY=store:NAME received no key');
    await expect(resolveMcpCredentialMaps({ envFrom: { TOKEN: 'FIXTURE_TOKEN' } }, { environment: {} })).rejects.toThrow('--env-from KEY=ENV_NAME received no key');
    await expect(resolveMcpCredentialMaps({ headerEnv: { Authorization: 'store:fixture-missing' } }, { readStore: async () => { throw new Error('fixture-store-secret'); } })).rejects.toThrow('--header-env KEY=store:NAME: native store entry could not be read.');
  });

  it('uses explicit stdin/interactive input and saves only named-store references', async () => {
    const { persistCredentialInputs } = await cliOwner();
    const saveSecret = vi.fn(async () => {});
    const resolveSensitiveInput = vi.fn(async () => 'fixture-transient-secret');
    const namedSensitiveStore = vi.fn(() => ({ saveSecret }));
    const server = { envFrom: { TOKEN: 'stdin:fixture-stdin' }, headerEnv: { Authorization: 'interactive:fixture-header' } };
    await persistCredentialInputs(server, { resolveSensitiveInput, namedSensitiveStore });
    expect(resolveSensitiveInput.mock.calls).toEqual([[{ prefix: 'value', stdin: true }], [{ prefix: 'value', interactive: true }]]);
    expect(saveSecret).toHaveBeenCalledTimes(2);
    expect(server).toEqual({ envFrom: { TOKEN: 'store:fixture-stdin' }, headerEnv: { Authorization: 'store:fixture-header' } });
    expect(JSON.stringify(server)).not.toContain('fixture-transient-secret');
  });

  it('rejects ambiguous stdin and invalid targets before reading input or writing a store', async () => {
    const { persistCredentialInputs } = await cliOwner();
    const resolveSensitiveInput = vi.fn();
    const namedSensitiveStore = vi.fn();
    for (const definition of [
      { envFrom: { TOKEN: 'stdin:first' }, headerEnv: { Authorization: 'stdin:second' } },
      { envFrom: { 'invalid-variable': 'stdin:first' } },
    ]) await expect(persistCredentialInputs(definition, { resolveSensitiveInput, namedSensitiveStore })).rejects.toThrow(/--env-from/);
    expect(resolveSensitiveInput).not.toHaveBeenCalled();
    expect(namedSensitiveStore).not.toHaveBeenCalled();
  });

  it('does not read durable references or prompt during registration', async () => {
    const { persistCredentialInputs } = await cliOwner();
    const resolveSensitiveInput = vi.fn();
    const namedSensitiveStore = vi.fn();
    await persistCredentialInputs({ envFrom: { TOKEN: 'FIXTURE_TOKEN' }, headerEnv: { Authorization: 'store:fixture', 'X-Key': 'file:/synthetic/private' } }, { resolveSensitiveInput, namedSensitiveStore });
    expect(resolveSensitiveInput).not.toHaveBeenCalled();
    expect(namedSensitiveStore).not.toHaveBeenCalled();
  });

  it('sanitizes store-save failure and leaves the definition unmodified', async () => {
    const { persistCredentialInputs } = await cliOwner();
    const server = { envFrom: { TOKEN: 'stdin:fixture' } };
    await expect(persistCredentialInputs(server, {
      resolveSensitiveInput: async () => 'fixture-transient-secret',
      namedSensitiveStore: () => ({ saveSecret: async () => { throw new Error('fixture-transient-secret'); } }),
    })).rejects.toThrow('MCP credential input could not be saved to the native store');
    expect(server.envFrom.TOKEN).toBe('stdin:fixture');
  });

  it('reuses secret-name and policy scanning rules without warning on ordinary/reference values', () => {
    for (const env of [{ API_KEY: 'fixture' }, { clientSecret: 'fixture' }, { AUTH_TOKEN: 'fixture' }, { ENDPOINT: 'https://example.test/?token=fixture' }]) {
      expect(hasSecretLookingLiterals({ env } as never)).toBe(true);
    }
    expect(hasSecretLookingLiterals({ headers: { Cookie: 'fixture' } } as never)).toBe(true);
    expect(hasSecretLookingLiterals({ env: { MODE: 'fixture', API_KEY: '${FIXTURE_KEY}' }, headers: { Accept: 'application/json' } } as never)).toBe(false);
  });

  it('native config writers refuse unresolved new locators rather than serializing values or bogus references', async () => {
    const sourceRegistry = await import(pathToFileURL(path.resolve('src/mcp/registry.mjs')).href);
    for (const reference of ['file:/synthetic/private', 'store:fixture']) {
      const server = { name: 'fixture', type: 'stdio' as const, command: 'synthetic-server', envFrom: { TOKEN: reference } };
      for (const render of [() => renderCredentialMaps(server, 'claude'), () => buildServerToml(server), () => sourceRegistry.buildServerToml(server), () => ompServerConfig(server), () => renderGrokMcpServer(server)]) {
        expect(render).toThrow(/cannot resolve MCP file\/store references.*--env-from KEY=ENV_NAME/);
      }
    }
  });

  it('loads legacy literals unchanged without rewriting the registry', async () => {
    const file = path.join(fixture(), 'mcp-servers.json');
    const raw = JSON.stringify({ apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry', servers: { legacy: { name: 'legacy', type: 'stdio', command: 'synthetic-server', args: ['fixture-arg'], env: { TOKEN: 'fixture-legacy-secret' }, headers: { Authorization: 'fixture-legacy-header' } } } }, null, 4);
    writeFileSync(file, raw);
    const registry = new McpServerRegistry(path.dirname(file));
    const legacy = await registry.get('legacy');
    expect(legacy?.env).toEqual({ TOKEN: 'fixture-legacy-secret' });
    expect(await resolveMcpCredentialMaps(legacy!)).toEqual({ env: legacy!.env, headers: legacy!.headers });
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});

describe('built MCP add/update credential CLI', () => {
  let root: string;
  let config: string;
  let entry: string;
  beforeEach(() => {
    root = fixture();
    config = path.join(root, 'config');
    entry = path.join(config, 'mcp-servers.json');
    mkdirSync(path.join(root, 'bin'));
    // Synthetic native helper: captures argv separately from stdin, and reflects
    // stdin on both streams to verify that successful/failed helper output stays private.
    writeFileSync(path.join(root, 'bin', 'secret-tool'), `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const log = path.join(process.env.HOME, 'helper-argv.json'); fs.writeFileSync(log, JSON.stringify(process.argv.slice(2)));
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
 fs.writeFileSync(path.join(process.env.HOME, 'synthetic-store-value'), input);
 process.stdout.write(input); process.stderr.write(input); if (process.argv.includes('reject-save')) process.exitCode = 1;
});\n`, { mode: 0o700 });
  });
  function run(args: string[], input = '') {
    return spawnSync(process.execPath, ['dist/src/mcp/cli.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8', input, timeout: 20_000,
      env: { PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: root, AIWG_CONFIG: config, AIWG_CONFIG_LAYERS: '', AIWG_SKIP_UPDATE_CHECK: '1', NODE_DEBUG: 'child_process' },
    });
  }
  function stored() { return JSON.parse(readFileSync(entry, 'utf8')).servers.fixture; }
  function output(result: ReturnType<typeof run>) { return result.stdout + result.stderr; }

  it('saves a stdin value through the private helper channel and registers only a store reference', () => {
    const secret = 'fixture-cli-stdin-secret';
    const result = run(['add', 'fixture', '--type', 'stdio', '--command', 'synthetic-server', '--env-from', 'TOKEN=stdin:fixture-token'], secret + '\n');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, 'synthetic-store-value'), 'utf8')).toBe(secret);
    expect(stored().envFrom).toEqual({ TOKEN: 'store:fixture-token' });
    expect(stored().env).toBeUndefined();
    expect(output(result) + readFileSync(entry, 'utf8') + readFileSync(path.join(root, 'helper-argv.json'), 'utf8')).not.toContain(secret);
  });

  it('adds repeated durable references and updates a header using stdin, preserving literal compatibility', () => {
    const file = path.join(root, 'private');
    writeFileSync(file, 'fixture-file-secret', { mode: 0o600 });
    expect(run(['add', 'fixture', '--url', 'https://example.test/mcp', '--header-env', `X-Key=file:${file}`, '--header-env=Authorization=store:fixture-auth', '--env-from', 'TOKEN=FIXTURE_TOKEN']).status).toBe(0);
    expect(stored().headerEnv).toEqual({ 'X-Key': `file:${file}`, Authorization: 'store:fixture-auth' });
    const result = run(['update', '--header-env', 'Authorization=stdin:fixture-updated', 'fixture'], 'fixture-updated-secret\n');
    expect(result.status, result.stderr).toBe(0);
    expect(stored().headerEnv).toEqual({ Authorization: 'store:fixture-updated' });
    expect(output(result) + readFileSync(entry, 'utf8')).not.toContain('fixture-updated-secret');
    expect(readFileSync(entry, 'utf8')).not.toContain('fixture-file-secret');
  });

  it.each(['add', 'update'])('emits one stderr warning for secret-looking %s literals without echoing values', command => {
    if (command === 'update') expect(run(['add', 'fixture', '--url', 'https://example.test/mcp']).status).toBe(0);
    const result = run([command, 'fixture', '--url', 'https://example.test/mcp', '--env', 'API_KEY=fixture-literal-secret', '--headers', 'Authorization: fixture-header-secret']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.match(/literals are deprecated/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('deprecated');
    expect(output(result)).not.toMatch(/fixture-literal-secret|fixture-header-secret/);
    expect(stored().env).toEqual({ API_KEY: 'fixture-literal-secret' });
    expect(stored().headers).toEqual({ Authorization: 'fixture-header-secret' });
  });

  it('keeps ordinary literals and --args unchanged and never implicitly consumes stdin or prompts', () => {
    const result = run(['add', 'fixture', '--type', 'stdio', '--command', 'synthetic-server', '--args', '--token,fixture-arg-secret', '--env', 'MODE=fixture', '--headers', 'Accept=application/json'], 'unused-input');
    expect(result.status, result.stderr).toBe(0);
    expect(output(result)).not.toMatch(/deprecated|Enter value/);
    expect(stored().args).toEqual(['--token', 'fixture-arg-secret']);
    expect(existsSync(path.join(root, 'helper-argv.json'))).toBe(false);
  });

  it.each(['', 'TOKEN=', 'TOKEN=file:', 'TOKEN=file:relative', 'TOKEN=store:', 'TOKEN=fixture-secret=value'])('refuses an invalid --env-from value without reflecting it: %s', reference => {
    const result = run(['add', 'fixture', '--type', 'stdio', '--command', 'synthetic-server', '--env-from', reference]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--env-from');
    expect(output(result)).not.toContain('fixture-secret=value');
    expect(existsSync(entry)).toBe(false);
  });

  it('refuses empty stdin, multiple stdin targets, and headless interactive input without saving config', () => {
    for (const references of [['TOKEN=stdin:fixture'], ['TOKEN=stdin:first,OTHER=stdin:second'], ['TOKEN=interactive:fixture']]) {
      const result = run(['add', 'fixture', '--type', 'stdio', '--command', 'synthetic-server', '--env-from', ...references]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--env-from KEY=stdin|Only one --env-from|interactive terminal/);
      expect(existsSync(entry)).toBe(false);
      expect(existsSync(path.join(root, 'helper-argv.json'))).toBe(false);
    }
  });

  it('refuses native injection before writing config or resolving a private file', () => {
    const file = path.join(root, 'private');
    writeFileSync(file, 'fixture-private-file-secret', { mode: 0o600 });
    expect(run(['add', 'fixture', '--type', 'stdio', '--command', 'synthetic-server', '--env-from', `TOKEN=file:${file}`]).status).toBe(0);
    const out = path.join(root, 'provider-config.json');
    const result = run(['inject', '--provider', 'claude', '--ephemeral', '--out', out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot resolve MCP file/store references');
    expect(output(result) + readFileSync(entry, 'utf8')).not.toContain('fixture-private-file-secret');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses stdio runtime input under child-process debugging before resolving or spawning', () => {
    const program = `
      import { createDefaultMcpClient } from './dist/src/storage/backends/fortemi.js';
      let value = ''; for await (const chunk of process.stdin) value += chunk;
      try {
        await createDefaultMcpClient('fixture', { get: async () => ({ name: 'fixture', type: 'stdio', command: 'secret-tool', envFrom: { TOKEN: 'store:fixture' } }) }, {}, { readStore: async () => value });
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: process.cwd(), encoding: 'utf8', input: 'fixture-debug-secret', timeout: 20_000,
      env: { PATH: path.join(root, 'bin'), HOME: root, AIWG_CONFIG: config, AIWG_CONFIG_LAYERS: '', NODE_DEBUG: 'child_process' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('NODE_DEBUG child_process logging to be disabled');
    expect(result.stdout + result.stderr).not.toContain('fixture-debug-secret');
    expect(existsSync(path.join(root, 'helper-argv.json'))).toBe(false);
  });

  it('sanitizes a reflecting native-store failure without writing the registry', () => {
    const result = run(['add', 'fixture', '--url', 'https://example.test/mcp', '--header-env', 'Authorization=stdin:reject-save'], 'fixture-rejected-secret');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not be saved to the native store');
    expect(output(result)).not.toContain('fixture-rejected-secret');
    expect(existsSync(entry)).toBe(false);
  });
});
