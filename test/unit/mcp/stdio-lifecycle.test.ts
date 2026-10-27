// Exercise stdio lifetime through the same forced-exit boundary as bin/aiwg.mjs.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launch() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-mcp-lifetime-'));
  roots.push(root);
  const home = path.join(root, 'home');
  mkdirSync(home);
  mkdirSync(path.join(root, '.aiwg'));
  const cli = pathToFileURL(path.join(repoRoot, 'src/mcp/cli.mjs')).href;
  const script = `const { main } = await import(${JSON.stringify(cli)});
    main(['serve', '--toolsets', 'workers']).then(() => process.exit(0)).catch(error => {
      console.error(error); process.exit(1);
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
      AIWG_CONFIG: path.join(home, 'config'), AIWG_ROOT: repoRoot,
      AIWG_PROJECT_AIWG_DIR: path.join(root, '.aiwg'), NO_UPDATE_NOTIFIER: '1', CI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.on('error', () => {}); // close rejects pending requests below
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (!message.id) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler?.reject(new Error(JSON.stringify(message.error)));
    else handler?.resolve(message.result);
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, signal) => {
      for (const handler of pending.values()) handler.reject(new Error(`MCP closed: ${code}/${signal}: ${stderr}`));
      pending.clear();
      resolve({ code, signal });
    });
  });
  function send(method: string, params: unknown) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function request(method: string, params: unknown) {
    const requestId = ++id;
    return new Promise<any>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  async function initialize() {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'offline-lifecycle-fixture', version: '1' } });
    send('notifications/initialized', {});
  }
  return { child, closed, request, initialize };
}

describe('MCP stdio CLI lifetime', () => {
  it('keeps worker-invoke available after connect, refusal and status, then exits on EOF', async () => {
    const server = launch();
    await server.initialize();
    const tools = await server.request('tools/list', {});
    expect(tools.tools.some((tool: { name: string }) => tool.name === 'worker-invoke')).toBe(true);
    const refusal = await server.request('tools/call', { name: 'worker-invoke', arguments: { operation: 'run' } });
    expect(refusal.isError).toBe(true);
    const status = await server.request('tools/call', { name: 'worker-invoke', arguments: { operation: 'status' } });
    expect(status.isError).not.toBe(true);
    expect(JSON.parse(status.content[0].text)).toBeTypeOf('object');
    expect(server.child.exitCode).toBeNull();
    server.child.stdin.end();
    expect(await server.closed).toEqual({ code: 0, signal: null });
  }, 15000);

  it.each(['SIGINT', 'SIGTERM'] as const)('closes cleanly on %s', async signal => {
    const server = launch();
    await server.initialize();
    server.child.kill(signal);
    expect(await server.closed).toEqual({ code: 0, signal: null });
  }, 15000);
});
