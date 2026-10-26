// Inventories expanded group membership for direct readiness without probes.
import type { ParallelismConfig, WorkerMember } from '../config/aiwg-config.js';
import { expandWorkerGroupTemplates } from '../config/worker-group-templates.js';

export interface MemberReference { groupId: string; memberId: string; member: WorkerMember; enabled: boolean }

/** Every group member referencing this cli, including disabled ones (for context). */
export function memberReferences(parallelism: ParallelismConfig, cli: string): MemberReference[] {
  parallelism = expandWorkerGroupTemplates(parallelism).parallelism!;
  const refs: MemberReference[] = [];
  for (const [groupId, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group?.members ?? []) {
      if (member.cli !== cli) continue;
      refs.push({ groupId, memberId: member.id, member,
        enabled: member.enabled !== false && parallelism.clis?.[cli]?.enabled !== false });
    }
  }
  return refs.sort((a, b) => `${a.groupId}/${a.memberId}`.localeCompare(`${b.groupId}/${b.memberId}`));
}

export function memberLabels(refs: MemberReference[]): string[] {
  return refs.map(ref => `${ref.groupId}/${ref.memberId}${ref.enabled ? '' : ' (disabled)'}`);
}

export function describeConfigContext(members: string[]): string {
  return members.length ? `members: ${members.join(', ')}` : 'members: no group member references this cli';
}

/**
 * Union of every cli id a readiness pass must consider: explicit
 * `parallelism.clis` entries plus any cli id referenced only implicitly by a
 * group member (canonical default binding, no explicit installation entry).
 */
export function allConfiguredCliIds(parallelism: ParallelismConfig, cli?: string): string[] {
  parallelism = expandWorkerGroupTemplates(parallelism).parallelism!;
  const ids = new Set(Object.keys(parallelism.clis ?? {}));
  for (const group of Object.values(parallelism.groups ?? {})) {
    for (const member of group?.members ?? []) ids.add(member.cli);
  }
  return [...ids].filter(id => cli === undefined || id === cli).sort();
}

/**
 * A cli is "required" only when an enabled group member referencing it also
 * covers a role its group lists in `requiredRoles`. Every other configured
 * cli is optional: installation failures stay advisory (never 'error', so
 * they never flip doctor's exit code) until something actually requires it.
 */
export function isCliRequired(parallelism: ParallelismConfig, cli: string): boolean {
  parallelism = expandWorkerGroupTemplates(parallelism).parallelism!;
  for (const group of Object.values(parallelism.groups ?? {})) {
    const required = new Set(group?.requiredRoles ?? []);
    if (!required.size) continue;
    for (const member of group?.members ?? []) {
      if (member.cli !== cli || member.enabled === false) continue;
      if (parallelism.clis?.[cli]?.enabled === false) continue;
      if (member.roles.some(role => required.has(role))) return true;
    }
  }
  return false;
}

/** Cap a status at 'warn' for optional (non-required) clis so an unreferenced
 * or not-yet-wired profile never flips doctor's exit code. */
export function advisoryStatus(status: 'ok' | 'info' | 'warn' | 'error', required: boolean): 'ok' | 'info' | 'warn' | 'error' {
  return required || status !== 'error' ? status : 'warn';
}
