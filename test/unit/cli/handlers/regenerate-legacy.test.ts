// Guard the legacy handler's render/inject/write cycle against startup feedback.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerateHandler } from '../../../../src/cli/handlers/regenerate.js';
import { buildProviderBootstrapFile } from '../../../../src/smiths/context-pipeline/workspace-bootstrap.js';
import { writeNormalizedAiwgMd } from '../../../../src/smiths/context-pipeline/finalization.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-regenerate-legacy-'));
  await mkdir(join(root, '.aiwg'));
  await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({
    version: '1', providers: ['claude'], installed: {}, scripts: {},
  }));
  // Init's generated bootstrap and root context, without the UAT CLI harness.
  await writeFile(join(root, 'CLAUDE.md'), buildProviderBootstrapFile('claude'));
  await writeNormalizedAiwgMd(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(['--full-inject', '--legacy'])('%s stays byte-identical after an operator sentinel is appended', async flag => {
  const args = [flag, '--provider', 'claude'];
  const refresh = () => regenerateHandler.execute({
    args, rawArgs: ['regenerate', ...args], cwd: root, frameworkRoot: root,
  });
  // Optional framework notes must still be folded into the legacy payload.
  const notes = '# Operator framework notes\nKeep the local convention.\n';
  await writeFile(join(root, '.aiwg/AIWG.md'), notes);
  expect((await refresh()).exitCode).toBe(0);
  const startup = join(root, 'CLAUDE.md');
  const sentinel = 'Operator sentinel paragraph — preserve exactly once.';
  await writeFile(startup, `${await readFile(startup, 'utf8')}\n\n${sentinel}\n`);

  expect((await refresh()).exitCode).toBe(0);
  const first = await readFile(startup, 'utf8');
  const framework = await readFile(join(root, 'AIWG.md'), 'utf8');
  expect((await refresh()).exitCode).toBe(0);
  expect(await readFile(startup, 'utf8')).toBe(first);
  expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toBe(framework);
  expect(first.match(/<!-- BEGIN AIWG -->/g)).toHaveLength(1);
  expect(first.match(/<!-- END AIWG -->/g)).toHaveLength(1);
  expect(first.split(sentinel)).toHaveLength(2);
  expect(first).toContain(notes);
  expect(framework).toContain(notes);
  expect(framework).not.toContain('<!-- BEGIN AIWG -->');
  expect(framework).not.toContain(sentinel);
  expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(notes);
});
