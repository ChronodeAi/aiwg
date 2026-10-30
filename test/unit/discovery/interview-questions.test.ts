import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInterviewPlan, INTERVIEW_BLOCKS, interviewQuestions, inventoryId, isAnswered, mergeSetupAnswers,
  questionId, workspaceSlug } from '../../../src/discovery/interview.js';
import { migrateSetupPlan, remainingPlanActions, unansweredPlanChoices } from '../../../src/discovery/plan-store.js';
import { validateSetupPlan } from '../../../src/discovery/plan-validation.js';
import type { SetupAnswer, SetupPlan } from '../../../src/discovery/plan-types.js';
import { guidedInventory, INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';

const inventory = guidedInventory();
const root = inventory.projects[0].root;
const context = { inventory, workspaceRoot: root };
const answer = (value: SetupAnswer['value'], source: SetupAnswer['source']): SetupAnswer => ({ value, source, answeredAt: INTERVIEW_TIME });

describe('guided interview question contract', () => {
  it('uses the five blocks in order with stable, scoped IDs and the documented explanations/defaults/flags', () => {
    const answers = { [questionId('tools', 'provider', root, 'codex')]: answer(true, 'explicit-flag') };
    const questions = interviewQuestions(context, answers);
    expect([...new Set(questions.map(q => q.block))]).toEqual(INTERVIEW_BLOCKS);
    expect(new Set(questions.map(q => q.questionId)).size).toBe(questions.length);
    for (const question of questions) expect(question.questionId).toMatch(/^(targets|intent|tools|locations|capabilities)\.[a-z0-9-]+\.(?:ws-[a-z0-9-]+\.)?[a-z0-9-]+$/);
    expect(questions.find(q => q.topic === 'scope')).toMatchObject({ questionId: 'targets.scope.shared', default: 'project', flag: '--scope project|user' });
    expect(questions.find(q => q.topic === 'use')).toMatchObject({ default: 'code', flag: '--intent code|docs|ops|mixed' });
    expect(questions.find(q => q.topic === 'scan-opt-in')).toMatchObject({ default: [], optional: true });
    expect(questions.find(q => q.topic === 'credential-source')).toMatchObject({ default: null, provider: 'codex' });
    expect(questions.find(q => q.topic === 'signing')).toMatchObject({ default: false, optional: true });
    expect(questions.find(q => q.topic === 'delivery')?.default).toEqual({ mode: 'pr-required', force_push_policy: 'never' });
    expect(questions.some(q => q.topic === 'install-method')).toBe(false);
  });

  it('offers optional integrations without secrets, gates worker details on consent, and uses only recorded qualification', () => {
    const selected = { [questionId('targets', 'workspaces', root)]: answer([root], 'interview') };
    const questions = interviewQuestions(context, selected);
    expect(questions.find(q => q.topic === 'jev')).toMatchObject({ optional: true, default: false });
    expect(questions.find(q => q.topic === 'jev')?.explanation).toMatch(/external service.*charges/);
    expect(questions.find(q => q.topic === 'worker-dispatch')).toMatchObject({ block: 'capabilities', default: false });
    expect(questions.find(q => q.topic === 'worker-dispatch')?.explanation).toContain('installed-not-qualified');
    expect(questions.some(q => q.topic === 'worker-config' || q.provider === 'jev')).toBe(false);
    const declined = { ...selected, [questionId('tools', 'worker-dispatch', root)]: answer('decline', 'existing-setting') };
    expect(interviewQuestions(context, declined).some(q => q.topic === 'worker-dispatch')).toBe(false);
    const enabled = { ...selected, [questionId('tools', 'worker-dispatch', root)]: answer('enable', 'interview'),
      [questionId('capabilities', 'jev', root)]: answer('enable', 'interview') };
    const qualified = interviewQuestions({ ...context, qualifiedWorkers: { [root]: ['codex'] } }, enabled);
    expect(qualified.find(q => q.topic === 'worker-dispatch')?.explanation).toContain('codex: qualified (recorded evidence');
    expect(qualified.find(q => q.topic === 'worker-dispatch')?.explanation).toContain('claude: installed-not-qualified');
    expect(qualified.some(q => q.topic === 'worker-config')).toBe(true);
    expect(qualified.find(q => q.provider === 'jev' && q.input === 'credential')?.default).toBeNull();
    const plan = buildInterviewPlan(context, enabled, INTERVIEW_TIME);
    expect(plan.actions.map(a => a.kind)).toEqual(['configure-jev', 'configure-worker-dispatch']);
    expect(plan.actions.find(a => a.kind === 'configure-worker-dispatch')?.dependsOn).toContainEqual({ kind: 'tool', executable: 'codex', field: 'path' });
    const unrelated = { ...inventory, tools: [inventory.tools[0], { ...inventory.tools[1], executable: 'unrelated-cli' }] };
    expect(interviewQuestions({ inventory: unrelated, workspaceRoot: root }, selected).some(q => q.topic === 'worker-dispatch')).toBe(false);
  });

  it('hashes the canonical root and never uses inventory indexes', () => {
    const digest = createHash('sha256').update('/example/SHOP $1').digest('hex').slice(0, 8);
    expect(workspaceSlug('/example/SHOP $1')).toBe(`shop--1-${digest}`);
    expect(workspaceSlug('/other/shop')).not.toBe(workspaceSlug(root));
    const other = guidedInventory('/example/other').projects[0];
    const first = interviewQuestions({ inventory: { ...inventory, projects: [other, ...inventory.projects] }, workspaceRoot: root });
    expect(first.map(q => q.questionId)).toEqual(interviewQuestions(context).map(q => q.questionId));
    const expected = createHash('sha256').update(JSON.stringify({ projects: [root], tools: ['claude', 'codex'], limits: inventory.limits })).digest('hex').slice(0, 16);
    expect(inventoryId(inventory)).toBe(`inv-${expected}`);
    expect(inventoryId({ ...inventory, tools: [...inventory.tools].reverse() })).toBe(inventoryId(inventory));
    expect(inventoryId({ ...inventory, projects: [other, ...inventory.projects] })).not.toBe(inventoryId(inventory));
  });

  it('applies every source precedence and keeps discovered values advisory', () => {
    const sources: SetupAnswer['source'][] = ['default', 'discovered', 'interview', 'existing-setting', 'explicit-flag'];
    for (let i = 0; i < sources.length; i++) for (let j = 0; j < sources.length; j++) {
      const left = { choice: answer('left', sources[i]) };
      const right = { choice: answer('right', sources[j]) };
      const merged = mergeSetupAnswers(left, right);
      const eligible = [left.choice, right.choice].filter(a => a.source !== 'discovered');
      const expected = eligible.sort((a, b) => sources.indexOf(a.source) - sources.indexOf(b.source)).at(-1);
      expect(merged.answers.choice).toEqual(expected);
      expect(merged.recommendations).toHaveLength(Number(i === 1) + Number(j === 1));
    }
  });

  it('counts false, null and default-valued own properties as answered', () => {
    const questions = interviewQuestions(context);
    const answers = Object.fromEntries(questions.slice(0, 3).map((q, i) => [q.questionId, answer([false, null, q.default][i], 'default')]));
    const plan = buildInterviewPlan(context, answers, INTERVIEW_TIME);
    for (const question of questions.slice(0, 3)) {
      expect(isAnswered(plan, question.questionId)).toBe(true);
      expect(unansweredPlanChoices(plan).some(q => q.questionId === question.questionId)).toBe(false);
    }
    expect(isAnswered({ answers: Object.create({ inherited: answer(true, 'default') }) }, 'inherited')).toBe(false);
  });

  it('builds only the contract action kinds and exact dependency selectors', () => {
    const answers: SetupPlan['answers'] = {
      [questionId('targets', 'workspaces', root)]: answer([root], 'explicit-flag'),
      [questionId('tools', 'provider', root, 'codex')]: answer(true, 'explicit-flag'),
      [questionId('locations', 'config-dir', root, 'codex')]: answer(`${root}/AGENTS.md`, 'interview'),
      [questionId('intent', 'use', root)]: answer('docs', 'interview'),
      [questionId('tools', 'worker-dispatch', root)]: answer('decline', 'explicit-flag'),
    };
    const plan = buildInterviewPlan(context, answers, INTERVIEW_TIME);
    expect(plan.actions.map(a => a.kind)).toEqual(['configure-provider', 'verify-provider', 'deploy-framework', 'write-project-config', 'register-project', 'record-decline']);
    expect(plan.actions[0]).toMatchObject({ id: `codex-configure-provider-${workspaceSlug(root)}`, workspace: root, provider: 'codex', scope: 'project',
      dependsOn: [{ kind: 'tool', executable: 'codex', field: 'installed' }, { kind: 'path', workspace: root, path: `${root}/AGENTS.md` }, { kind: 'project', root, field: 'layout' }] });
    expect(plan.actions[1].dependsOn).toEqual([{ kind: 'tool', executable: 'codex', field: 'version' }, { kind: 'project', root, field: 'layout' }]);
    expect(plan.actions[3].dependsOn).toEqual([{ kind: 'path', workspace: root, path: `${root}/package.json` }, { kind: 'project', root, field: 'layout' }, { kind: 'path', workspace: root, path: `${root}/.aiwg/aiwg.config` }]);
    expect(plan.actions[4].dependsOn).toEqual([{ kind: 'project', root, field: 'root' }, { kind: 'path', workspace: root, path: `${root}/.aiwg` }]);
    expect(plan.actions[5].dependsOn).toEqual([]);
    expect(new Set(plan.actions.map(a => a.id)).size).toBe(plan.actions.length);
    const declined = { ...answers, [questionId('capabilities', 'signing', root)]: answer(false, 'interview'),
      [questionId('capabilities', 'delivery', root)]: answer(false, 'interview'), [questionId('capabilities', 'tracker', root)]: answer(false, 'interview') };
    expect(remainingPlanActions(buildInterviewPlan(context, declined, INTERVIEW_TIME))).toEqual(plan.actions);
    expect(plan).not.toHaveProperty('config');
  });

  it('loads the unchanged v1 fixture without deferredAt and validates the additive ISO timestamp', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/setup-plan-v1.json', import.meta.url), 'utf8'));
    expect(migrateSetupPlan(fixture)).toEqual(fixture);
    fixture.unresolvedChoices[0].deferredAt = INTERVIEW_TIME;
    expect(validateSetupPlan(fixture).schemaVersion).toBe(1);
    fixture.unresolvedChoices[0].deferredAt = 'tomorrow';
    expect(() => validateSetupPlan(fixture)).toThrow(/Invalid setup plan/);
  });

  it('drops capability actions after a decline and never revives them through remainingPlanActions', () => {
    const answers = {
      [questionId('targets', 'workspaces', root)]: answer([root], 'interview'),
      [questionId('tools', 'provider', root, 'codex')]: answer(true, 'interview'),
      [questionId('tools', 'worker-dispatch', root)]: answer('enable', 'interview'),
    };
    const enabled = buildInterviewPlan(context, answers, INTERVIEW_TIME);
    expect(enabled.actions.some(action => action.kind === 'deploy-framework')).toBe(true);
    const declined = buildInterviewPlan(context, { ...answers,
      [questionId('tools', 'worker-dispatch', root)]: answer('decline', 'interview') }, INTERVIEW_TIME, enabled);
    expect(remainingPlanActions(declined).some(action => action.kind === 'deploy-framework')).toBe(false);
    expect(declined.actions.find(action => action.kind === 'record-decline')?.dependsOn).toEqual([]);
    const skipped = buildInterviewPlan(context, { ...answers,
      [questionId('tools', 'worker-dispatch', root)]: answer(false, 'default') }, INTERVIEW_TIME, declined);
    expect(remainingPlanActions(skipped).some(action => action.kind === 'deploy-framework')).toBe(false);
  });

  it('retains receipts on unchanged resume but invalidates them when an answer changes', () => {
    const answers = { [questionId('targets', 'workspaces', root)]: answer([root], 'interview'),
      [questionId('tools', 'provider', root, 'codex')]: answer(true, 'interview') };
    const prior = buildInterviewPlan(context, answers, INTERVIEW_TIME);
    prior.receipts = [{ workspace: root, actions: { [prior.actions[0].id]: {
      status: 'applied', startedAt: INTERVIEW_TIME, completedAt: INTERVIEW_TIME,
    } } }];
    expect(buildInterviewPlan(context, answers, INTERVIEW_TIME, prior).receipts).toEqual(prior.receipts);
    const changed = { ...answers, [questionId('targets', 'scope')]: answer('user', 'interview') };
    expect(buildInterviewPlan(context, changed, INTERVIEW_TIME, prior).receipts).toEqual([]);
  });
});
