// Preserve literal generated-marker examples when folding operator-only notes.
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('folds unsigned marker examples after generated block replacement', async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-note-markers-'));
  await mkdir(join(root, '.aiwg'));
  const notes = '# Team notes\n\n```md\n<!-- aiwg-context-finalization:START -->\nKeep this literal example.\n<!-- aiwg-context-finalization:END -->\n```\n';
  await writeFile(join(root, '.aiwg/AIWG.md'), notes);
  await generate({ provider: 'codex', projectPath: root, sections: [], detectExistingFiles: true });
  expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(notes);
  expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toContain(notes);
});
