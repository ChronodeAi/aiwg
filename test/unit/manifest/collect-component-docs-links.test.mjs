/**
 * Relative-link rewriting in docs collection.
 *
 * `docs:collect` copies addon/framework docs from `agentic/code/**\/docs/` into
 * `docs/<kind>/<name>/`. A link that is correct at source resolves to nothing
 * after the copy, and the docsite build enforces strictLinks — so collecting
 * turned a green build red.
 *
 * @issue #2519
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rewriteRelativeLinks,
  buildCollectedMap,
  isNonRelativeTarget,
} from '../../../tools/manifest/collect-component-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The two real components the issue reported, wired as the collector would. */
const COMPONENTS = [
  {
    kind: 'addons',
    name: 'voice-framework',
    docsDir: path.join(ROOT, 'agentic/code/addons/voice-framework/docs'),
    files: [{ relPath: 'writing-workflows.md' }, { relPath: 'quickstart.md' }],
  },
  {
    kind: 'addons',
    name: 'testing-quality',
    docsDir: path.join(ROOT, 'agentic/code/addons/testing-quality/docs'),
    files: [{ relPath: 'conformance-workflow.md' }],
  },
];

const collectedMap = buildCollectedMap(COMPONENTS);
const collectedDests = new Set(collectedMap.values());

/** Run the rewriter for one collected file, with caller-supplied content. */
function collect(component, relPath, content) {
  const src = path.join(component.docsDir, relPath);
  const dest = path.join(ROOT, 'docs', component.kind, component.name, relPath);
  return { dest, ...rewriteRelativeLinks(content, src, dest, collectedMap, collectedDests) };
}

/** Resolve a markdown link target from the collected file's location. */
function resolvesFromDest(dest, target) {
  const pathPart = target.split('#')[0].split('?')[0];
  return fs.existsSync(path.resolve(path.dirname(dest), decodeURI(pathPart)));
}

const [voice, testingQuality] = COMPONENTS;

