/**
 * Lint Runner Tests
 *
 * Tests for the core lint execution engine — check logic,
 * file matching, and diagnostic collection.
 *
 * @source @src/lint/runner.ts
 * @issue #810
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runLint, autoDetectRulesets } from '../../../src/lint/runner.js';
import type { LintRule, LintRuleset } from '../../../src/lint/types.js';

const TEST_DIR = join(tmpdir(), `aiwg-lint-runner-test-${Date.now()}`);

function makeRuleset(rules: LintRule[]): LintRuleset {
  return {
    id: 'test',
    name: 'Test Ruleset',
    description: 'Test',
    framework: 'test-framework',
    version: '1.0.0',
    rules,
  };
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, 'findings'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('frontmatter-required check', () => {
  it('reports missing required fields', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-001.md'), `---
title: Test Paper
---
# Content
`);

    const ruleset = makeRuleset([{
      id: 'test/fm-required',
      name: 'FM Required',
      description: 'Test',
      severity: 'error',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-required',
        fields: ['title', 'authors', 'year'],
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);

    expect(result.summary.filesChecked).toBeGreaterThan(0);
    // title is present, authors and year are missing
    const fmDiags = result.diagnostics.filter(d => d.ruleId === 'test/fm-required');
    expect(fmDiags.length).toBe(2);
    expect(fmDiags.some(d => d.message.includes('authors'))).toBe(true);
    expect(fmDiags.some(d => d.message.includes('year'))).toBe(true);
  });

  it('passes when all fields are present', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-002.md'), `---
title: Complete Paper
authors: Smith, J.
year: 2024
---
# Content
`);

    const ruleset = makeRuleset([{
      id: 'test/fm-complete',
      name: 'FM Complete',
      description: 'Test',
      severity: 'error',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-required',
        fields: ['title', 'authors', 'year'],
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);
    const diags = result.diagnostics.filter(d => d.ruleId === 'test/fm-complete');
    expect(diags).toHaveLength(0);
  });
});

describe('frontmatter-format check', () => {
  it('reports field values that do not match pattern', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-003.md'), `---
title: Paper
status: invalid-status
---
# Content
`);

    const ruleset = makeRuleset([{
      id: 'test/fm-format',
      name: 'FM Format',
      description: 'Test',
      severity: 'warn',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-format',
        field: 'status',
        pattern: '^(pending|documented|integrated)$',
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);
    const diags = result.diagnostics.filter(d => d.ruleId === 'test/fm-format');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('invalid-status');
  });

  it('passes when field value matches pattern', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-004.md'), `---
title: Paper
status: documented
---
# Content
`);

    const ruleset = makeRuleset([{
      id: 'test/fm-format-ok',
      name: 'FM Format OK',
      description: 'Test',
      severity: 'warn',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-format',
        field: 'status',
        pattern: '^(pending|documented|integrated)$',
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);
    const diags = result.diagnostics.filter(d => d.ruleId === 'test/fm-format-ok');
    expect(diags).toHaveLength(0);
  });
});

describe('id-unique check', () => {
  it('detects duplicate identifiers across flat files', async () => {
    // Create two sets of files — REF-010 appears in two directories,
    // both matching the glob via the ** pattern
    writeFileSync(join(TEST_DIR, 'findings', 'REF-010.md'), `---
title: First
---
`);

    // Create another file with the same REF ID but different name
    // to test the id-unique basename check
    mkdirSync(join(TEST_DIR, 'other'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'other', 'REF-010.md'), `---
title: Duplicate
---
`);

    // Use a broad glob that matches both directories
    const ruleset = makeRuleset([{
      id: 'test/id-unique',
      name: 'ID Unique',
      description: 'Test',
      severity: 'error',
      appliesTo: { glob: '**/REF-*.md' },
      checks: [{ type: 'id-unique' }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);
    const diags = result.diagnostics.filter(d => d.ruleId === 'test/id-unique');
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain('Duplicate');
  });
});

