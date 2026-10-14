import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { initStorage, resetStorage } from '../../../src/storage/index.js';
import { runSubsystemCli } from '../../../src/storage/subsystem-cli.js';

// Replace only the CLI transport. Registered opt-in tools still dispatch their
// real argv through the real subsystem CLI/config/registry/filesystem backend.
vi.mock('../../../src/mcp/helpers.mjs', async importOriginal => ({
  ...await importOriginal<any>(),
  runAiwgCli: async (args: string[], { input }: { input?: string } = {}) => {
    let stdout = '';
    const log = vi.spyOn(console, 'log').mockImplementation((value) => { stdout += String(value); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((value: any) => { stdout += String(value); return true; });
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([input ?? '']) as any);
    try {
      const subsystem = args[0] === 'research-store' ? 'research' : args[0];
      await runSubsystemCli(subsystem as any, args.slice(1));
      return { stdout, stderr: '', code: 0 };
    } catch (e) { return { stdout, stderr: String(e), code: 1 }; }
    finally { log.mockRestore(); write.mockRestore(); stdin.mockRestore(); }
  },
}));
import { registerOptInToolsets } from '../../../src/mcp/tools/subsystems.mjs';
let base: string, project: string, external: string, outside: string;
let tools: Map<string, (args: any) => Promise<any>>;
beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'aiwg-optin-storage-')); project = join(base, 'project'); external = join(base, 'external'); outside = join(base, 'outside');
  await fs.mkdir(join(project, '.aiwg'), { recursive: true }); await fs.mkdir(external); await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'sentinel'), 'outside bytes');
  await fs.writeFile(join(project, '.aiwg/storage.config'), JSON.stringify({ version: '1', roots: { memory: external, reflections: external, kb: external, provenance: external, research: external } }));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  resetStorage(); await initStorage(project);
  tools = new Map();
  await registerOptInToolsets({ registerTool: (name: string, _config: any, cb: any) => tools.set(name, cb) }, new Set(['memory', 'kb', 'research']));
});
afterEach(async () => { resetStorage(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(base, { recursive: true, force: true }); });
it.each(['memory', 'reflections', 'kb', 'provenance', 'research-store'])('%s opt-in tools reach containment via configured external fs storage', async subsystem => {
  const call = (op: string, args: any) => tools.get(`${subsystem}-${op}`)!(args);
  expect((await call('put', { path: 'nested/file', content: 'inside' })).isError).toBeUndefined();
  expect((await call('get', { path: 'nested/file' })).isError).toBeUndefined();
  await fs.symlink(outside, join(external, 'escape'), 'dir');
  await fs.link(join(outside, 'sentinel'), join(external, 'linked'));
  const s = await fs.stat(join(outside, 'sentinel'));
  for (const path of ['escape/sentinel', 'linked', '../outside/sentinel']) for (const op of ['get', 'put', 'delete']) {
    expect((await call(op, { path, content: 'changed' })).isError).toBe(true);
    expect(await fs.readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside bytes');
    const after = await fs.stat(join(outside, 'sentinel'));
    expect({ ino: after.ino, dev: after.dev, nlink: after.nlink, mode: after.mode }).toEqual({ ino: s.ino, dev: s.dev, nlink: s.nlink, mode: s.mode });
  }
  expect(JSON.stringify((await call('list', {})).content)).not.toMatch(/linked|escape|sentinel/);
});
