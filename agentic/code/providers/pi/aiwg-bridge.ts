/** AIWG's reviewed Pi bridge. Loaded only after Pi project trust is granted. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
// Deployment binds this import to the installed implementation, including packed dist/src.
import { loadHitlLayers } from '../../../../tools/providers/pi-bridge-policy.mjs';

const execute = promisify(execFile);
type Action = { category: string; repo: string; environment: string; resources: string[]; reversible: boolean; impact: 'low' | 'medium' | 'high'; actor?: string; inputDigest?: string };
type Receipt = { file: string; effectId: string };
type Check = { decision: string; reason?: string; receipt?: Receipt };

/** Deployed bridges call the installed CLI, never import checkout-only source paths. */
export async function checkAiwgAuthorization(projectDir: string, action: Action, receipt?: Receipt): Promise<Check> {
  const temporary = await mkdtemp(join(tmpdir(), 'aiwg-pi-authorization-'));
  try {
    const file = join(temporary, 'action.json');
    await writeFile(file, JSON.stringify(action), { mode: 0o600 });
    const result = await execute('aiwg', ['config', 'authorization', 'check', '--action-file', file, '--target', projectDir,
      ...(receipt ? ['--receipt-file', receipt.file, '--effect-id', receipt.effectId] : [])],
      { cwd: projectDir, timeout: 15_000, maxBuffer: 64 * 1024 });
    return JSON.parse(result.stdout) as Check;
  } catch { return { decision: 'escalate' }; }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Host-only descriptors and callbacks; tool/issue/model payloads cannot supply these authority fields. */
export async function evaluateAiwgPiAction(projectDir: string, action: Action, hasUI: boolean,
  confirm?: () => Promise<boolean>, check = checkAiwgAuthorization,
  verify = checkAiwgAuthorization,
): Promise<{ block: true; reason: string } | undefined> {
  let result: Check;
  try { result = await check(projectDir, action); } catch { result = { decision: 'escalate' }; }
  if (result.decision === 'auto-authorized' && result.receipt?.file && result.receipt.effectId) {
    try {
      const consumed = await verify(projectDir, action, result.receipt);
      if (consumed.decision === 'auto-authorized' && consumed.receipt) return undefined;
      return { block: true, reason: consumed.reason ?? 'approval-unverified' };
    } catch { return { block: true, reason: 'approval-unverified' }; }
  }
  if (result.decision === 'deny') return { block: true, reason: 'Denied by AIWG operator policy.' };
  if (!hasUI) return { block: true, reason: action.category === 'repo.edit'
    ? "This edit needs approval under the project's AIWG policy in headless mode."
    : 'AIWG policy blocked a destructive or package-mutating command in headless mode.' };
  return await confirm?.() ? undefined : { block: true, reason: 'Denied by AIWG operator policy.' };
}

const destructive = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm\s+-\S*r\S*\s+|git\s+(?:reset\s+--hard|clean\s+-)|chmod\s+777|chown\s+-R)/i;
const packageMutation = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun|pipx?|uv|cargo)\s+(?:install|add|update|upgrade)\b/i;

/** Bind the native tool name and every input field; strings retain their exact bytes. */
export function describeAiwgPiEdit(projectDir: string, toolName: string, input: Record<string, unknown>): Action {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])) : value;
  return { category: 'repo.edit', repo: basename(projectDir), environment: 'local',
    resources: typeof input.path === 'string' ? [input.path] : [], reversible: true, impact: 'low',
    actor: `pi:${userInfo().username}`, inputDigest: `sha256:${createHash('sha256').update(JSON.stringify(canonical({ toolName, input }))).digest('hex')}` };
}

export async function evaluateAiwgPiCommand(
  command: string,
  hasUI: boolean,
  confirm?: () => Promise<boolean>,
  projectDir?: string,
): Promise<{ block: true; reason: string } | undefined> {
  if (!destructive.test(command) && !packageMutation.test(command)) return undefined;
  if (projectDir) {
    // Shell commands have unbounded resources and possible global effects. Never
    // infer a reversible file edit from argv or accept authority in tool input.
    return evaluateAiwgPiAction(projectDir, {
      category: destructive.test(command) ? 'repo.delete' : 'dependency.install',
      repo: basename(projectDir), environment: 'local', resources: [], reversible: false, impact: 'high',
    }, hasUI, confirm);
  }
  if (!hasUI) return { block: true, reason: 'AIWG policy blocked a destructive or package-mutating command in headless mode.' };
  return await confirm?.() ? undefined : { block: true, reason: 'Denied by AIWG operator policy.' };
}

export default function aiwgBridge(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, context) => {
    if (event.toolName === 'edit' || event.toolName === 'write') {
      try {
        // Reuse the check's canonical ancestor/member resolution, without a subprocess or cache.
        if (!(await loadHitlLayers(context.cwd)).layers.some(layer => layer.policy?.enabled)) return undefined;
      } catch { return { block: true, reason: 'authorization-check-unavailable' }; }
      let action: Action;
      // The host identity is part of the approval; without it, fail closed instead of throwing.
      try { action = describeAiwgPiEdit(context.cwd, event.toolName, event.input); }
      catch { return { block: true, reason: 'authorization-check-unavailable' }; }
      return evaluateAiwgPiAction(context.cwd, action, context.hasUI, async () => {
        const choice = await context.ui.select('AIWG policy requires explicit approval for this edit.', ['Deny', 'Allow once']);
        return choice === 'Allow once';
      });
    }
    if (event.toolName !== 'bash') return undefined;
    const command = typeof event.input?.command === 'string' ? event.input.command : '';
    return evaluateAiwgPiCommand(command, context.hasUI, async () => {
      const choice = await context.ui.select('AIWG policy requires explicit approval for this command.', ['Deny', 'Allow once']);
      return choice === 'Allow once';
    }, context.cwd);
  });
}
