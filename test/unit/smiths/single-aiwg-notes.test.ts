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

const wrapper = '# AIWG.md\n<!-- aiwg-managed -->\n<!-- Normalized project-local AIWG context. Operator notes may live outside AIWG-managed blocks. -->\n\nThis file is the stable `.aiwg/AIWG.md` entry point for AIWG skills, rules, and generated provider context.\n\n';
async function foldSignedNotes(notes: string, header = wrapper): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'aiwg-signed-notes-'));
  await mkdir(join(root, '.aiwg'));
  await writeFile(join(root, '.aiwg/AIWG.md'), header + notes);
  await generate({ provider: 'codex', projectPath: root, sections: [], detectExistingFiles: true });
  expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(notes);
  expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toContain(notes);
  await generate({ provider: 'codex', projectPath: root, sections: [], detectExistingFiles: true });
  expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(notes);
  expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toContain(notes);
}

it.each(['```md', '~~~~md'])('preserves signed fenced marker examples (%s)', async fence => {
  const close = fence.replace('md', '');
  const notes = '# Operator examples\n\n' + fence + '\n<!-- aiwg-context-finalization:START -->\nKeep finalization example.\n<!-- aiwg-context-finalization:END -->\n<!-- aiwg-external-links:start -->\nKeep links example.\n<!-- aiwg-external-links:end -->\n' + close + '\n';
  const generated = '<!-- aiwg-context-finalization:START -->\nObsolete generated block.\n<!-- aiwg-context-finalization:END -->\n';
  await foldSignedNotes(notes, wrapper + generated);
  expect(await readFile(join(root, 'AIWG.md'), 'utf8')).not.toContain('Obsolete generated block.');
});

it('preserves wrapper quotations in signed operator prose even within twelve lines', async () => {
  const notes = '# Operator documentation\nThe old wrapper lines are shown below:\n' + wrapper;
  await foldSignedNotes(notes, '# AIWG.md\n<!-- aiwg-managed -->\n');
});

it('removes a BOM from the generated header without leaking the heading into notes', async () => {
  await foldSignedNotes('# Operator notes\nKeep the BOM fixture.\n', '\uFEFF' + wrapper);
});
