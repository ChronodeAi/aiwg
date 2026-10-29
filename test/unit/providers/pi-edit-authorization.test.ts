// Runs the deployed native edit hook through a synthetic installed-CLI transport.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { checkHitlAuthorization } from '../../../src/policy/hitl-check.js';
import { policy } from '../../fixtures/policy/hitl.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
  return { ...actual, execFile };
});
import bridge from '../../../agentic/code/providers/pi/aiwg-bridge.js';

let dir: string;
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
  dir = await mkdtemp(join(tmpdir(), 'aiwg-pi-edit-')); await mkdir(join(dir, '.aiwg'));
  const config = emptyConfig(); const p = policy();
  p.profiles.testnet.repos = [basename(dir)]; p.profiles.testnet.environments = ['local'];
  config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: p };
  await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify(config));
  execute.mockImplementation(async (_command: string, args: string[]) => {
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const receipt = args.includes('--receipt-file') ? { file: flag('--receipt-file'), effectId: flag('--effect-id') } : undefined;
    const action = JSON.parse(await readFile(flag('--action-file'), 'utf8'));
    return { stdout: JSON.stringify(await checkHitlAuthorization(dir, action, { now: '2026-10-27T01:00:00Z', receipt })) };
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

it.each(['edit', 'write'].flatMap(toolName => [false, true].flatMap(hasUI =>
  ['absent', 'unconfigured', 'disabled'].map(state => ({ toolName, hasUI, state })),
)))('passes $toolName through with zero authorization calls: UI=$hasUI, policy=$state', async ({ toolName, hasUI, state }) => {
  const file = join(dir, '.aiwg/aiwg.config');
  if (state === 'absent') await rm(file);
  else {
    const config = state === 'unconfigured' ? emptyConfig() : JSON.parse(await readFile(file, 'utf8'));
    if (state === 'disabled') config.authorization.hitl.enabled = false;
    await writeFile(file, JSON.stringify(config));
  }
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const select = vi.fn(async () => 'Deny');
  expect(await hook({ toolName, input: { path: 'src/index.ts', content: 'bytes' } },
    { cwd: dir, hasUI, ui: { select } })).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(0);
  expect(select).not.toHaveBeenCalled();
});

it.each(['edit', 'write'])('explains headless %s approval without describing it as a destructive command', async toolName => {
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  execute.mockResolvedValue({ stdout: JSON.stringify({ decision: 'escalate', reason: 'policy-requires-review' }) });
  expect(await hook({ toolName, input: { path: 'src/index.ts', content: 'bytes' } }, { cwd: dir, hasUI: false }))
    .toEqual({ block: true, reason: "This edit needs approval under the project's AIWG policy in headless mode." });
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(['ancestor', 'member_of'])('gates an enabled %s policy through canonical membership resolution', async kind => {
  const member = join(dir, 'member');
  const governing = kind === 'member_of' ? join(dir, 'workspace') : dir;
  await mkdir(join(governing, '.aiwg'), { recursive: true });
  await mkdir(join(member, '.aiwg'), { recursive: true });
  const local = emptyConfig();
  if (kind === 'member_of') local.workspace = { member_of: governing };
  await writeFile(join(member, '.aiwg/aiwg.config'), JSON.stringify(local));
  const config = JSON.parse(await readFile(join(dir, '.aiwg/aiwg.config'), 'utf8'));
  config.workspace = { name: 'outer' }; config.repos = [{ name: 'member', path: member, allowed: ['read'] }];
  if (kind === 'member_of') await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify(emptyConfig()));
  await writeFile(join(governing, '.aiwg/aiwg.config'), JSON.stringify(config));
  const alias = join(dir, 'alias'); await symlink(member, alias, 'dir');
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const select = vi.fn(async () => 'Deny');
  execute.mockResolvedValue({ stdout: JSON.stringify({ decision: 'escalate' }) });
  expect(await hook({ toolName: 'write', input: { path: 'src/index.ts', content: 'bytes' } },
    { cwd: alias, hasUI: true, ui: { select } })).toMatchObject({ block: true });
  expect(execute).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(1);
});

it('rechecks policy enablement for each edit in the same Pi session', async () => {
  const file = join(dir, '.aiwg/aiwg.config'); const original = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify(emptyConfig()));
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const event = { toolName: 'edit', input: { path: 'src/index.ts', oldText: 'old', newText: 'new' } };
  expect(await hook(event, { cwd: dir, hasUI: false })).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(0);
  await writeFile(file, original);
  execute.mockResolvedValue({ stdout: JSON.stringify({ decision: 'deny' }) });
  expect(await hook(event, { cwd: dir, hasUI: false })).toMatchObject({ block: true });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('fails closed when policy layers cannot be resolved', async () => {
  await writeFile(join(dir, '.aiwg/aiwg.config'), '{');
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const select = vi.fn(async () => 'Allow once');
  expect(await hook({ toolName: 'edit', input: { path: 'src/index.ts', newText: 'bytes' } },
    { cwd: dir, hasUI: true, ui: { select } })).toEqual({ block: true, reason: 'authorization-check-unavailable' });
  expect(execute).toHaveBeenCalledTimes(0); expect(select).not.toHaveBeenCalled();
});

it.each(['edit', 'write'])('binds native %s input and verifies its receipt before returning control to Pi', async toolName => {
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const select = vi.fn();
  const input = { path: 'src/index.ts', content: 'synthetic bytes\n', oldText: 'old', newText: 'new', actor: 'forged-actor' };
  expect(await hook({ toolName, input }, { cwd: dir, hasUI: false, ui: { select } })).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(2); expect(select).not.toHaveBeenCalled();
  const firstArgs = execute.mock.calls[0][1] as string[];
  const secondArgs = execute.mock.calls[1][1] as string[];
  expect(firstArgs).not.toContain('--receipt-file'); expect(secondArgs).toContain('--receipt-file');
  const receipt = JSON.parse(await readFile(secondArgs[secondArgs.indexOf('--receipt-file') + 1], 'utf8'));
  const { hitlDigest } = await import('../../../src/policy/hitl.js');
  expect(receipt.action.actorDigest).toBe(hitlDigest(`pi:${userInfo().username}`));
  expect(receipt.action.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  await expect(readFile(join(dir, input.path))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(firstArgs[firstArgs.indexOf('--action-file') + 1])).rejects.toMatchObject({ code: 'ENOENT' });
});

it('blocks an unreadable CLI result and a failed receipt verification', async () => {
  let hook: any;
  bridge({ on: (_name: string, handler: any) => { hook = handler; } } as any);
  const event = { toolName: 'edit', input: { path: 'src/index.ts', oldText: 'old', newText: 'new' } };
  execute.mockResolvedValueOnce({ stdout: 'invalid JSON' });
  expect(await hook(event, { cwd: dir, hasUI: false })).toMatchObject({ block: true });
  execute.mockResolvedValueOnce({ stdout: JSON.stringify({ decision: 'auto-authorized', receipt: { file: 'absent', effectId: 'absent' } }) });
  expect(await hook(event, { cwd: dir, hasUI: true })).toMatchObject({ block: true, reason: 'authorization-check-unavailable' });
});
