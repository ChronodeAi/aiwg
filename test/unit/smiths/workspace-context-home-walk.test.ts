/**
 * Regression tests for #277: the workspace context graph walk recursed into
 * caches, package registries, and virtualenvs when the project root is
 * $HOME (or otherwise looks un-project-like), producing hundreds of false
 * duplicate-directive findings and very slow `aiwg doctor` runs.
 *
 * This file isolates the `$HOME`-detection scenario from
 * workspace-context.test.ts because it mocks `node:os#homedir` for the
 * whole module graph.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-workspace-context-home-'));
  roots.push(root);
  await mkdir(join(root, '.aiwg'), { recursive: true });
  return root;
}
afterEach(async () => {
  vi.doUnmock('node:os');
  vi.resetModules();
  delete process.env.AIWG_CONTEXT_WALK_MAX_DEPTH;
  delete process.env.AIWG_CONTEXT_WALK_MAX_DIRECTORIES;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace context graph: $HOME walk bound (#277)', () => {
  it('limits the nested-instruction-file walk to depth 1 when the project root is $HOME', async () => {
    const root = await project();
    // A deeply nested AGENTS.md that only a recursive walk below depth 1
    // would find. Real-world equivalent: .cache/uv/.../AGENTS.md-shaped noise.
    await mkdir(join(root, 'repos', 'some-project'), { recursive: true });
    await writeFile(join(root, 'repos', 'some-project', 'AGENTS.md'), 'Nested project instructions.\n');
    // A top-level (depth 1) file is still found.
    await writeFile(join(root, 'AGENTS.md'), 'Root instructions.\n');

    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => root };
    });
    vi.resetModules();

    const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
    const audit = await auditWorkspaceContext(root);

    expect(audit.sources.some((source) => source.path === 'AGENTS.md')).toBe(true);
    expect(audit.sources.some((source) => source.path === 'repos/some-project/AGENTS.md')).toBe(false);
    expect(audit.plan.nestedSources).not.toContain('repos/some-project/AGENTS.md');
    expect(audit.contextWalkTruncated).toBe(true);
  });

  it('reports the truncation as an info diagnostic, not an error', async () => {
    const root = await project();
    await mkdir(join(root, 'repos', 'some-project'), { recursive: true });
    await writeFile(join(root, 'repos', 'some-project', 'AGENTS.md'), 'Nested project instructions.\n');

    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => root };
    });
    vi.resetModules();

    const { diagnoseWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
    const diagnostics = await diagnoseWorkspaceContext(root);
    const truncation = diagnostics.find((item) => item.code === 'context-walk-truncated');
    expect(truncation).toBeTruthy();
    expect(truncation?.severity).toBe('info');
  });

  it('does not limit to depth 1 for a normal project root (not $HOME)', async () => {
    const root = await project();
    await mkdir(join(root, 'packages', 'one'), { recursive: true });
    await writeFile(join(root, 'packages', 'one', 'AGENTS.md'), 'Package instructions.\n');

    // homedir() mocked to something else entirely — root is not $HOME.
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => '/not/this/root' };
    });
    vi.resetModules();

    const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
    const audit = await auditWorkspaceContext(root);
    expect(audit.plan.nestedSources).toContain('packages/one/AGENTS.md');
    expect(audit.contextWalkTruncated).toBe(false);
  });

  // #277 fix-round — exercise both numeric bounds directly with small
  // injected limits instead of building a 20,000-directory fixture tree.
  // Root here is NOT $HOME (mocked to somewhere else) so the full bounded
  // walk (not the home depth-1 restriction) is what is under test.
  describe('numeric bounds (small injected limits)', () => {
    it('depth bound: AIWG_CONTEXT_WALK_MAX_DEPTH stops descent past the injected depth and reports truncated', async () => {
      const root = await project();
      // depth 1 = root, 2 = packages, 3 = one -> AGENTS.md lives at depth 3
      // (one level past an injected max depth of 2).
      await mkdir(join(root, 'packages', 'one'), { recursive: true });
      await writeFile(join(root, 'packages', 'one', 'AGENTS.md'), 'Too deep to find.\n');
      await mkdir(join(root, 'packages'), { recursive: true });
      await writeFile(join(root, 'packages', 'AGENTS.md'), 'At the injected depth boundary.\n');

      process.env.AIWG_CONTEXT_WALK_MAX_DEPTH = '2';
      vi.doMock('node:os', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:os')>();
        return { ...actual, homedir: () => '/not/this/root' };
      });
      vi.resetModules();

      const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
      const audit = await auditWorkspaceContext(root);
      expect(audit.plan.nestedSources).toContain('packages/AGENTS.md');
      expect(audit.plan.nestedSources).not.toContain('packages/one/AGENTS.md');
      expect(audit.contextWalkTruncated).toBe(true);
    });

    it('directory-count bound: AIWG_CONTEXT_WALK_MAX_DIRECTORIES stops the walk after the injected count and reports truncated', async () => {
      const root = await project();
      // Five sibling subdirectories, each with its own AGENTS.md. With a
      // directory budget of 3 (root + 2 children), not every sibling's file
      // can be reached — regardless of filesystem readdir ordering.
      for (let i = 0; i < 5; i += 1) {
        await mkdir(join(root, `sibling-${i}`), { recursive: true });
        await writeFile(join(root, `sibling-${i}`, 'AGENTS.md'), `Sibling ${i} instructions.\n`);
      }

      process.env.AIWG_CONTEXT_WALK_MAX_DIRECTORIES = '3';
      vi.doMock('node:os', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:os')>();
        return { ...actual, homedir: () => '/not/this/root' };
      });
      vi.resetModules();

      const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
      const audit = await auditWorkspaceContext(root);
      expect(audit.plan.nestedSources.length).toBeLessThan(5);
      expect(audit.contextWalkTruncated).toBe(true);
    });

    it('with limits restored to defaults, all five siblings are found and nothing is truncated', async () => {
      const root = await project();
      for (let i = 0; i < 5; i += 1) {
        await mkdir(join(root, `sibling-${i}`), { recursive: true });
        await writeFile(join(root, `sibling-${i}`, 'AGENTS.md'), `Sibling ${i} instructions.\n`);
      }

      vi.doMock('node:os', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:os')>();
        return { ...actual, homedir: () => '/not/this/root' };
      });
      vi.resetModules();

      const { auditWorkspaceContext } = await import('../../../src/smiths/context-pipeline/workspace-context.js');
      const audit = await auditWorkspaceContext(root);
      expect(audit.plan.nestedSources.length).toBe(5);
      expect(audit.contextWalkTruncated).toBe(false);
    });
  });
});
