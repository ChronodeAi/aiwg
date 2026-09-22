/**
 * Rules support discovery triggers the same way skills do, but a rule's name
 * describes the policy rather than the question an agent asks — so a rule with
 * no triggers is only reachable by lexical title overlap.
 *
 * @issue #2544
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function lint(args = []) {
  const out = execFileSync('node', [path.join(ROOT, 'tools/lint/rule-triggers.mjs'), ...args], { timeout: 60_000,
    cwd: ROOT, encoding: 'utf8',
  });
  return out;
}

describe('rule trigger coverage lint (#2544)', () => {
  it('reports totals and the rules still missing triggers', () => {
    const report = JSON.parse(lint(['--json']));
    expect(report.total).toBeGreaterThan(0);
    expect(report.withTriggers).toBeGreaterThan(0);
    expect(Array.isArray(report.missing)).toBe(true);
    expect(report.withTriggers + report.missing.length).toBe(report.total);
  });

  it('does not count generated rule indexes as authored rules', () => {
    const report = JSON.parse(lint(['--json']));
    const generated = report.missing.filter((p) => /RULES-(INDEX|ONDEMAND)\.md$/.test(p));
    expect(generated).toEqual([]);
  });

  it('reports the authorization and safety rules as covered', () => {
    // These are the rules an agent most needs to reach mid-task, and the ones
    // the issue identified as least able to surface.
    const report = JSON.parse(lint(['--json']));
    for (const name of [
      'human-authorization', 'token-security', 'anti-laziness',
      'delivery-policy', 'ops-safety', 'respect-repo-access-manifest',
    ]) {
      expect(report.missing.some((p) => p.endsWith(`/${name}.md`))).toBe(false);
    }
  });

  it('keeps shipped trigger phrases usable — not a restated title, not one generic word', () => {
    const covered = [
      'agentic/code/addons/aiwg-utils/rules/human-authorization.md',
      'agentic/code/addons/aiwg-utils/rules/delivery-policy.md',
      'agentic/code/frameworks/ops-complete/rules/ops-safety.md',
    ];
    for (const rel of covered) {
      const content = readFileSync(path.join(ROOT, rel), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
      const block = /(?:^|\n)triggers:\s*\n((?:\s*-\s+.*\n?)+)/.exec(fm[1]);
      const phrases = block[1].split('\n')
        .map((l) => l.replace(/^\s*-\s+/, '').replace(/^"|"$/g, '').trim())
        .filter(Boolean);

      expect(phrases.length).toBeGreaterThanOrEqual(3);
      const slug = path.basename(rel, '.md');
      for (const phrase of phrases) {
        // A single generic word matches far too much.
        expect(phrase.split(/\s+/).length).toBeGreaterThan(1);
        // Restating the title adds nothing the index does not already have.
        expect(phrase.replace(/\s+/g, '-')).not.toBe(slug);
      }
    }
  });
});
