import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const captures = vi.hoisted(() => ({
  connected: [] as unknown[],
  http: [] as Array<{ url: URL; options: Record<string, unknown> }>,
  sse: [] as Array<{ url: URL; options: Record<string, unknown> }>,
  stdio: [] as Array<Record<string, unknown>>,
  error: undefined as string | undefined,
  reply: undefined as unknown,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(transport: unknown) {
      captures.connected.push(transport);
      if (captures.error) throw new Error(captures.error);
    }
    async callTool() {
      return captures.reply ?? { structuredContent: { not_found: true } };
    }
    async close() {}
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
beforeEach(() => { captures.error = undefined; captures.reply = undefined; });
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
