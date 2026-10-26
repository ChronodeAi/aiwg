// Expands same-family group templates while preserving inherited ceilings and origins.
import type { ParallelismConfig, WorkerGroup, WorkerMember } from './aiwg-config.js';
import type { WorkerPolicyOrigin } from '../models/types.js';
import { mergeWorkerSelection } from '../models/worker-selection-policy.js';
import { workerConfigDigest } from './worker-config-digest.js';

type ExpandedParallelism = Omit<ParallelismConfig, 'groups'> & {
  groups?: Record<string, WorkerGroup & { members: WorkerMember[] }>;
};
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

export function expandWorkerGroupTemplates(input: unknown, source = 'parallelism'): {
  parallelism: ExpandedParallelism | undefined; origins: Record<string, WorkerPolicyOrigin[]>; errors: string[];
} {
  const origins: Record<string, WorkerPolicyOrigin[]> = {};
  const errors: string[] = [];
  if (!object(input)) return { parallelism: input as ExpandedParallelism | undefined, origins, errors };
  const parallelism = structuredClone(input) as ExpandedParallelism;
  const templates = input.groupTemplates ?? {};
  if (parallelism.groups) parallelism.groups = Object.assign(Object.create(null), parallelism.groups);
  const fail = (pointer: string, message: string): void => { errors.push(`OG_POLICY_RELAXATION ${pointer}: ${message}`); };
  const merge = (base: WorkerGroup, own: WorkerGroup, pointer: string): WorkerGroup => {
    const result = { ...base, ...own, execution: { ...base.execution, ...own.execution } };
    delete result.template;
    if (base.maxParallel !== undefined && own.maxParallel !== undefined) {
      if (own.maxParallel > base.maxParallel) fail(pointer, 'Template concurrency ceiling cannot be widened');
      result.maxParallel = Math.min(base.maxParallel, own.maxParallel);
    }
    if (base.efforts && own.efforts) {
      if (own.efforts.some(effort => !base.efforts!.includes(effort))) fail(pointer, 'Template effort ceiling cannot be widened');
      result.efforts = own.efforts.filter(effort => base.efforts!.includes(effort));
    }
    if (base.members && own.members) {
      for (const member of own.members) {
        const prior = base.members.find(candidate => candidate.id === member.id);
        if (!prior || prior.cli !== member.cli || prior.model !== member.model
          || member.roles.some(role => !prior.roles.includes(role)) || prior.enabled === false && member.enabled !== false) {
          fail(pointer, 'Template member ceiling cannot be widened or rebound');
        }
      }
    }
    result.requiredRoles = [...new Set([...(base.requiredRoles ?? []), ...(own.requiredRoles ?? [])])];
    if (base.dataPolicy || own.dataPolicy) {
      const merged = mergeWorkerSelection([
        { source, authority: 'project', digest: workerConfigDigest(base), policy: base.dataPolicy ? { dataPolicy: base.dataPolicy } : undefined },
        { source, authority: 'project', digest: workerConfigDigest(own), policy: own.dataPolicy ? { dataPolicy: own.dataPolicy } : undefined },
      ]);
      for (const diagnostic of merged.diagnostics) fail(`${pointer}/dataPolicy`, diagnostic.message);
      result.dataPolicy = merged.policy.dataPolicy;
    }
    for (const key of Object.keys(base.execution ?? {}) as Array<keyof NonNullable<WorkerGroup['execution']>>) {
      const before = base.execution![key];
      const after = own.execution?.[key];
      // Execution constraints have no universally safe cross-profile ordering.
      if (after !== undefined && after !== before) fail(`${pointer}/execution/${key}`, 'Inherited execution control cannot change');
    }
    return result;
  };
  const shape = (value: unknown, pointer: string): value is WorkerGroup => {
    if (!object(value) || value.template !== undefined && typeof value.template !== 'string'
      || value.members !== undefined && (!Array.isArray(value.members) || value.members.some((member: unknown) => !object(member) || !Array.isArray(member.roles)))
      || value.efforts !== undefined && !Array.isArray(value.efforts)
      || value.execution !== undefined && !object(value.execution)) {
      errors.push(`OG_CONFIG_REFERENCE ${pointer}: Invalid group template shape`);
      return false;
    }
    return true;
  };
  const expanded = new Map<string, WorkerGroup>();
  const depths = new Map<string, number>();
  const failed = new Set<string>();
  const expand = (name: string): WorkerGroup => {
    const pending: string[] = [];
    const active = new Set<string>();
    let next = name;
    // Collect uncached ancestors iteratively, then expand from the root down.
    while (!expanded.has(next) && !failed.has(next)) {
      const pointer = `/parallelism/groupTemplates/${escape(next)}`;
      if (active.has(next)) {
        errors.push(`OG_CONFIG_REFERENCE ${pointer}: Cyclic or excessive template nesting`);
        failed.add(next); break;
      }
      if (!object(templates) || !Object.hasOwn(templates, next)) {
        errors.push(`OG_CONFIG_REFERENCE ${pointer}: Unknown template`);
        failed.add(next); break;
      }
      const own = templates[next];
      if (!shape(own, pointer)) { failed.add(next); break; }
      active.add(next);
      pending.push(next);
      if (!own.template) break;
      next = own.template;
    }
    for (const current of pending.reverse()) {
      const own = templates[current] as WorkerGroup;
      if (failed.has(current) || own.template && failed.has(own.template)) { failed.add(current); continue; }
      const depth = (own.template ? depths.get(own.template)! : 0) + 1;
      if (depth > 64) {
        errors.push(`OG_CONFIG_REFERENCE /parallelism/groupTemplates/${escape(current)}: Cyclic or excessive template nesting`);
        failed.add(current); continue;
      }
      const parent = own.template ? expanded.get(own.template)! : {};
      expanded.set(current, merge(parent, own, `/parallelism/groupTemplates/${escape(current)}`));
      depths.set(current, depth);
    }
    return expanded.get(name) ?? {};
  };
  if (object(templates)) for (const name of Object.keys(templates)) expand(name);
  if (object(input.groups)) {
    for (const [id, own] of Object.entries(input.groups)) {
      const pointer = `/parallelism/groups/${escape(id)}`;
      if (!shape(own, pointer)) continue;
      const base = own.template ? expand(own.template) : {};
      const result = merge(base, own, pointer);
      // Existing shape validation requires members on every fully expanded group.
      parallelism.groups![id] = result as WorkerGroup & { members: WorkerMember[] };
      if (own.template) {
        const names: string[] = [];
        for (let name: string | undefined = own.template; name && expanded.has(name); name = templates[name].template) names.push(name);
        names.reverse();
        origins[`${pointer}/template`] = names.map(name => ({ source, authority: 'project',
          digest: workerConfigDigest(templates[name]), pointer: `/parallelism/groupTemplates/${escape(name)}`,
          contribution: structuredClone(templates[name]),
        }));
        origins[`${pointer}/template`].push({ source, authority: 'project', digest: workerConfigDigest(own), pointer, contribution: structuredClone(own) });
      }
    }
  }
  // Keep raw declarations for stable provenance; the validator checks them separately.
  return { parallelism, origins, errors };
}

/** Group data declarations are further restrictions on the already merged model policy. */
export function mergeGroupWorkerPolicy(policy: import('../models/types.js').WorkerSelectionPolicy, group: WorkerGroup) {
  return mergeWorkerSelection([
    { source: 'models:effective', authority: 'project', digest: workerConfigDigest(policy), policy },
    { source: 'parallelism:group', authority: 'project', digest: workerConfigDigest(group), policy: group.dataPolicy ? { dataPolicy: group.dataPolicy } : undefined },
  ]);
}
