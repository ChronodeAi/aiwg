import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInterviewPlan, credentialReference, interviewQuestions, questionId } from '../../../src/discovery/interview.js';
import { readSetupPlan, unansweredPlanChoices, writeSetupPlan } from '../../../src/discovery/plan-store.js';
import { conductInterview } from '../../../src/cli/handlers/guided-setup.js';
import { guidedInventory, INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';
import type { SetupPlan } from '../../../src/discovery/plan-types.js';

let scratch: string;
let project: string;
let artifacts: string;
let plan: SetupPlan;
const clock = () => INTERVIEW_TIME;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aiwg-i-creds-'));
  project = join(scratch, 'project'); artifacts = join(scratch, 'artifacts');
  mkdirSync(project); mkdirSync(artifacts);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', artifacts);
  vi.stubEnv('AIWG_PROJECT_ARTIFACTS_PATH', ''); vi.stubEnv('AIWG_PROJECT_AIWG_DIR', '');
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', join(scratch, 'memory'));
  const inventory = guidedInventory(project);
  plan = buildInterviewPlan({ inventory, workspaceRoot: project }, {
    [questionId('tools', 'provider', project, 'codex')]: { value: true, source: 'explicit-flag', answeredAt: INTERVIEW_TIME },
  }, INTERVIEW_TIME);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });

describe('guided credential references', () => {
  it.each([
    ['env:OPENAI_API_KEY', { kind: 'credential-ref', source: 'env', name: 'OPENAI_API_KEY' }],
    ['file:/example/credential', { kind: 'credential-ref', source: 'file', name: '/example/credential' }],
    ['stdin', { kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' }],
  ])('accepts only a locator: %s', async (raw, expected) => {
    const reference = credentialReference(raw as string);
    expect(reference).toEqual(expected);
    const id = questionId('locations', 'credential-source', project, 'codex');
    plan.answers[id] = { value: reference, source: 'interview', answeredAt: INTERVIEW_TIME };
    await writeSetupPlan(project, plan);
    expect((await readSetupPlan(project, plan.id)).answers[id].value).toEqual(expected);
  });

  it.each(['pasted-value', 'env:', 'env:bad-name', 'file:relative', 'env:ghp_abcdefgh1234567890'])('rejects raw or invalid material: %s', raw => {
    expect(() => credentialReference(raw)).toThrow();
  });

  it('offers exactly three reference sources with a null default and never recommends credentials', () => {
    const questions = interviewQuestions({ inventory: plan.inventory, workspaceRoot: project }, plan.answers);
    const credential = questions.find(q => q.topic === 'credential-source')!;
    expect(credential.default).toBeNull();
    expect(credential.options.map(o => (o.value as { source: string }).source)).toEqual(['env', 'file', 'stdin-at-apply']);
    expect(plan.recommendations.some(r => r.questionId.includes('credential'))).toBe(false);
  });

  it.each(['skip', 'defer'])('%s stays unanswered and writable', async navigation => {
    const result = await conductInterview({ context: { inventory: plan.inventory, workspaceRoot: project },
      answers: plan.answers, interactive: true, now: clock,
      ask: async q => q.input === 'credential' ? navigation : 'skip', save: p => writeSetupPlan(project, p) });
    const id = questionId('locations', 'credential-source', project, 'codex');
    expect(Object.hasOwn(result.plan.answers, id)).toBe(false);
    const choice = unansweredPlanChoices(result.plan).find(q => q.questionId === id)!;
    expect(choice.deferredAt).toBe(navigation === 'defer' ? INTERVIEW_TIME : undefined);
    await writeSetupPlan(project, result.plan);
    expect(unansweredPlanChoices(await readSetupPlan(project, result.plan.id)).some(q => q.questionId === id)).toBe(true);
  });

  it('rejects raw credential answers and poisoned recommendations before changing saved bytes', async () => {
    const destination = await writeSetupPlan(project, plan);
    const before = readFileSync(destination, 'utf8');
    const id = questionId('locations', 'credential-source', project, 'codex');
    for (const value of ['ordinary pasted value', 'ghp_abcdefgh1234567890']) {
      await expect(writeSetupPlan(project, { ...plan, answers: { ...plan.answers,
        [id]: { value, source: 'interview', answeredAt: INTERVIEW_TIME } } })).rejects.toThrow(/credential-ref/);
      await expect(writeSetupPlan(project, { ...plan, recommendations: [{ questionId: id, value, reason: 'Untrusted input.' }] })).rejects.toThrow(/credential-ref/);
    }
    expect(readFileSync(destination, 'utf8')).toBe(before);
    expect(readdirSync(join(artifacts, 'setup', 'plans'))).toEqual([`${plan.id}.json`]);
  });
});
