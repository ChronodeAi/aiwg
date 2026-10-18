import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let base: string, corpus: string, outside: string;
let server: any, client: Client;
const subpaths = { template: 'agentic/code/frameworks/sdlc-complete/templates/cat', prompt: 'agentic/code/addons/aiwg-utils/prompts/cat', agent: 'agentic/code/frameworks/sdlc-complete/agents' };
beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'aiwg-template-containment-'));
  corpus = join(base, 'corpus'); outside = join(base, 'corpus-outside');
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'sentinel.md'), 'outside bytes');
  for (const dir of Object.values(subpaths)) { await fs.mkdir(join(corpus, dir), { recursive: true }); await fs.writeFile(join(corpus, dir, 'ok.md'), 'inside {{value}}'); }
  await fs.mkdir(join(base, 'project/.aiwg'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(join(base, 'project'));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_MCP_TOOLSETS']) vi.stubEnv(key, '');
  vi.resetModules();
  vi.doMock('../../../src/mcp/helpers.mjs', async () => ({ ...await vi.importActual<any>('../../../src/mcp/helpers.mjs'), AIWG_ROOT: corpus }));
  const { createServer } = await import('../../../src/mcp/server.mjs'); server = await createServer();
  client = new Client({ name: 'template-regression', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
});
afterEach(async () => { await client?.close(); await server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('../../../src/mcp/helpers.mjs'); await fs.rm(base, { recursive: true, force: true }); });
async function sentinel() { const s = await fs.stat(join(outside, 'sentinel.md')); return { bytes: await fs.readFile(join(outside, 'sentinel.md'), 'utf8'), ino: s.ino, dev: s.dev, nlink: s.nlink, mode: s.mode }; }
function tool(name: string, template: string) { return client.callTool({ name, arguments: { template, variables: { value: 'rendered' } } }); }
function resource(kind: string, name: string, category = 'cat', framework = 'sdlc-complete') {
  // Invoke the real registered callback with raw variable values too; joining
  // first must not normalize away a malicious segment from any URI variable.
  return server._registeredResourceTemplates[kind].readCallback(new URL(`aiwg://${kind}s/test`), { name, category, framework });
}
describe('template tools and all dynamic resources', () => {
  it('preserves corpus-relative, framework-relative and basename template selection', async () => {
    await fs.writeFile(join(corpus, 'agentic/code/frameworks/sdlc-complete/templates/plain.md'), 'plain');
    for (const path of ['sdlc-complete/templates/cat/ok.md', 'sdlc-complete/cat/ok.md', 'cat/ok.md', 'plain.md', 'agentic/code/frameworks/sdlc-complete/templates/cat/ok.md']) {
      const result = await tool('template-show', path); expect(result.isError).toBeUndefined(); expect(JSON.stringify(result.content)).toMatch(/inside|plain/);
    }
    expect((await tool('template-render', 'sdlc/cat/ok.md')).content).toEqual([{ type: 'text', text: 'inside rendered' }]);
    for (const kind of Object.keys(subpaths)) expect((await resource(kind, 'ok')).contents[0].text).toBe('inside {{value}}');
    expect((await client.readResource({ uri: 'aiwg://templates/sdlc-complete/cat/ok' })).contents[0].text).toBe('inside {{value}}');
  });
  it.each(['template-show', 'template-render'])('%s refuses traversal, absolute and prefix sibling inputs', async name => {
    const before = await sentinel();
    for (const path of [join(outside, 'sentinel.md'), '../corpus-outside/sentinel.md', 'sdlc/../../../../../../corpus-outside/sentinel.md', 'C:sentinel', '..\\sentinel']) {
      expect((await tool(name, path)).isError).toBe(true); expect(await sentinel()).toEqual(before);
    }
  });
  it.each(Object.keys(subpaths))('%s refuses escaping/dangling symlinks and multiply-linked files', async kind => {
    await fs.symlink(join(outside, 'sentinel.md'), join(corpus, subpaths[kind], 'escape.md'));
    await fs.symlink(join(outside, 'absent.md'), join(corpus, subpaths[kind], 'dangling.md'));
    await fs.link(join(outside, 'sentinel.md'), join(corpus, subpaths[kind], 'linked.md'));
    const before = await sentinel();
    for (const name of ['escape', 'dangling', 'linked']) {
      expect((await resource(kind, name)).contents[0].text).toMatch(/not found/);
      if (kind === 'template') for (const toolName of ['template-show', 'template-render']) expect((await tool(toolName, `sdlc-complete/cat/${name}.md`)).isError).toBe(true);
      expect(await sentinel()).toEqual(before);
    }
  });
  it.each(Object.keys(subpaths))('%s validates each dynamic variable before joining', async kind => {
    const before = await sentinel();
    const cases = [['../../../../../../corpus-outside/sentinel', 'cat', 'sdlc-complete']];
    if (kind !== 'agent') cases.push(['sentinel', '../../../../../../corpus-outside', 'sdlc-complete']);
    if (kind !== 'prompt') cases.push(['ok', 'cat', '../sdlc-complete']);
    for (const values of cases) {
      expect((await resource(kind, ...values as [string, string, string])).contents[0].text).toMatch(/not found/);
      expect(await sentinel()).toEqual(before);
    }
  });
  it('template listing omits symlinks/hardlinks and refuses retargeted corpus identity', async () => {
    await fs.symlink(outside, join(corpus, subpaths.template, 'escape'), 'dir');
    await fs.link(join(outside, 'sentinel.md'), join(corpus, subpaths.template, 'linked.md'));
    const before = await sentinel();
    const result = await client.callTool({ name: 'template-list', arguments: {} });
    expect(JSON.stringify(result.content)).not.toMatch(/linked|escape|sentinel/);
    await fs.rename(corpus, join(base, 'held')); await fs.mkdir(corpus);
    await fs.mkdir(join(corpus, subpaths.template), { recursive: true }); await fs.writeFile(join(corpus, subpaths.template, 'ok.md'), 'replaced root');
    expect((await tool('template-show', 'cat/ok.md')).isError).toBe(true);
    expect((await tool('template-render', 'sdlc/cat/ok.md')).isError).toBe(true);
    for (const kind of Object.keys(subpaths)) expect((await resource(kind, 'ok')).contents[0].text).toMatch(/not found/);
    expect(await sentinel()).toEqual(before);
  });
});