describe('docs:collect relative link rewriting (#2519)', () => {
  it('re-expresses a repo-root link for the shallower collected location', () => {
    // Failure shape 2: five levels up from the addon's docs dir is the repo
    // root; from docs/addons/voice-framework/ the same five levels leave the
    // tree entirely. The targets are reachable as ../../voice/<name>.md.
    const content = [
      'Prepare a brief using [the schema](../../../../../docs/voice/writing-briefs.md).',
      'See [channels](../../../../../docs/voice/channels.md).',
    ].join('\n');
    const result = collect(voice, 'writing-workflows.md', content);

    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain('(../../voice/writing-briefs.md)');
    expect(result.content).toContain('(../../voice/channels.md)');
    for (const target of ['../../voice/writing-briefs.md', '../../voice/channels.md']) {
      expect(resolvesFromDest(result.dest, target), target).toBe(true);
    }
  });

  it('points a sibling directory that is not collected at the canonical source', () => {
    // Failure shape 1: ../templates/ resolves at source but docs:collect copies
    // only the addon's docs/ subtree, so the target is never published. The
    // reader still needs to reach the file.
    const content = 'Review using [protocol review](../templates/protocol-review.md).';
    const result = collect(testingQuality, 'conformance-workflow.md', content);

    expect(result.unresolved).toEqual([]);
    expect(result.sourceLinks).toEqual(['../templates/protocol-review.md']);
    expect(result.content).toContain(
      '(https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/testing-quality/templates/protocol-review.md)',
    );
  });

  it('rewrites a link whose text wraps across lines', () => {
    // A line-by-line rewriter silently misses these, leaving one broken link
    // in an otherwise-rewritten file.
    const content = 'Consult the [adapter\nqualification](../templates/adapter-qualification.md) matrix.';
    const result = collect(testingQuality, 'conformance-workflow.md', content);

    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain(
      'templates/adapter-qualification.md)',
    );
    expect(result.content).toContain('https://github.com/jmagly/aiwg/blob/main/');
  });

  it('leaves a link already authored against the collected layout alone', () => {
    // ../../getting-started/ is wrong at source and right after the copy.
    // "Fixing" it would break a link that already works.
    const content = 'Start with [install](../../getting-started/install-connect-verify.md).';
    const result = collect(voice, 'quickstart.md', content);

    expect(result.unresolved).toEqual([]);
    expect(result.content).toBe(content);
    expect(resolvesFromDest(result.dest, '../../getting-started/install-connect-verify.md')).toBe(true);
  });

  it('leaves a link between two collected docs untouched', () => {
    // Both files move together, so the link is already correct. Re-encoding it
    // would be diff noise across every collected file.
    const content = 'See [the workflow](./writing-workflows.md) and [it again](writing-workflows.md).';
    const result = collect(voice, 'quickstart.md', content);
    expect(result.unresolved).toEqual([]);
    expect(result.content).toBe(content);
    expect(resolvesFromDest(result.dest, 'writing-workflows.md')).toBe(true);
  });

  it('preserves fragments and rewrites reference definitions', () => {
    const content = [
      'See [briefs][b] and [anchored](../../../../../docs/voice/channels.md#telegram).',
      '',
      '[b]: ../../../../../docs/voice/writing-briefs.md',
    ].join('\n');
    const result = collect(voice, 'writing-workflows.md', content);

    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain('(../../voice/channels.md#telegram)');
    expect(result.content).toContain('[b]: ../../voice/writing-briefs.md');
  });

  it('keeps fenced blocks masked after an earlier pass shifts offsets', () => {
    // The reference-definition pass rewrites targets and changes the document's
    // length. Fence ranges measured before it would be stale for the inline
    // pass, misclassifying a link near a fence in either direction.
    const content = [
      '[ref]: ../../../../../docs/voice/writing-briefs.md',
      '',
      '```markdown',
      'Sample: [schema](../../../../../docs/voice/channels.md)',
      '```',
      '',
      'Real: [revision](../../../../../docs/voice/revision.md)',
    ].join('\n');
    const result = collect(voice, 'writing-workflows.md', content);

    expect(result.content).toContain('[ref]: ../../voice/writing-briefs.md');
    // Still fenced, despite the ref-def line above it getting shorter.
    expect(result.content).toContain('Sample: [schema](../../../../../docs/voice/channels.md)');
    expect(result.content).toContain('Real: [revision](../../voice/revision.md)');
  });

  it('does not touch links inside fenced code blocks', () => {
    const content = [
      'Real: [schema](../../../../../docs/voice/writing-briefs.md)',
      '',
      '```markdown',
      'Sample: [schema](../../../../../docs/voice/writing-briefs.md)',
      '```',
      '',
      '~~~',
      'Tilde: [schema](../templates/protocol-review.md)',
      '~~~',
    ].join('\n');
    const result = collect(voice, 'writing-workflows.md', content);

    expect(result.content).toContain('Real: [schema](../../voice/writing-briefs.md)');
    expect(result.content).toContain('Sample: [schema](../../../../../docs/voice/writing-briefs.md)');
    expect(result.content).toContain('Tilde: [schema](../templates/protocol-review.md)');
  });

  it('reports a link that resolves nowhere instead of inventing a target', () => {
    const content = 'Broken: [gone](./does-not-exist-anywhere.md)';
    const result = collect(voice, 'writing-workflows.md', content);

    expect(result.unresolved).toEqual([
      { target: './does-not-exist-anywhere.md', reason: 'unresolved-at-source' },
    ]);
    // Left untouched — the tool has no destination to rewrite it to.
    expect(result.content).toBe(content);
  });

  it('leaves absolute, external, and anchor-only targets untouched', () => {
    for (const target of ['https://example.com/x.md', '/site-absolute.md', '#section', 'mailto:a@b.c']) {
      expect(isNonRelativeTarget(target), target).toBe(true);
    }
    const content = [
      '[ext](https://example.com/a.md)',
      '[abs](/guide.md)',
      '[anchor](#heading)',
      '![img](https://example.com/i.png)',
    ].join('\n');
    const result = collect(voice, 'writing-workflows.md', content);
    expect(result.content).toBe(content);
    expect(result.unresolved).toEqual([]);
  });
});
