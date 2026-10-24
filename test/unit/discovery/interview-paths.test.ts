import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInterviewPlan, credentialReference, interviewQuestions, questionId, workspaceSlug } from '../../../src/discovery/interview.js';
import { resolveProviderPathValue } from '../../../src/providers/provider-definitions.js';
import { guidedInventory, INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';

const fixtures = [
  { platform: 'Linux', paths: posix, root: '/home/dev/Shop $1', home: '/home/dev' },
  { platform: 'macOS', paths: posix, root: '/Users/dev/Shop $1', home: '/Users/dev' },
  { platform: 'Windows', paths: win32, root: 'C:\\Users\\dev\\Shop $1', home: 'C:\\Users\\dev' },
  { platform: 'Windows UNC', paths: win32, root: '\\\\server\\projects\\Shop $1', home: '\\\\server\\users\\dev' },
  { platform: 'WSL', paths: posix, root: '/mnt/c/Users/dev/Shop $1', home: '/home/dev' },
];

describe('guided setup cross-platform path fixtures', () => {
  it.each(fixtures)('$platform keeps slugs stable and plans native config/credential paths without filesystem access', ({ paths, root, home }) => {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 8);
    expect(workspaceSlug(root)).toBe(`shop--1-${digest}`);
    expect(workspaceSlug(root)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(workspaceSlug(`${root}${paths.sep}`)).toMatch(/^shop--1-[a-f0-9]{8}$/);
    const inventory = guidedInventory(root);
    const context = { inventory, workspaceRoot: root, paths };
    const answers = {
      [questionId('targets', 'workspaces', root)]: { value: [root], source: 'interview' as const, answeredAt: INTERVIEW_TIME },
      [questionId('tools', 'provider', root, 'codex')]: { value: true, source: 'interview' as const, answeredAt: INTERVIEW_TIME },
    };
    const questions = interviewQuestions(context, answers);
    const configPath = paths.join(root, 'AGENTS.md');
    expect(questions.find(q => q.topic === 'config-dir')?.default).toBe(configPath);
    const credentialPath = paths.join(root, '.credentials', 'codex');
    const reference = credentialReference(`file:${credentialPath}`, paths);
    expect(reference).toEqual({ kind: 'credential-ref', source: 'file', name: credentialPath });
    expect(questions.find(q => q.input === 'credential')?.options.map(o => o.value)).toContainEqual(reference);
    const plan = buildInterviewPlan(context, { ...answers,
      [questionId('locations', 'config-dir', root, 'codex')]: { value: configPath, source: 'interview', answeredAt: INTERVIEW_TIME },
    }, INTERVIEW_TIME);
    expect(plan.actions.find(a => a.kind === 'write-project-config')?.dependsOn).toContainEqual({
      kind: 'path', workspace: root, path: paths.join(root, '.aiwg', 'aiwg.config'),
    });
    expect(resolveProviderPathValue('~/.codex/config.toml', root, paths, home)).toBe(paths.join(home, '.codex', 'config.toml'));
    expect(resolveProviderPathValue(configPath, root, paths, home)).toBe(configPath);
    expect(() => credentialReference('file:relative/credential', paths)).toThrow(/absolute/);
  });

  it.each(['/', '/home/dev/日本語', 'C:\\Users\\dev\\...'])('keeps an otherwise empty basename valid: %s', root => {
    expect(workspaceSlug(root)).toMatch(/^workspace-[a-f0-9]{8}$/);
  });

  it.each(['/home/dev/' + 'a'.repeat(255), 'C:\\Users\\dev\\' + 'a'.repeat(255), 'C:\\'])('keeps long names and drive roots valid in a persisted plan ID', root => {
    const plan = buildInterviewPlan({ inventory: guidedInventory(root), workspaceRoot: root }, {}, INTERVIEW_TIME);
    expect(plan.id.length).toBeLessThanOrEqual(120);
    expect(plan.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
