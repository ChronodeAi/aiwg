// Index the canonical skill in a temporary runtime and exercise the public discover handler.
import { afterEach, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverHandler } from '../../../src/cli/handlers/subcommands.js';

let temporary: string | undefined;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

it('aiwg discover "find papers similar to the corpus" finds research-expand with an exact trigger', async () => {
  const relative = 'agentic/code/frameworks/research-complete/skills/research-expand/SKILL.md';
  const source = resolve(relative);
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-expand-discovery-'));
  const root = join(temporary, 'runtime');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) mkdirSync(join(root, 'agentic/code', kind), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"aiwg"}');
  mkdirSync(dirname(join(root, relative)), { recursive: true }); copyFileSync(source, join(root, relative));
  vi.stubEnv('XDG_DATA_HOME', join(temporary, 'xdg'));
  vi.stubEnv('AIWG_ROOT', root);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, '.aiwg'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const messages: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { messages.push(args.join(' ')); });
  await buildIndex(root, { graph: 'framework', force: true, explicit: true, quiet: true });
  messages.length = 0;
  const args = ['find papers similar to the corpus', '--json', '--backend', 'local', '--graph', 'framework', '--offline'];
  const result = await discoverHandler.execute({ args, rawArgs: ['discover', ...args], cwd: root, frameworkRoot: root });
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(messages.join('\n'));
  expect(data.results[0]).toMatchObject({ name: 'research-expand', type: 'skill' });
  expect(data.results[0].ranking.matches).toContainEqual(expect.objectContaining({ field: 'trigger', match: 'exact', value: args[0] }));
});
