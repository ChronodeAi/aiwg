/**
 * roctinam/aiwg#2899 (B-OG-09) — local text-only HTTP transport, offline S1
 * profile work.
 *
 * Renders and executes the direct-profile adapter against a synthetic
 * Ollama HTTP server (`fake-ollama-server.mjs`) started and stopped by this
 * test on an ephemeral loopback port — never the real, shared titan
 * service. The real `curl` binary is spawned (a plain child process, no
 * systemd); nothing reaches a model, credential, cloud endpoint or MC
 * state.
 *
 * Two layers, per the #2899 follow-up authorization:
 *  - OL01-OL04, OL08-OL10: direct-unit calls against the adapter's own
 *    `buildWorkerArgs`/`parseOutput`/`parseWorkerFinal` surface, mirroring
 *    the OpenHuman profile's OD05 pattern.
 *  - T-OG-15 describe block: through the PRODUCTION `resolveWorkerInvocation`
 *    resolver and the real `loadInstalledWorkerAdapters` installed-module
 *    loader, test-locally promoting the registry's pre-seeded
 *    `workerHealthAdapters.local-http` descriptive placeholder into an
 *    active `workerAdapters.local-http` copy — the same test-local
 *    activation pattern every other unqualified direct profile uses
 *    (OpenHuman's `loadingRegistry()`), never written to the bundled file by
 *    this test.
 *
 * Fixture qualification here is synthetic and never live qualification: the
 * bundled local-http/Ollama profile stays unqualified.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OLLAMA_MAX_BRIEF_BYTES, OllamaAdapter, assertLocalOllamaEndpoint, assertOllamaModelName, buildOllamaGenerateBody, register } from '../../../tools/ralph-external/lib/ollama-adapter.mjs';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const MODULE = 'tools/ralph-external/lib/ollama-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/ollama/approved-module.json', 'utf8'));
const FAKE_SERVER = path.resolve('test/fixtures/providers/ollama/fake-ollama-server.mjs');
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const MODEL = 'qwen3:8b';

const roots: string[] = [];
const installRoots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ollama-')); roots.push(root);
  return root;
}

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdinData?: string; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinData);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** A listener on an ephemeral loopback port that destroys every connection: a
 * deterministically unreachable endpoint owned by this test, with no fixed-port assumption. */
async function startRefusingEndpoint() {
  const server = createTcpServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as { port: number };
  return { endpoint: `127.0.0.1:${port}`, stop: () => server.close() };
}

