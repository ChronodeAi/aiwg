/**
 * Regression test for #3635 finding 3: the first non-dry-run `aiwg use`
 * appends the AIWG runtime patterns to .gitignore (append-only, preserving
 * existing operator lines) instead of leaving doctor's gitignore warning.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIWG_RUNTIME_PATTERNS } from '../../../../src/config/gitignore.js';
import {
  ensureProviderGeneratedDirsIgnored,
  gitignorePatternsForDeploy,
} from '../../../../src/cli/handlers/use.js';

describe('first non-dry-run deploy ignores AIWG runtime dirs (#3635)', () => {
  it('appends runtime patterns and preserves existing .gitignore lines', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'aiwg-use-gitignore-'));
    try {
      await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n');
      expect(gitignorePatternsForDeploy('codex')).toEqual(
        expect.arrayContaining(AIWG_RUNTIME_PATTERNS),
      );

      await ensureProviderGeneratedDirsIgnored(projectRoot, 'codex', {
        dryRun: false,
        verbose: false,
      });

      const content = await readFile(join(projectRoot, '.gitignore'), 'utf8');
      expect(content).toContain('node_modules/\n');
      for (const pattern of AIWG_RUNTIME_PATTERNS) {
        expect(content).toContain(pattern);
      }

      // Append-only: a second deploy adds nothing further.
      await ensureProviderGeneratedDirsIgnored(projectRoot, 'codex', {
        dryRun: false,
        verbose: false,
      });
      const rerun = await readFile(join(projectRoot, '.gitignore'), 'utf8');
      expect(rerun).toBe(content);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates .gitignore when missing and leaves it alone on dry runs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'aiwg-use-gitignore-dry-'));
    try {
      await ensureProviderGeneratedDirsIgnored(projectRoot, 'codex', {
        dryRun: true,
        verbose: false,
      });
      await expect(readFile(join(projectRoot, '.gitignore'), 'utf8')).rejects.toThrow();

      await ensureProviderGeneratedDirsIgnored(projectRoot, 'codex', {
        dryRun: false,
        verbose: false,
      });
      const content = await readFile(join(projectRoot, '.gitignore'), 'utf8');
      for (const pattern of AIWG_RUNTIME_PATTERNS) {
        expect(content).toContain(pattern);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