describe('id-format check', () => {
  it('reports files with non-conforming names', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-001-extra-slug.md'), `---
title: Slugged
---
`);

    const ruleset = makeRuleset([{
      id: 'test/id-format',
      name: 'ID Format',
      description: 'Test',
      severity: 'warn',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'id-format',
        pattern: '^REF-\\d{3}$',
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset]);
    const diags = result.diagnostics.filter(d => d.ruleId === 'test/id-format');
    const slugDiag = diags.find(d => d.file.includes('REF-001-extra-slug'));
    expect(slugDiag).toBeDefined();
    expect(slugDiag!.message).toContain('does not match');
  });
});

describe('reference-resolves check', () => {
  function referenceRuleset(): LintRuleset {
    return makeRuleset([{
      id: 'test/citation-resolves',
      name: 'Citation Resolves',
      description: 'Test',
      severity: 'error',
      appliesTo: { glob: '**/*.md' },
      checks: [{ type: 'reference-resolves' }],
    }]);
  }

  it('resolves canonical slugged reference filenames', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-089-recursive-language-models.md'), '# Paper\n');
    writeFileSync(join(TEST_DIR, 'findings', 'REF-090-synthesis.md'), 'See REF-089.\n');

    const result = await runLint(TEST_DIR, [referenceRuleset()]);

    expect(result.diagnostics).toHaveLength(0);
  });

  it('matches and resolves complete four-digit reference IDs', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-1713-research-paper.md'), '# Paper\n');
    writeFileSync(join(TEST_DIR, 'findings', 'REF-1714-synthesis.md'), 'See REF-1713.\n');

    const result = await runLint(TEST_DIR, [referenceRuleset()]);

    expect(result.diagnostics).toHaveLength(0);
  });

  it('resolves references in non-findings layouts', async () => {
    const referencesDir = join(TEST_DIR, 'documentation', 'references');
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(join(referencesDir, 'REF-1000-grammar-specification.md'), '# Paper\n');
    writeFileSync(join(referencesDir, 'REF-1001-parser.md'), 'Builds on REF-1000.\n');

    const result = await runLint(TEST_DIR, [referenceRuleset()]);

    expect(result.diagnostics).toHaveLength(0);
  });

  it('still reports a complete unresolved four-digit reference ID', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-1001-synthesis.md'), 'Missing REF-1713.\n');

    const result = await runLint(TEST_DIR, [referenceRuleset()]);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Reference 'REF-1713'");
  });

  it('does not treat citation or radar sidecars as reference documents', async () => {
    const citationsDir = join(TEST_DIR, 'documentation', 'citations');
    const radarDir = join(TEST_DIR, 'documentation', 'radar');
    mkdirSync(citationsDir, { recursive: true });
    mkdirSync(radarDir, { recursive: true });
    writeFileSync(join(citationsDir, 'REF-1713-citations.md'), '# Citation sidecar\n');
    writeFileSync(join(radarDir, 'REF-1713-radar.md'), '# Radar sidecar\n');
    writeFileSync(join(TEST_DIR, 'findings', 'REF-1001-synthesis.md'), 'Missing REF-1713.\n');

    const result = await runLint(TEST_DIR, [referenceRuleset()]);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Reference 'REF-1713'");
  });
});

describe('unregistered-uncertainty check (#2523)', () => {
  // Every string below is real prose from a 2,544-reference corpus. The point of
  // the check is to separate "the agent skipped a cheap check" from "the paper's
  // own claim is unverified" — flagging the second would discourage exactly the
  // honest limitation sections #2523 says to keep.
  const rule: LintRule = {
    id: 'test/uncertainty',
    name: 'Uncertainty must name an obstacle',
    description: 'test',
    severity: 'warn',
    appliesTo: { glob: 'findings/REF-*.md' },
    checks: [{ type: 'unregistered-uncertainty' }],
  } as unknown as LintRule;

  async function lint(body: string) {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-001.md'), body);
    const res = await runLint(TEST_DIR, [makeRuleset([rule])], { recursive: true });
    return res.diagnostics.filter((d) => d.ruleId === 'test/uncertainty');
  }

  it('flags a skipped cheap check stated without an obstacle', async () => {
    const ds = await lint([
      '# REF-001',
      '',
      '6. **Acceptance not independently verified.** Recorded here from the arXiv comment',
      'and the LaTeX template; no OpenReview or proceedings query was run (radar §4, §7).',
      '',
      '- The ACL Anthology camera-ready (`2025.findings-acl.1310`) was not retrieved.',
      '',
      'Incoming scholarly citation count unknown, not zero — no citation census performed.',
      '',
    ].join('\n'));
    expect(ds.length).toBe(3);
    expect(ds.map((d) => d.message).join(' ')).toMatch(/OpenReview/);
    expect(ds.every((d) => typeof d.line === 'number')).toBe(true);
    expect(ds[0].fix).toMatch(/name the specific obstacle/);
  });

  it('accepts the same uncertainty once an obstacle is named', async () => {
    const ds = await lint([
      '# REF-001',
      '',
      'Citations are deferred: the eprint PDF is Cloudflare-gated (HTTP 403) and was not retrieved.',
      '',
      '> **ACQUISITION DEFICIT**: PDF acquisition not attempted (green OA per OpenAlex but',
      'the PMC link returns proof-of-work).',
      '',
      '- **Limitations**: OpenReview API/PDF endpoints returned challenge artifacts.',
      '',
      'Venue confirmed: OpenReview queried 2026-09-12; accepted as ICLR 2024 poster.',
      '',
    ].join('\n'));
    expect(ds).toEqual([]);
  });

  it("leaves the paper's own unverified claims alone", async () => {
    // None of these is a check the agent could have run. Flagging them would
    // push agents to stop writing accurate limitations about the source.
    const ds = await lint([
      '# REF-001',
      '',
      '- Evaluated only up to 7B parameters; scaling behavior above 7B is unverified',
      '- Transferability to mixture-of-experts architectures is unverified',
      '- Potential solutions discussed but not validated: alternative SAE architectures',
      '| H3 | Humans outperform o3 | **Confirmed** (29% vs 5%) | Not confirmed (34% vs 51%) |',
      '- Unconfirmed predictions underlined to signal uncertainty',
      '- **Method**: Black-box (no access to LLM internals required). Easy to implement.',
      '',
    ].join('\n'));
    expect(ds).toEqual([]);
  });

  it('scopes matching to a clause, not a whole line', async () => {
    // Corpus changelog rows and long GRADE paragraphs sit on one line. Line-scoped
    // matching related an unperformed action to an unrelated target far away.
    const ds = await lint([
      '# REF-001',
      '',
      '| 2026-07-03 | claude-opus-4-8 | Induction: PDF archived (sha256 17ba0e96), 15-section analysis + sidecars; edges wired: OUT→REF-033. Conceptual lineage unconfirmed for two candidates. |',
      '',
    ].join('\n'));
    expect(ds).toEqual([]);
  });

  it('does not treat a scope declaration as a skipped check', async () => {
    const ds = await lint([
      '# REF-001',
      '',
      'No complete external incoming-citation census is asserted.',
      'Incoming citation coverage is limited to verified in-corpus REF-002; no exhaustive citation census is claimed.',
      '',
    ].join('\n'));
    expect(ds).toEqual([]);
  });

  it('honours custom pattern sets, and the obstacle window is bounded', async () => {
    const custom: LintRule = {
      ...rule,
      checks: [{
        type: 'unregistered-uncertainty',
        uncertaintyPatterns: ['was not sniffed'],
        verificationTargets: ['widget'],
        obstaclePatterns: ['teapot'],
      }],
    } as unknown as LintRule;
    writeFileSync(join(TEST_DIR, 'findings', 'REF-002.md'), [
      'the widget was not sniffed',
      '',
      '',
      '',
      'the other widget was not sniffed because the server is a teapot',
      '',
    ].join('\n'));
    const res = await runLint(TEST_DIR, [makeRuleset([custom])], { recursive: true });
    const ds = res.diagnostics.filter((d) => d.ruleId === 'test/uncertainty');
    expect(ds.length).toBe(1);
    // Only the first is flagged: the second names its obstacle. The blank lines
    // matter — obstacleWithinLines defaults to 2, so an obstacle sitting right
    // below an unrelated statement would discharge it too.
    expect(ds[0].message).toMatch(/the widget was not sniffed/);
    expect(ds[0].line).toBe(1);
  });
});

describe('summary and pass/fail', () => {
  it('reports passed when no errors', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-050.md'), `---
title: Clean
authors: Test
---
`);

    const ruleset = makeRuleset([{
      id: 'test/clean',
      name: 'Clean Check',
      description: 'Test',
      severity: 'info',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-required',
        fields: ['title'],
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset], { failOn: 'error' });
    expect(result.summary.passed).toBe(true);
  });

  it('reports failed when errors exceed failOn threshold', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-051.md'), `---
---
# No title
`);

    const ruleset = makeRuleset([{
      id: 'test/fail',
      name: 'Fail Check',
      description: 'Test',
      severity: 'error',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-required',
        fields: ['title'],
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset], { failOn: 'error' });
    expect(result.summary.passed).toBe(false);
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('fails on warnings when failOn is warn', async () => {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-052.md'), `---
title: Has Title
status: bad
---
`);

    const ruleset = makeRuleset([{
      id: 'test/warn-fail',
      name: 'Warn Fail',
      description: 'Test',
      severity: 'warn',
      appliesTo: { glob: 'findings/REF-*.md' },
      checks: [{
        type: 'frontmatter-format',
        field: 'status',
        pattern: '^(open|closed)$',
      }],
    }]);

    const result = await runLint(TEST_DIR, [ruleset], { failOn: 'warn' });
    expect(result.summary.passed).toBe(false);
    expect(result.summary.warnings).toBeGreaterThan(0);
  });
});

describe('autoDetectRulesets', () => {
  const researchRuleset: LintRuleset = {
    id: 'research',
    name: 'Research',
    description: '',
    framework: 'research-complete',
    version: '1.0.0',
    rules: [],
  };

  const sdlcRuleset: LintRuleset = {
    id: 'sdlc',
    name: 'SDLC',
    description: '',
    framework: 'sdlc-complete',
    version: '1.0.0',
    rules: [],
  };

  it('detects research ruleset for research paths', () => {
    const result = autoDetectRulesets('.aiwg/research/', [researchRuleset, sdlcRuleset]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('research');
  });

  it('detects sdlc ruleset for requirements paths', () => {
    const result = autoDetectRulesets('.aiwg/requirements/', [researchRuleset, sdlcRuleset]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sdlc');
  });

  it('returns all rulesets when path does not match any pattern', () => {
    const result = autoDetectRulesets('.aiwg/misc/', [researchRuleset, sdlcRuleset]);
    expect(result).toHaveLength(2);
  });
});

describe('rule glob resolution is independent of the walk root (#2555)', () => {
  const rule: LintRule = {
    id: 'research/uncertainty-registered',
    name: 'Uncertainty must name an obstacle',
    description: 'test',
    severity: 'warn',
    appliesTo: { glob: 'documentation/references/**/*.md' },
    checks: [{ type: 'unregistered-uncertainty' }],
  } as unknown as LintRule;

  const FLAGGED = [
    '# REF-001',
    '',
    'The ACL Anthology camera-ready was not retrieved at induction.',
    '',
  ].join('\n');

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'documentation', 'references'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'documentation', 'references', 'REF-001.md'), FLAGGED);
  });

  it('finds the same findings whether the target is the repo root or the glob directory', async () => {
    const fromRoot = await runLint(TEST_DIR, [makeRuleset([rule])], { recursive: true });
    const fromGlobDir = await runLint(join(TEST_DIR, 'documentation', 'references'), [makeRuleset([rule])], { recursive: true });

    expect(fromRoot.diagnostics.length).toBe(1);
    // The reported shape: narrowing to the directory the glob names silently
    // disabled the rule and reported PASS.
    expect(fromGlobDir.diagnostics.length).toBe(1);
    expect(fromGlobDir.summary.rulesApplied).toBe(1);
    expect(fromGlobDir.summary.passed).toBe(fromRoot.summary.passed);
  });

  it('reports how many rules applied, and none applying is visible in the result', async () => {
    mkdirSync(join(TEST_DIR, 'elsewhere'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'elsewhere', 'NOTE.md'), '# Note\n');

    const applied = await runLint(join(TEST_DIR, 'documentation', 'references'), [makeRuleset([rule])], { recursive: true });
    expect(applied.summary).toMatchObject({ rulesSelected: 1, rulesApplied: 1, inapplicableRules: [] });

    const inapplicable = await runLint(join(TEST_DIR, 'elsewhere'), [makeRuleset([rule])], { recursive: true });
    expect(inapplicable.summary).toMatchObject({ rulesSelected: 1, rulesApplied: 0 });
    expect(inapplicable.summary.inapplicableRules).toEqual(['research/uncertainty-registered']);
  });

  it('does not let an unrelated ancestor segment widen a glob', async () => {
    const rootOnly: LintRule = { ...rule, id: 'test/root-only', appliesTo: { glob: 'findings/*.md' } } as LintRule;
    const res = await runLint(join(TEST_DIR, 'documentation', 'references'), [makeRuleset([rootOnly])], { recursive: true });
    expect(res.summary.rulesApplied).toBe(0);
  });
});

describe('generated trees and documented gaps (#2555)', () => {
  it('skips files git ignores unless --no-gitignore is given', async () => {
    const { execFileSync } = await import('child_process');
    const repo = join(TEST_DIR, 'repo');
    mkdirSync(join(repo, 'indices'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'indices/\n');
    writeFileSync(join(repo, 'indices', 'generated.md'), 'REF-9999 is cited here.\n');
    writeFileSync(join(repo, 'authored.md'), '# Authored\n');

    const rule: LintRule = {
      id: 'test/citation-resolves', name: 'c', description: 't', severity: 'error',
      appliesTo: { glob: '**/*.md' }, checks: [{ type: 'reference-resolves' }],
    } as unknown as LintRule;

    const ignored = await runLint(repo, [makeRuleset([rule])], { recursive: true });
    expect(ignored.diagnostics).toHaveLength(0);

    const included = await runLint(repo, [makeRuleset([rule])], { recursive: true, respectGitignore: false });
    expect(included.diagnostics.map((d) => d.file)).toContain(join('indices', 'generated.md'));
  });

  it('treats a mention beside an absence marker as documentation, not a dangling reference', async () => {
    const rule: LintRule = {
      id: 'test/citation-resolves', name: 'c', description: 't', severity: 'error',
      appliesTo: { glob: '**/*.md' }, checks: [{ type: 'reference-resolves' }],
    } as unknown as LintRule;

    writeFileSync(join(TEST_DIR, 'findings', 'INDEX.md'), [
      '# Index',
      '',
      'REF-449 is refreshed in place; REF-2464 remains unallocated after deduplication.',
      '',
      'REF-7777 is cited without any such note.',
      '',
    ].join('\n'));

    const res = await runLint(TEST_DIR, [makeRuleset([rule])], { recursive: true });
    const messages = res.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes('REF-2464'))).toBe(false);
    expect(messages.some((m) => m.includes('REF-449'))).toBe(false);
    expect(messages.some((m) => m.includes('REF-7777'))).toBe(true);
  });
});

describe('retraction convention (#2556)', () => {
  const rule: LintRule = {
    id: 'test/uncertainty', name: 'u', description: 't', severity: 'warn',
    appliesTo: { glob: 'findings/REF-*.md' }, checks: [{ type: 'unregistered-uncertainty' }],
  } as unknown as LintRule;

  async function lint(body: string) {
    writeFileSync(join(TEST_DIR, 'findings', 'REF-002.md'), body);
    const res = await runLint(TEST_DIR, [makeRuleset([rule])], { recursive: true });
    return res.diagnostics.filter((d) => d.ruleId === 'test/uncertainty');
  }

  it('accepts a dated retraction whose struck text runs past one sentence', async () => {
    // The reported shape: bold lead-in plus a second sentence inside `~~…~~`.
    const ds = await lint([
      '# REF-002',
      '',
      '6. ~~**Archived artifact is the preprint, not the camera-ready.** The ACL Anthology version was not retrieved at induction, so any reviewer-driven change is unverified here.~~ **Done 2026-09-12 (post-induction audit).** The ACL Anthology camera-ready was retrieved, archived and diffed.',
      '',
    ].join('\n'));
    expect(ds).toHaveLength(0);
  });

  it('still accepts the one-sentence form that already worked', async () => {
    const ds = await lint([
      '# REF-002',
      '',
      '- ~~The PMLR camera-ready was not retrieved.~~ **Done 2026-09-12 (post-induction audit).** The PMLR v267 camera-ready was archived.',
      '',
    ].join('\n'));
    expect(ds).toHaveLength(0);
  });

  it('still flags a struck statement with no dated outcome after it', async () => {
    const ds = await lint([
      '# REF-002',
      '',
      '- ~~The ACL Anthology camera-ready was not retrieved at induction.~~ Superseded.',
      '',
    ].join('\n'));
    expect(ds).toHaveLength(1);
  });

  it('still flags an unstruck statement even when a date appears elsewhere on the line', async () => {
    const ds = await lint([
      '# REF-002',
      '',
      '- The ACL Anthology camera-ready was not retrieved at induction. Induction ran 2026-09-01.',
      '',
    ].join('\n'));
    expect(ds).toHaveLength(1);
  });

  it('names the dated retraction form in the fix hint', async () => {
    const ds = await lint('# REF-002\n\nThe camera-ready was not retrieved.\n');
    expect(ds[0]?.fix).toContain('**Done YYYY-MM-DD');
  });
});