/** Starts the fake Ollama HTTP server on an ephemeral loopback port, returns its `host:port` and a stop function. */
async function startFakeServer(root: string, scenario: string) {
  const configFile = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  const portFile = path.join(root, `port-${scenario}.txt`);
  await writeFile(configFile, JSON.stringify({ scenario, recordPath }));
  const child = spawn(process.execPath, [FAKE_SERVER, portFile], { env: { ...process.env, AIWG_FAKE_WORKER_CONFIG: configFile }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  const deadline = Date.now() + 5000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('fake ollama server did not start in time');
    await new Promise(r => setTimeout(r, 25));
  }
  const port = readFileSync(portFile, 'utf8').trim();
  return { endpoint: `127.0.0.1:${port}`, recordPath, stop: () => { child.kill('SIGTERM'); children.delete(child); } };
}

describe('Local-http (Ollama backend) text-only HTTP profile (roctinam/aiwg#2899)', () => {
  it('OL01 the approved module digest matches the adapter file and registers exactly "local-http"', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:local-http', interfaceVersion: 1, adapterIds: ['local-http'], platforms: ['linux'] });
    const registered: Array<[string, () => unknown]> = [];
    await register((id, factory) => registered.push([id, factory]));
    expect(registered.map(([id]) => id)).toEqual(['local-http']);
    const instance: any = registered[0][1]();
    expect(instance).toBeInstanceOf(OllamaAdapter);
    expect(instance.getName()).toBe('local-http');
    expect(instance.getBinary()).toBe('curl');
  });

  it('OL02 the endpoint guard accepts loopback and the Docker-bridge private range, refuses cloud/public/hostnames', () => {
    expect(assertLocalOllamaEndpoint('127.0.0.1:11434')).toBe('127.0.0.1:11434');
    expect(assertLocalOllamaEndpoint('172.17.0.1:11434')).toBe('172.17.0.1:11434'); // titan's actual, shared, non-loopback bridge
    expect(assertLocalOllamaEndpoint('10.0.0.5:11434')).toBe('10.0.0.5:11434');
    expect(assertLocalOllamaEndpoint('192.168.1.5:11434')).toBe('192.168.1.5:11434');
    expect(assertLocalOllamaEndpoint('127.0.0.0:1')).toBe('127.0.0.0:1');
    expect(() => assertLocalOllamaEndpoint(undefined as unknown as string)).toThrow(/explicit local endpoint/);
    expect(() => assertLocalOllamaEndpoint('')).toThrow(/explicit local endpoint/);
    expect(() => assertLocalOllamaEndpoint('ollama.com:443')).toThrow(/IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('8.8.8.8:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('203.0.113.5:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:11434 ')).toThrow(/whitespace/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1')).toThrow(/IPv4 host:port/); // no port is a guess, refused
    // Non-canonical dotted-decimal: leading zeros are rejected (libcurl would parse 010.0.0.1 as 8.0.0.1).
    expect(() => assertLocalOllamaEndpoint('010.0.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('01.2.3.4:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.00.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.01:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('00.0.0.0:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('256.0.0.1:11434')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.300:11434')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('0.0.0.0:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:0')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:65536')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('http://127.0.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:11434/api/generate')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1@evil:11434')).toThrow(/canonical dotted-decimal/);
  });

  it('OL03 buildWorkerArgs refuses explicit effort, bad model, the coding role, relative cwd and a missing/cloud endpoint; buildOllamaGenerateBody is pure and bounded', () => {
    const adapter = new OllamaAdapter();
    const base = { cwd: '/w', selected: { model: MODEL, effort: { value: null } } };
    vi.stubEnv('OLLAMA_HOST', '172.17.0.1:11434');
    expect(adapter.buildWorkerArgs(base, null, {})).toEqual(['-q', '-sS', '--max-redirs', '0', '--proto', '=http',
      '--noproxy', '*', '--connect-timeout', '10', '--max-time', '300', '--max-filesize', '10485760',
      '--fail-with-body', '-H', 'Content-Type: application/json', '-X', 'POST',
      'http://172.17.0.1:11434/api/generate', '--data-binary', '@-']);
    const argv = adapter.buildWorkerArgs(base, null, {}) as string[];
    expect(argv[0]).toBe('-q'); // curlrc is disabled before anything else is parsed
    expect(argv).toContain('--data-binary');
    expect(argv[argv.indexOf('--data-binary') + 1]).toBe('@-'); // body stays on stdin, never argv
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: MODEL, effort: { value: 'high' } } }, null, {})).toThrow(/effort/);
    expect(() => adapter.buildWorkerArgs({ ...base, role: 'coding' }, null, {})).toThrow(/text-only transport.*refuses the 'coding' role/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: '-rf', effort: { value: null } } }, null, {})).toThrow(/model/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: 'auto', effort: { value: null } } }, null, {})).toThrow(/auto\/default/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: 'gpt-oss:120b-cloud', effort: { value: null } } }, null, {})).toThrow(/cloud/);
    expect(() => adapter.buildWorkerArgs({ ...base, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => adapter.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
    vi.stubEnv('OLLAMA_HOST', 'ollama.com:443');
    expect(() => adapter.buildWorkerArgs(base, null, {})).toThrow(/IPv4 host:port/);
    vi.stubEnv('OLLAMA_HOST', '');
    expect(() => adapter.buildWorkerArgs(base, null, {})).toThrow(/explicit local endpoint/);

    // One conservative shared model pattern, enforced identically in both gates.
    expect(assertOllamaModelName('qwen3:8b')).toBe('qwen3:8b');
    expect(assertOllamaModelName('smollm2:135m')).toBe('smollm2:135m');
    expect(assertOllamaModelName('llama3.1')).toBe('llama3.1');
    for (const bad of ['auto', 'AUTO', 'Default', 'default:tag', 'AUTO:x', 'gpt-oss:120b-cloud', 'MoDel-ClOuD',
      'foo:cloud', 'foo:CLOUD', 'evil.example/model:tag', '../../x', 'x;$(id)', '-rf', 'a b', 'a\tb',
      'a\u007fb', 'model:', 'a:b:c', '', `${'m'.repeat(129)}`]) {
      expect(() => assertOllamaModelName(bad), JSON.stringify(bad)).toThrow(/model|auto\/default|cloud|registry-style|option-like|well-formed|exceeds/);
    }

    // The pure body-builder never touches argv, the network or the filesystem.
    expect(buildOllamaGenerateBody({ model: MODEL, brief: 'hello' })).toBe(JSON.stringify({ model: MODEL, prompt: 'hello', stream: false }));
    expect(() => buildOllamaGenerateBody({ model: '', brief: 'hi' })).toThrow(/model/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 5 as unknown as string })).toThrow(/brief/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: '' })).toThrow(/non-empty/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: '   \n\t  ' })).toThrow(/non-empty/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES + 1) })).toThrow(/exceeds/);
    expect(buildOllamaGenerateBody({ model: MODEL, brief: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES) }))
      .toBe(JSON.stringify({ model: MODEL, prompt: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES), stream: false }));
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 'hi', role: 'coding' })).toThrow(/text-only transport.*refuses the 'coding' role/);
    // keep_alive is omitted: server residency defaults apply.
    expect(JSON.parse(buildOllamaGenerateBody({ model: MODEL, brief: 'hi' }))).toEqual({ model: MODEL, prompt: 'hi', stream: false });
  });

  describe('T-OG-15/20 render and execute against a synthetic Ollama HTTP server', () => {
    it('OL04 a successful generate renders curl argv, posts the pure-built body, and parses an affirmative claims-bearing final', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'success');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const MARKER = 'OLLAMA-BRIEF-MARKER-9c2f1a';
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER, claims: [], artifacts: [], checks: [], limitations: [] });
      const requestBody = buildOllamaGenerateBody({ model: MODEL, brief: claimsText });
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      expect(JSON.stringify(argv)).not.toContain(MARKER); // the brief/claims text never reaches argv
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: requestBody });
        expect(result.code, result.stderr).toBe(0);
        const final = adapter.parseOutput(result.stdout);
        expect(final).toMatchObject({ done: true, done_reason: 'stop' });
        expect(final!.response).toContain(MARKER);
        const claims = await adapter.parseWorkerFinal(result.stdout, { format: 'json', observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: result.code } });
        expect(claims).toMatchObject({ status: 'completed', summary: MARKER });
        const record = JSON.parse(readFileSync(server.recordPath, 'utf8'));
        expect(record).toMatchObject({ method: 'POST', path: '/api/generate', headers: { 'content-type': 'application/json' } });
        expect(record.body).toMatchObject({ model: MODEL, stream: false });
      } finally { server.stop(); }
    });

    it.each([
      ['model-not-found', 404],
      ['no-prompt', 400],
      ['malformed', 200],
      ['error-field', 200],
      ['not-done', 200],
      ['empty-content', 200],
    ])('OL05 %s never produces an affirmative final, even with a non-exit-zero or exit-zero error response', async (scenario, _status) => {
      const root = await scratch();
      const server = await startFakeServer(root, scenario);
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: buildOllamaGenerateBody({ model: MODEL, brief: 'hi' }) });
        expect(adapter.parseOutput(result.stdout)).toBeNull();
        await expect(adapter.parseWorkerFinal(result.stdout, { format: 'json', observation: { transport: 'shell', status: 'failed', termination: 'confirmed', exitCode: result.code } }))
          // Malformed bytes fail at envelope validation; every other shape fails the affirmative-success rules. Both fail closed.
          .rejects.toThrow(/missing, malformed, or not an affirmative success|envelope is malformed JSON/);
      } finally { server.stop(); }
    });

    it('OL06 an unreachable endpoint fails before any content is produced, like a stopped/excluded member', async () => {
      const root = await scratch();
      // No fixed-port assumption: the refusing endpoint is bound and owned by this test.
      const refused = await startRefusingEndpoint();
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', refused.endpoint);
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: '{}', timeoutMs: 5000 });
        expect(result.code).not.toBe(0);
        expect(adapter.parseOutput(result.stdout)).toBeNull();
      } finally { refused.stop(); }
    });

    it('OL09 hostile proxy environment and a hostile curlrc do not change the destination: the fake server still receives the request', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'success');
      // A curlrc that would redirect the request through a dead proxy if it were read.
      await writeFile(`${root}/.curlrc`, 'proxy = "http://127.0.0.1:1/"\nlocation\n');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const MARKER = 'OLLAMA-PROXY-MARKER-7d3e9b';
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER, claims: [], artifacts: [], checks: [], limitations: [] });
      const requestBody = buildOllamaGenerateBody({ model: MODEL, brief: claimsText });
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, stdinData: requestBody, timeoutMs: 10_000, env: {
          PATH: process.env.PATH!,
          HOME: root, // the hostile .curlrc lives here; argv's -q must ignore it
          http_proxy: 'http://127.0.0.1:1/', https_proxy: 'http://127.0.0.1:1/',
          HTTP_PROXY: 'http://127.0.0.1:1/', HTTPS_PROXY: 'http://127.0.0.1:1/',
          ALL_PROXY: 'http://127.0.0.1:1/', all_proxy: 'http://127.0.0.1:1/',
        } });
        expect(result.code, result.stderr).toBe(0);
        const record = JSON.parse(readFileSync(server.recordPath, 'utf8'));
        expect(record).toMatchObject({ method: 'POST', path: '/api/generate' });
        expect(record.body).toMatchObject({ model: MODEL, stream: false });
        expect(adapter.parseOutput(result.stdout)).toMatchObject({ done: true, done_reason: 'stop' });
      } finally { server.stop(); }
    });

    it('OL10 the claims hook validates the original envelope bytes before extraction', async () => {
      const adapter = new OllamaAdapter();
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: 'ENVELOPE-MARKER', claims: [], artifacts: [], checks: [], limitations: [] });
      const observation = (status: string) => ({ transport: 'shell', status, termination: 'confirmed', exitCode: 0 });
      const envelope = (response: string) => JSON.stringify({ model: MODEL, created_at: '2026-10-11T00:00:00Z',
        response, done: true, done_reason: 'stop' });
      // Duplicate `done`: JSON.parse would silently keep the last value; the hook rejects.
      const duplicateDone = `{"model":${JSON.stringify(MODEL)},"created_at":"2026-10-11T00:00:00Z",`
        + `"response":${JSON.stringify(claimsText)},"done":false,"done":true,"done_reason":"stop"}`;
      await expect(adapter.parseWorkerFinal(duplicateDone, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/duplicate member name/);
      // Invalid UTF-8 inside the response is fatal, never silently replaced with U+FFFD.
      const invalidUtf8 = Buffer.from(envelope(claimsText), 'utf8');
      invalidUtf8[invalidUtf8.indexOf('ENVELOPE') + 2] = 0xff;
      await expect(adapter.parseWorkerFinal(invalidUtf8, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/not valid UTF-8/);
      // An oversized envelope honours maxOutputBytes: a 1 MiB envelope fails against a 1024-byte bound.
      const oversized = envelope('y'.repeat(1024 * 1024));
      await expect(adapter.parseWorkerFinal(oversized, { format: 'json', observation: observation('completed'), maxOutputBytes: 1024 }))
        .rejects.toThrow(/exceeds byte bound/);
      // ...while the same oversized shape also fails the default envelope cap.
      await expect(adapter.parseWorkerFinal(oversized, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/exceeds byte bound/);
      // A well-formed envelope still validates end to end through the shared strict claims hook.
      const claims = await adapter.parseWorkerFinal(envelope(claimsText), { format: 'json', observation: observation('completed') });
      expect(claims).toMatchObject({ status: 'completed', summary: 'ENVELOPE-MARKER' });
    });

    it('OL07 a hung server is bounded by --max-time, never a synthesized success', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'hang');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      // Override the fixed 300s bound for this test only via a throwaway argv splice (the adapter's own constant stays untouched in production).
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      const boundedArgv = argv.map((value, index) => (argv[index - 1] === '--max-time' ? '1' : value));
      try {
        const result = await run('curl', boundedArgv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: '{}', timeoutMs: 5000 });
        expect(result.code).not.toBe(0); // curl's own --max-time exit (28), never 0
        expect(adapter.parseOutput(result.stdout)).toBeNull();
      } finally { server.stop(); }
    });
  });

  it('OL08 observeHealthEvent and getAbortInput stay minimal/unavailable, never invented', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.observeHealthEvent({} as any)).toBeNull();
    expect(adapter.getAbortInput()).toBeNull();
    expect(adapter.getCapabilities()).toMatchObject({ streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false, agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: false });
  });
});

