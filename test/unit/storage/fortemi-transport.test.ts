import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const captures = vi.hoisted(() => ({
  connected: [] as unknown[],
  http: [] as Array<{ url: URL; options: Record<string, unknown> }>,
  sse: [] as Array<{ url: URL; options: Record<string, unknown> }>,
  stdio: [] as Array<Record<string, unknown>>,
  error: undefined as string | undefined,
  reply: undefined as unknown,
  debug: false,
}));

vi.mock('node:util', async importOriginal => ({ ...await importOriginal<typeof import('node:util')>(), debuglog: () => ({ get enabled() { return captures.debug; } }) }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(transport: unknown) {
      captures.connected.push(transport);
      if (captures.error) throw new Error(captures.error);
    }
    async callTool() {
      return captures.reply ?? { structuredContent: { not_found: true } };
    }
    async listTools() { return captures.reply; }
    getServerVersion() { return captures.reply; }
    async close() { if (captures.error) throw new Error(captures.error); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: Record<string, unknown>) {
      captures.http.push({ url, options });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(url: URL, options: Record<string, unknown>) {
      captures.sse.push({ url, options });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      captures.stdio.push(options);
    }
  },
}));

import { createDefaultMcpClient } from "../../../src/storage/backends/fortemi.js";

const roots: string[] = [];
beforeEach(() => { captures.error = undefined; captures.reply = undefined; captures.debug = false; captures.connected = []; captures.http = []; captures.sse = []; captures.stdio = []; });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function privateFile(value: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-mcp-runtime-input-'));
  roots.push(root);
  const file = path.join(root, 'private');
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}

describe("Fortemi MCP transport construction (#1508)", () => {
  it("connects a local workstation stdio registry entry", async () => {
    const client = await createDefaultMcpClient("fortemi", {
      get: async () => ({
        name: "fortemi",
        type: "stdio",
        command: "/opt/fortemi/bin/mcp-server",
        args: ["--local"],
      }),
    });

    expect(captures.stdio.at(-1)).toMatchObject({
      command: "/opt/fortemi/bin/mcp-server",
      args: ["--local"],
    });
    expect(
      await client.callTool("get_note", { note_id: "research:REF-001.md" }),
    ).toEqual({
      not_found: true,
    });
  });

  it("connects authenticated Enterprise Streamable HTTP with a runtime bearer header", async () => {
    await createDefaultMcpClient(
      "fortemi-enterprise",
      {
        get: async () => ({
          name: "fortemi-enterprise",
          type: "http",
          url: "https://memory.example.internal/mcp",
          headerEnv: { Authorization: "AIWG_FORTEMI_TOKEN" },
        }),
      },
      { AIWG_FORTEMI_TOKEN: "synthetic-enterprise-token" },
    );

    const constructed = captures.http.at(-1)!;
    expect(constructed.url.href).toBe("https://memory.example.internal/mcp");
    expect(constructed.options).toMatchObject({
      requestInit: {
        headers: { Authorization: "Bearer synthetic-enterprise-token" },
      },
    });
  });

  it("constructs legacy SSE with credential headers on stream and POST requests", async () => {
    await createDefaultMcpClient(
      "fortemi-sse",
      {
        get: async () => ({
          name: "fortemi-sse",
          type: "sse",
          url: "https://memory.example.internal/sse",
          headerEnv: { Authorization: "AIWG_FORTEMI_TOKEN" },
        }),
      },
      { AIWG_FORTEMI_TOKEN: "synthetic-sse-token" },
    );

    const constructed = captures.sse.at(-1)!;
    expect(constructed.options).toMatchObject({
      requestInit: {
        headers: { Authorization: "Bearer synthetic-sse-token" },
      },
      eventSourceInit: { fetch: expect.any(Function) },
    });
  });

  it.each(['http', 'sse'] as const)('resolves file/store headers for %s only at connection time', async type => {
    const file = privateFile('fixture-header-secret');
    const server = { name: 'fixture', type, url: 'https://example.test/mcp', headerEnv: { Authorization: 'store:fixture-auth', 'X-Key': `file:${file}` } };
    const raw = JSON.stringify(server);
    const readStore = vi.fn(async () => 'fixture-store-secret');
    await createDefaultMcpClient('fixture', { get: async () => server }, {}, { readStore });
    expect((type === 'http' ? captures.http : captures.sse).at(-1)!.options).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer fixture-store-secret', 'X-Key': 'fixture-header-secret' } } });
    expect(readStore).toHaveBeenCalledWith('fixture-auth');
    expect(JSON.stringify(server)).toBe(raw);
  });

  it('sends resolved stdio values only in the recipient environment and pipes stderr', async () => {
    const file = privateFile('fixture-env-secret');
    await createDefaultMcpClient('fixture', { get: async () => ({ name: 'fixture', type: 'stdio', command: 'synthetic-server', args: ['--fixture'], env: { MODE: 'fixture' }, envFrom: { TOKEN: `file:${file}`, OTHER_TOKEN: 'store:fixture-auth' } }) }, {}, { readStore: async () => 'fixture-store-secret' });
    const constructed = captures.stdio.at(-1)!;
    expect(constructed).toEqual({ command: 'synthetic-server', args: ['--fixture'], env: { MODE: 'fixture', TOKEN: 'fixture-env-secret', OTHER_TOKEN: 'fixture-store-secret' }, stderr: 'pipe' });
    expect(JSON.stringify(constructed.args)).not.toMatch(/fixture-env-secret|fixture-store-secret/);
  });

  it('redacts reflected credentials from transport errors and returned tool records', async () => {
    const file = privateFile('fixture-env-secret');
    const server = { name: 'fixture', type: 'http' as const, url: 'https://example.test/mcp', headerEnv: { 'X-Key': `file:${file}` } };
    captures.error = 'connection rejected fixture-env-secret';
    await expect(createDefaultMcpClient('fixture', { get: async () => server }, {})).rejects.toThrow('connection rejected [REDACTED]');
    captures.error = undefined;
    const client = await createDefaultMcpClient('fixture', { get: async () => server }, {});
    captures.reply = { structuredContent: { reflected: 'fixture-env-secret' } };
    expect(await client.callTool('fixture', {})).toEqual({ reflected: '[REDACTED]' });
    captures.reply = { isError: true, content: [{ type: 'text', text: 'rejected fixture-env-secret' }] };
    await expect(client.callTool('fixture', {})).rejects.toThrow('rejected [REDACTED]');
  });
});


