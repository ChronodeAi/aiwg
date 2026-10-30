// Verify the offline attribution diagnostic against synthetic settings scopes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkClaudeAttribution } from '../../../src/extensions/claude-attribution.js';

let root: string;
let project: string;
let home: string;
let managed: string;
const disabled = { commit: '', pr: '', sessionUrl: false };
const check = () => checkClaudeAttribution(project, home, managed);
async function put(dir: string, value: object, name = 'settings.json') {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, '.claude', name), JSON.stringify({ attribution: value }));
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-attribution-doctor-'));
  project = path.join(root, 'project'); home = path.join(root, 'home'); managed = path.join(root, 'managed.json');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('doctor Claude attribution', () => {
  it('reports default harness attribution and gives the fix command', async () => {
    expect(await check()).toEqual({ status: 'warn', message: expect.stringContaining('aiwg use all --provider claude') });
    expect((await check()).message).toContain('commit, pr, sessionUrl');
  });
  it('merges individual keys across user and project precedence', async () => {
    await put(home, { ...disabled, commit: 'User attribution' });
    await put(project, { commit: '' });
    expect((await check()).status).toBe('ok');
  });
  it('warns for an overriding local attribution value', async () => {
    await put(project, disabled);
    await put(project, { pr: 'Local PR' }, 'settings.local.json');
    expect(await check()).toEqual({ status: 'warn', message: expect.stringContaining('enabled: pr.') });
  });
  it('checks session links even with empty commit and pr strings', async () => {
    await put(project, { commit: '', pr: '' });
    expect((await check()).message).toContain('enabled: sessionUrl.');
  });
  it('honors higher-precedence managed settings', async () => {
    await put(project, disabled);
    await writeFile(managed, JSON.stringify({ attribution: { commit: 'Managed' } }));
    expect((await check()).message).toContain('enabled: commit.');
  });
  it('reports unreadable JSON instead of silently claiming disabled attribution', async () => {
    await put(project, disabled);
    await writeFile(path.join(project, '.claude/settings.local.json'), '{broken');
    expect((await check()).status).toBe('warn');
    expect((await check()).message).toContain('Could not inspect');
  });
});