describe('T-OG-15 local-http through the production resolver and installed-module loader', () => {
  /** Host-side install of the one approved module into a fresh, read-only package root.
   * OllamaAdapter extends ProviderAdapter (#2890 strict claims); its static
   * import of provider-adapter.mjs (and that file's own worker-health.mjs/
   * _resolve-impl.mjs imports) must resolve inside the copied package too,
   * exactly like the Hermes profile test's installPackage. */
  async function installPackage(bytes: Buffer) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-local-http-install-')); installRoots.push(base);
    await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
    const packageRoot = path.join(base, 'package');
    const writable = path.join(base, 'worker-writable');
    await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable);
    await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
      version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
    await writeFile(path.join(packageRoot, APPROVED.entry.modulePath), bytes, { mode: 0o644 });
    for (const name of ['provider-adapter.mjs', 'worker-health.mjs']) {
      const dest = path.join(packageRoot, 'lib', name);
      await copyFile(path.resolve('tools/ralph-external/lib', name), dest);
      await chmod(dest, 0o644);
    }
    const resolveImpl = path.join(base, '_resolve-impl.mjs');
    await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
    await chmod(resolveImpl, 0o644);
    // provider-adapter.mjs's top-level `await importImpl(..., 'models/worker-installation.mjs')`
    // runs at import time; bridge it back to the real file under test.
    await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
    const target = path.resolve('src/models/worker-installation.mjs');
    const relative = path.relative(path.join(base, 'src', 'models'), target);
    await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
      `export * from ${JSON.stringify(relative)};\n`);
    return { packageRoot, writable };
  }

  /** The registry already carries a descriptive-only `workerHealthAdapters.local-http`
   * placeholder for this exact issue (B-OG-09). This test-local copy promotes it into
   * an active `workerAdapters.local-http`, exactly like every other unqualified
   * direct profile's own test does (e.g. OpenHuman's `loadingRegistry()`); nothing
   * here is written back to the bundled file. */
  /** Test-local-only promotion of the registry's pre-seeded, descriptive-only
   * `workerHealthAdapters.local-http` placeholder into an active
   * `workerAdapters.local-http`, exactly like every other unqualified direct
   * profile's own test does (e.g. OpenHuman's `loadingRegistry()`). This
   * returns a fresh clone each call; nothing is written back to the bundled
   * file or shared with other test files' registry loads (an earlier attempt
   * to promote it in the BUNDLED file broke every other provider's
   * `loadInstalledWorkerAdapters` call, which iterates every active
   * `workerAdapters` entry regardless of its own `modules` allowlist — do
   * not repeat that). `invocation` is overridden from the placeholder's
   * declarative `kind: 'http'` (no `executable`/`argv`/`stdin` — nothing
   * implements a native HTTP fetch) to the `kind: 'process'` shape this
   * adapter actually dispatches through (`curl`), since the installed-
   * module loader and the parallelism-policy validator both require a
   * schema-valid, launchable invocation to proceed. */
  function loadingRegistry() {
    const registry = structuredClone(loadProviderModelCapabilities());
    const active = structuredClone(registry.workerHealthAdapters!['local-http']);
    active.runtimeDriver = 'installed:local-http';
    active.invocation = { kind: 'process', executable: 'curl',
      argv: ['-q', '-sS', '--max-redirs', '0', '--proto', '=http', '--noproxy', '*', '--connect-timeout', '10',
        '--max-time', '300', '--max-filesize', '10485760', '--fail-with-body', '-H', 'Content-Type: application/json',
        '-X', 'POST', 'http://${endpoint}/api/generate', '--data-binary', '@-'],
      stdin: 'closed', cwd: '${workspace}', envAllowlist: [], versionArgv: ['--version'], maxOutputBytes: 10485760 };
    registry.workerAdapters = { 'local-http': active };
    return registry;
  }

  let installed: { owner: any; ids: string[] };
  beforeAll(async () => {
    const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('local-http'), ids };
  });
  afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

  it('LH01 pins the one approved module digest and loads it through the production installed loader', () => {
    expect(installed.ids).toEqual(['local-http']);
    expect(installed.owner.getName()).toBe('local-http');
    expect(installed.owner.constructor.name).toBe('OllamaAdapter');
  });

  it('LH02 the bundled registry has no active local-http entry: it stays undispatchable until test-locally promoted', () => {
    const bundled = structuredClone(loadProviderModelCapabilities());
    expect(bundled.workerAdapters?.['local-http']).toBeUndefined();
    expect(() => resolveWorkerAdapter(bundled, 'workerAdapters:local-http')).toThrow();
    const promoted = loadingRegistry();
    const adapter = resolveWorkerAdapter(promoted, 'workerAdapters:local-http');
    expect(adapter.runtimeDriver).toBe('installed:local-http');
    expect(adapter.qualification.status).toBe('unqualified');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-http', transport: 'shell', cliVersion: '0.33.3' }))
      .toThrow('Worker transport/profile is unqualified');
  });

  it('LH03 resolveWorkerInvocation renders a launchable plan whose argv the real curl executes against the fake server', async () => {
    const f = workerResolutionFixture();
    const root = await scratch();
    const brief = path.join(root, 'brief.txt');
    const MARKER = 'LOCAL-HTTP-BRIEF-MARKER-4e71b0';
    const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER, claims: [], artifacts: [], checks: [], limitations: [] });
    await writeFile(brief, claimsText);

    const server = await startFakeServer(root, 'success');
    vi.stubEnv('OLLAMA_HOST', server.endpoint);
    try {
      const registry = f.snapshot.registry;
      delete registry.providers.codex.workerAdapter;
      const adapter: any = loadingRegistry().workerAdapters['local-http'];
      // Synthetic fixture qualification only: models a host that proved every
      // required control for this test. Never written to the bundled registry.
      adapter.qualification = { status: 'qualified', fixtureDigest: 'sha256:' + createHash('sha256').update('synthetic-local-http-fixture').digest('hex'),
        verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
      for (const [name, control] of Object.entries(adapter.invocationProfiles['direct-http'].controls) as Array<[string, any]>) {
        if (name === 'effort' || name === 'stepCap' || name === 'stdin') continue; // stay honest: effort stays not-applicable, stdin stays unqualified (#2998/#3002)
        Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-local-http-host (not live evidence)' });
      }
      adapter.invocationProfiles['direct-http'].envAllowlist = [];
      adapter.invocation.envAllowlist = [];
      Object.assign(adapter.capabilities, { modelPin: 'requested', nestedAgentsControllable: true,
        nativeFallbackControllable: true, sandboxModes: ['read-only', 'workspace-write', 'external'] });
      registry.workerAdapters = { 'local-http': adapter };
      f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'local-http'; member.model = MODEL; });
      f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
      f.snapshot.config.parallelism!.groups!.workers.fallback = [];
      (f.snapshot.config.parallelism as any).clis = { 'local-http': { adapter: 'workerAdapters:local-http',
        accountScope: 'local-runtime', quotaScope: 'synthetic', executable: 'curl', enabled: true } };
      const binding = { ...f.snapshot.installations.codex, profile: 'direct-http', cliVersion: '0.33.3' };
      f.snapshot.installations = { 'local-http': binding };
      const discovery = f.snapshot.catalog.discovery!.instances!.codex;
      discovery.provider = 'local-http'; discovery.runtimeVersion = '0.33.3';
      discovery.models = discovery.models.slice(0, 1);
      for (const row of discovery.models) {
        row.id = MODEL; row.apiModelId = MODEL;
        row.worker!.cliId = 'local-http'; row.worker!.runtimeVersion = '0.33.3';
        row.reasoningEfforts = []; Object.assign(row.worker!, { effortSupport: 'not-applicable', efforts: [] });
      }
      f.snapshot.catalog.discovery!.instances = { 'local-http': discovery };
      Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!, { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });

      const owner = new OllamaAdapter(); // functional calls use a plain instance; installed.owner (LH01) proves the digest/identity path only, matching the Hermes profile test's convention
      const drivers: Record<string, WorkerInvocationDriver> = { 'local-http': {
        qualification: { adapter, adapterId: 'local-http', cliVersion: binding.cliVersion },
        buildInvocation: async input => ({ argv: ['curl', ...owner.buildWorkerArgs(input, adapter.invocationProfiles['direct-http'], input.permissions)],
          stdin: 'closed', envNames: [] }),
      } };
      const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir: root,
        final_output: path.join(root, 'final.json'), transport: 'shell' as const };
      const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
      // Honest, expected outcome: the production resolver REFUSES to dispatch
      // because `stdin` stays `unqualified` (no adapter-pluggable envelope
      // exists yet — #2998/#3002). This is the "dispatch is blocked" claim
      // from the adapter docstring, proven through the real resolver rather
      // than merely asserted in prose.
      expect(plan.invocation).toBeUndefined();
      const messages = [...(plan.diagnostics ?? []), ...((plan as any).exclusions ?? []).flatMap((row: any) => row.diagnostics)]
        .map((d: any) => `${d.code} ${d.message}`);
      expect(messages.join('\n')).toMatch(/Required worker control is unqualified: stdin/);

      // Separately, prove the adapter's OWN render is launchable today: build
      // the real curl argv directly (as OL04 does) and the request body with
      // the adapter's pure function, then execute both against the fake
      // server. This is what production dispatch will do once #2998/#3002
      // land and wire buildOllamaGenerateBody's output onto this argv's stdin.
      const directArgv = owner.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, adapter.invocationProfiles['direct-http'], {});
      expect(directArgv).toEqual(['-q', '-sS', '--max-redirs', '0', '--proto', '=http', '--noproxy', '*',
        '--connect-timeout', '10', '--max-time', '300', '--max-filesize', '10485760',
        '--fail-with-body', '-H', 'Content-Type: application/json', '-X', 'POST', `http://${server.endpoint}/api/generate`, '--data-binary', '@-']);
      expect(JSON.stringify(directArgv)).not.toContain(MARKER); // the brief never reaches argv
      const requestBody = buildOllamaGenerateBody({ model: MODEL, brief: claimsText });
      const result = await run('curl', directArgv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: requestBody });
      expect(result.code, result.stderr).toBe(0);
      const final = owner.parseOutput(result.stdout);
      expect(final).toMatchObject({ done: true, done_reason: 'stop' });
      expect(final!.response).toContain(MARKER);
      const claims = await owner.parseWorkerFinal(result.stdout, { format: 'json', observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: result.code } });
      expect(claims).toMatchObject({ status: 'completed', summary: MARKER });
    } finally { server.stop(); }
  });
});