describe('Fortemi credential compatibility and refusal (#3079)', () => {
  it.each(['env', 'literal'] as const)('protects legacy %s header errors and reflected tool results', async source => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const server = { name: 'fixture', type: 'http' as const, url: 'https://example.test/mcp',
      ...(source === 'env' ? { headerEnv: { Authorization: 'FIXTURE_TOKEN' } } : { headers: { Authorization: 'Bearer fixture-legacy-secret' } }),
    };
    const environment = { FIXTURE_TOKEN: 'fixture-legacy-secret' };
    captures.error = 'reflected fixture-legacy-secret';
    await expect(createDefaultMcpClient('fixture', { get: async () => server }, environment)).rejects.toThrow('reflected [REDACTED]');
    captures.error = undefined;
    const client = await createDefaultMcpClient('fixture', { get: async () => server }, environment);
    expect(captures.http.at(-1)!.options).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer fixture-legacy-secret' } } });
    captures.reply = { structuredContent: { text: 'fixture-legacy-secret' } };
    expect(await client.callTool('fixture', {})).toEqual({ text: '[REDACTED]' });
    captures.reply = { tools: [{ name: 'fixture-legacy-secret' }] };
    expect(await client.listTools!()).toEqual({ tools: [{ name: '[REDACTED]' }] });
    captures.reply = { version: 'fixture-legacy-secret' };
    expect(client.serverVersion!()).toEqual({ version: '[REDACTED]' });
    captures.error = 'close echoed fixture-legacy-secret';
    await expect(client.close!()).rejects.toThrow('close echoed [REDACTED]');
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain('fixture-legacy-secret');
  });

  it.each(['literal', 'env', 'file', 'store'] as const)('keeps %s stdio credentials in the recipient environment, outside argv, and refuses debug logging', async source => {
    const server = { name: 'fixture', type: 'stdio' as const, command: 'fixture-server', args: ['--fixture'],
      ...(source === 'literal' ? { env: { TOKEN: 'fixture-stdio-secret' } } : { envFrom: { TOKEN: source === 'env' ? 'FIXTURE_TOKEN' : source === 'file' ? `file:${privateFile('fixture-stdio-secret')}` : 'store:fixture' } }),
    };
    const environment = { FIXTURE_TOKEN: 'fixture-stdio-secret', UNRELATED_SECRET: 'fixture-unrelated-secret' };
    const readStore = async () => 'fixture-stdio-secret';
    await createDefaultMcpClient('fixture', { get: async () => server }, environment, { readStore });
    expect(captures.stdio.at(-1)).toMatchObject({ env: { TOKEN: 'fixture-stdio-secret' }, args: ['--fixture'], stderr: 'pipe' });
    expect(captures.stdio.at(-1)!.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(JSON.stringify(captures.stdio.at(-1)!.args)).not.toContain('fixture-stdio-secret');
    captures.debug = true;
    await expect(createDefaultMcpClient('fixture', { get: async () => server }, environment, { readStore })).rejects.toThrow('NODE_DEBUG child_process');
    expect(captures.stdio).toHaveLength(1);
  });

  it.each(['group', 'other', 'symlink', 'owner', 'hardlink'])('refuses a %s file without connecting or exposing content', async kind => {
    let file = privateFile('fixture-refused-secret');
    if (kind === 'group') chmodSync(file, 0o640);
    if (kind === 'other') chmodSync(file, 0o604);
    if (kind === 'symlink') { symlinkSync(file, `${file}.symlink`); file += '.symlink'; }
    if (kind === 'owner') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    if (kind === 'hardlink') linkSync(file, `${file}.hardlink`);
    const server = { name: 'fixture', type: 'http' as const, url: 'https://example.test/mcp', headerEnv: { Authorization: `file:${file}` } };
    const error = await createDefaultMcpClient('fixture', { get: async () => server }, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/group or other access|symlink|not owned|hard link/);
    expect(String(error)).not.toContain('fixture-refused-secret');
    expect(captures.connected).toHaveLength(0);
  });
});
