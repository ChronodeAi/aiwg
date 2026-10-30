// Verifies loop confirmation and recovery guidance calls the receipt-producing resolver helper.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { hitlConsumerCases } from '../../helpers/hitl-consumer.js';

hitlConsumerCases('agent-loop');
it('wires every loop confirmation surface and preserves safety gates', () => {
  const root = 'agentic/code/addons/agent-loop';
  for (const name of ['ralph', 'infer-completion-criteria', 'agent-loop-ext', 'agent-loop', 'ralph-resume', 'ralph-config', 'ralph-abort', 'debug-memory', 'ralph-external', 'ralph-memory']) {
    const skill = readFileSync(`${root}/skills/${name}/SKILL.md`, 'utf8');
    expect(skill, name).toContain('aiwg config authorization check --action-file');
    expect(skill, name).toContain('with a signed receipt');
    expect(skill, name).toContain('prompts are never bypassed');
  }
  const agent = readFileSync(`${root}/agents/ralph-loop.md`, 'utf8');
  expect(agent).toContain('aiwg config authorization check --action-file');
  const guidance = readFileSync(`${root}/docs/hitl-authorization.md`, 'utf8');
  expect(guidance).toContain('policy.override');
  expect(guidance).toContain('High impact; retain the existing gate');
  expect(guidance).toContain('never approves an entire open-ended loop');
});
