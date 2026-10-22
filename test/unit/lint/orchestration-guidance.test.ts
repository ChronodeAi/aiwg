/**
 * Orchestration guidance lane (#2893 / #2914 / #2947 / #2943):
 * prose-level mapping assertions over the rule/skill sources.
 *
 * These pin the guidance contracts that generated-context and skill tests
 * do not cover: concrete check-in numbers in the Tier 0 procedure,
 * Jev-first checkpoints with LLM fallback and no hard dependency, the
 * per-checkpoint `--caller` tags now that #2946 landed, and the supported
 * summary/bound_to activation contract after the #2945 migration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validateDecisionAskInput, DecisionAskUsageError } from '../../../src/decision/ask.js';
import { parseRuleFrontmatter } from '../../../src/rules/activation.mjs';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const SCOPING = 'agentic/code/addons/aiwg-utils/rules/subagent-scoping.md';
const MISSION = 'agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md';
const ADDRESS_ISSUES = 'agentic/code/frameworks/sdlc-complete/skills/address-issues/SKILL.md';
const DECISION_OFFLOAD = 'agentic/code/addons/decision-engine/skills/decision-offload/SKILL.md';
const EFFICIENCY_WRAPPER = 'agentic/code/addons/aiwg-utils/agents/aiwg-model-efficiency-worker.md';
const CODING_WRAPPER = 'agentic/code/addons/aiwg-utils/agents/aiwg-model-coding-worker.md';
const REASONING_WRAPPER = 'agentic/code/addons/aiwg-utils/agents/aiwg-model-reasoning-worker.md';

describe('Tier 0 check-in guidance (#2914)', () => {
  it('subagent-scoping Rule 9 states concrete cadence and thresholds', () => {
    const text = read(SCOPING);
    expect(text).toContain('Check every 15s');
    expect(text).toContain('within 60s');
    expect(text).toContain('Quiet limit 90s');
    expect(text).toContain('stall limit 300s');
    expect(text).toContain('112.5s/375s');
    expect(text).toContain('hard stop 1800s');
    expect(text).toContain('Resolved values win over these defaults');
  });

  it('subagent-scoping Rule 9 supervises by observer state and never stops on suspicion', () => {
    const text = read(SCOPING);
    expect(text).not.toContain('suspect transition');
    expect(text).toContain('Supervise by observer state');
    expect(text).toContain('is not a stop');
    expect(text).toContain('keep waiting while you diagnose');
    expect(text).toContain('diagnostic grace period');
    expect(text).toContain('only `hung`');
    expect(text).toContain('only a worker this conductor owns');
  });

  it('subagent-scoping Rule 9 covers degraded polling and remediation', () => {
    const text = read(SCOPING);
    expect(text).toContain('With no native monitor, poll from the shell at the same cadence');
    expect(text).toContain('only a worker this conductor owns');
    expect(text).toContain('confirm it stopped');
    expect(text).toContain('preserve partial work');
    expect(text).toContain('correlated failure');
    expect(text).toContain('OBSERVER_GAP');
    expect(text).toContain('unknown, never worker failure');
  });

  it('aiwg-mission states worker check-ins and terminal verification', () => {
    const text = read(MISSION);
    expect(text).toContain('## Worker check-ins');
    expect(text).toContain('every 15s');
    expect(text).toContain('outside the worker sandbox');
    expect(text).not.toContain('suspect transition');
    expect(text).toContain('is not a stop');
    expect(text).toContain('only `hung`');
    expect(text).toContain('unknown, never worker failure');
  });
});

describe('Jev decision checkpoints (#2947)', () => {
  it('address-issues documents the four Jev-first checkpoints with fallback', () => {
    const text = read(ADDRESS_ISSUES);
    expect(text).toContain('Bounded decisions: Jev first, LLM fallback');
    expect(text).toContain('Worker/model/effort pick per dispatch');
    expect(text).toContain('Environmental vs real failure');
    expect(text).toContain('Review verdict follow-up');
    expect(text).toContain('fix now vs defer');
    expect(text).toContain('On `fallback`');
    expect(text).toContain('decide normally');
  });

  it('aiwg-mission and the Tier 0 dispatch guidance carry worker-pick and triage checkpoints', () => {
    expect(read(MISSION)).toContain('Before worker/model/effort picks');
    expect(read(SCOPING)).toContain('Before worker/model/effort picks');
  });

  it('each checkpoint carries a `<skill-or-rule>:<checkpoint>` --caller tag and still degrades cleanly without the decision engine', () => {
    const expectedTags: Record<string, string[]> = {
      [ADDRESS_ISSUES]: [
        'address-issues:worker-pick',
        'address-issues:failure-triage',
        'address-issues:review-verdict',
        'address-issues:minor-triage',
      ],
      [MISSION]: ['aiwg-mission:worker-pick', 'aiwg-mission:failure-triage'],
      [SCOPING]: ['subagent-scoping:worker-pick', 'subagent-scoping:failure-triage'],
    };
    for (const [file, tags] of Object.entries(expectedTags)) {
      const text = read(file);
      expect(text, file).toContain('fallback');
      for (const tag of tags) {
        expect(text, `${file} missing --caller ${tag}`).toContain(`--caller ${tag}`);
      }
    }
  });

  it('decision-offload lists every introduced --caller tag in one table', () => {
    const text = read(DECISION_OFFLOAD);
    const tags = [
      'address-issues:worker-pick',
      'address-issues:failure-triage',
      'address-issues:review-verdict',
      'address-issues:minor-triage',
      'aiwg-mission:worker-pick',
      'aiwg-mission:failure-triage',
      'subagent-scoping:worker-pick',
      'subagent-scoping:failure-triage',
    ];
    for (const tag of tags) {
      expect(text, tag).toContain(tag);
    }
  });

  it('decision-offload documents the comma pitfall and the canonical choices form', () => {
    const text = read(DECISION_OFFLOAD);
    expect(text).toContain('no commas in the description');
    expect(text).toContain('invalid-choices');
    expect(text).toContain('silently becomes extra choices');
    expect(text).toContain('a=fast,cheap,b=slow');
    expect(text).toContain('id=what it means');
  });

  it('a comma in a description either fails invalid-choices or silently adds choices (src/decision/ask.ts)', () => {
    const split = (raw: string): string[] => raw.split(',').map((value) => value.trim()).filter(Boolean);
    const silent = split('a=fast,cheap,b=slow');
    expect(silent).toEqual(['a=fast', 'cheap', 'b=slow']);
    expect(() => validateDecisionAskInput({
      question: 'pick one', mode: { kind: 'choices', choices: silent },
    })).not.toThrow();
    try {
      validateDecisionAskInput({ question: 'pick one', mode: { kind: 'choices', choices: split('a=,b=slow') } });
      expect.unreachable('empty description must fail validation');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionAskUsageError);
      expect((error as DecisionAskUsageError).reason).toBe('invalid-choices');
    }
  });
});

describe('worker boundary wrappers (#2893)', () => {
  for (const [file, label] of [
    [EFFICIENCY_WRAPPER, 'efficiency'],
    [CODING_WRAPPER, 'coding'],
    [REASONING_WRAPPER, 'reasoning'],
  ] as const) {
    it(`${label} wrapper states zero-child and artifact boundaries`, () => {
      const text = read(file);
      expect(text).toContain('## Worker boundaries');
      expect(text).toContain('child allowance is zero');
      expect(text).toContain('Write only allowed artifacts');
      expect(text).toContain('bounded blocked result');
    });
  }
});

describe('supported orchestration activation (#2945)', () => {
  it('uses summary delivery with validated bindings and no obsolete bound field', () => {
    // ADR 98–100, 256: subagent-scoping is summary with orchestration bindings;
    // validate the declared contract instead of forbidding the migrated mode.
    const result = parseRuleFrontmatter(read(SCOPING));
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.rule.activation).toBe('summary');
    expect(Object.values(result.rule.bound_to).flat().length).toBeGreaterThan(0);
    expect(result.data).not.toHaveProperty('bound');
  });
});

// #3311 owns the kernel discovery rule and its mirrors; keep that explicit exception
// until its companion migration lands. All other body-loading guidance is checked.
function implicitShowBodies(text: string): string[] {
  return text.split('\n').filter(line => /aiwg show/.test(line)
    && !/--(?:body|section)\b/.test(line)
    && /(?:streams? .*(?:body|content)|fetch(?:es)? (?:the |its |a )?(?:full |selected |artifact |skill |rule )*(?:body|bodies)|(?:body|bodies) (?:via|with|as fetched)|load(?:s)? .*before applying)/i.test(line));
}
describe('show metadata-card guidance (#3306)', () => {
  it('rejects instructions that promise implicit body output', () => {
    expect(implicitShowBodies('aiwg show skill demo # streams the SKILL.md body')).toHaveLength(1);
    expect(implicitShowBodies('Fetch its body with `aiwg show skill demo`')).toHaveLength(1);
    expect(implicitShowBodies('aiwg show skill demo --body # streams the body')).toEqual([]);
    expect(implicitShowBodies('aiwg show skill demo --section "Steps" # fetch the body')).toEqual([]);
    expect(implicitShowBodies('aiwg show skill demo # metadata card')).toEqual([]);
  });
  it('keeps source rule, skill, agent, and quickref instructions explicit about body access', () => {
    const failures: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(relative);
        else if (entry.name.endsWith('.md') && !entry.name.startsWith('skill-discovery')
          && /(?:rules|skills|agents)\//.test(relative.replaceAll('\\', '/'))) {
          for (const line of implicitShowBodies(read(relative))) failures.push(`${relative}: ${line}`);
        }
      }
    };
    walk('agentic/code');
    expect(failures).toEqual([]);
  });
});
