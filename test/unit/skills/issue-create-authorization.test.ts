// Verifies the issue-create workflow consumes HITL independently of threat-policy authorization.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { hitlConsumerCases } from '../../helpers/hitl-consumer.js';

hitlConsumerCases('issue-create');
it('gates each real backend effect and preserves composition authorization', () => {
  const skill = readFileSync('agentic/code/frameworks/sdlc-complete/skills/issue-create/SKILL.md', 'utf8');
  expect(skill).toContain('aiwg config authorization check --action-file');
  expect(skill).toContain('with a receipt');
  expect(skill).toContain('remote tracker creation/cross-links are `tracker.write`');
  expect(skill).toContain('never satisfies');
  expect(skill).toContain('Platform prompts are never bypassed');
  expect(skill.indexOf('Step 6: HITL checkpoint')).toBeLessThan(skill.indexOf('### Provider-specific issue writes'));
});
