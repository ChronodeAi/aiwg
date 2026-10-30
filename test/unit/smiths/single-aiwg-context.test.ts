// Regression coverage for the single generated AIWG context contract (#3762).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { buildNormalizedAiwgMd, writeNormalizedAiwgMd } from '../../../src/smiths/context-pipeline/finalization.js';
import { diagnoseWorkspaceContext, migrateWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-context.js';
import { ContextWriteJournal } from '../../../src/smiths/context-pipeline/context-file-safety.js';

describe('one generated AIWG context', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiwg-single-context-'));
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'], installed: {}, scripts: {} }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const refresh = (root: string) => generate({ projectPath: root, provider: 'codex', sections: [], detectExistingFiles: true });

  it('fresh generation contains the framework context without a notes copy or missing-source pointer', async () => {
    await refresh(root);
    const content = await readFile(join(root, 'AIWG.md'), 'utf8');
    expect(content).toContain('aiwg show rule skill-discovery');
    expect(content).not.toContain('CLAUDE.md was not found');
    expect(content).not.toContain('normalized project-local context entry point');
    await expect(readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await diagnoseWorkspaceContext(root)).filter(d => d.severity === 'error' || d.code === 'missing-link')).toEqual([]);
  });

  it.each(['', '# Local notes\n\nKeep the exact operator convention.\n'])('migrates old generated context and preserves notes: %j', async notes => {
    const legacy = '# AIWG.md\n<!-- aiwg-managed -->\n<!-- Normalized project-local AIWG context. Operator notes may live outside AIWG-managed blocks. -->\n\nThis file is the stable `.aiwg/AIWG.md` entry point for AIWG skills, rules, and generated provider context.\n\n'
      + '<!-- aiwg-context-finalization:START -->\nOld generated prose\n<!-- aiwg-context-finalization:END -->\n' + notes;
    await writeFile(join(root, '.aiwg/AIWG.md'), legacy);
    await refresh(root);
    const remaining = await readFile(join(root, '.aiwg/AIWG.md'), 'utf8');
    expect(remaining.trim()).toBe(notes.trim());
    const content = await readFile(join(root, 'AIWG.md'), 'utf8');
    if (notes) expect(content).toContain(notes.trim());
    expect(content).not.toContain('Old generated prose');
    await refresh(root);
    expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toBe(content);
    expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(remaining);
  });

  it('preserves unsigned notes byte for byte, including marker-like and unknown text', async () => {
    const notes = '# Team notes\r\n\r\nKeep whitespace.  \r\n<!-- AIWG:custom:start -->local<!-- AIWG:custom:end -->\r\n';
    await writeFile(join(root, '.aiwg/AIWG.md'), notes);
    await refresh(root);
    expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(notes);
    expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toContain('Keep whitespace.');
  });

  it('journals legacy notes migration so failed deployments can restore the exact original', async () => {
    const legacy = await buildNormalizedAiwgMd(root, '# Operator\nRetain this.\n');
    await writeFile(join(root, '.aiwg/AIWG.md'), legacy);
    const journal = new ContextWriteJournal();
    try {
      await refresh(root);
      expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).not.toContain('Context Finalization');
      expect(journal.rollback().conflicts).toEqual([]);
      expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(legacy);
    } finally { journal.dispose(); }
  });

  it('existing-project transaction previews without writing and folds notes into the root context', async () => {
    const legacy = await buildNormalizedAiwgMd(root, '# Operator\nTransactional note.\n');
    await writeFile(join(root, '.aiwg/AIWG.md'), legacy);
    await migrateWorkspaceContext(root, { dryRun: true, includeGeneratedContext: true });
    expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(legacy);
    await migrateWorkspaceContext(root, { apply: true, includeGeneratedContext: true });
    expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).not.toContain('Context Finalization');
    expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toContain('Transactional note.');
  });

  it('rejects linked notes before they can be copied into generated context', async () => {
    const outside = join(root, 'outside-notes.md');
    const content = '# Private fixture notes\nDo not fold linked input.\n';
    await writeFile(outside, content);
    await symlink(outside, join(root, '.aiwg/AIWG.md'));
    await expect(refresh(root)).rejects.toThrow('Refusing unsafe AIWG.md target');
    await expect(readFile(join(root, 'AIWG.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(outside, 'utf8')).toBe(content);
  });

  it('init preserves an operator-owned root context and its optional notes source', async () => {
    const rootNotes = '# Manual AIWG context\nKeep this operator file.\n';
    const legacy = await buildNormalizedAiwgMd(root, '# Local notes\nRetain notes source.\n');
    await writeFile(join(root, 'AIWG.md'), rootNotes);
    await writeFile(join(root, '.aiwg/AIWG.md'), legacy);
    await writeNormalizedAiwgMd(root);
    expect(await readFile(join(root, 'AIWG.md'), 'utf8')).toBe(rootNotes);
    expect(await readFile(join(root, '.aiwg/AIWG.md'), 'utf8')).toBe(legacy);
  });

  it('doctor reports a stale generated notes copy and regenerate repairs it', async () => {
    await refresh(root);
    await writeFile(join(root, '.aiwg/AIWG.md'), await buildNormalizedAiwgMd(root));
    expect(await diagnoseWorkspaceContext(root)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duplicate-generated-context' })]));
    await refresh(root);
    expect((await diagnoseWorkspaceContext(root)).some(d => d.code === 'duplicate-generated-context')).toBe(false);
  });
});
