// Resolves direct-worker bindings, member context and offline dispatch eligibility.
import { resolveWorkerGroupInstallation } from '../config/aiwg-config.js';
import { resolveWorkerPlan } from './resolver.js';
import type { MemberReference } from './worker-member-references.js';
export { memberReferences, memberLabels, describeConfigContext, allConfiguredCliIds, isCliRequired, advisoryStatus } from './worker-member-references.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';
import type { WorkerPlanSnapshot } from './resolver.js';
import type { ProviderModelCapabilityRegistry, WorkerAdapterMetadata } from './provider-policy.js';
import type { DirectWorkerDispatchDiagnostic, DirectWorkerDispatchEligibility, DirectWorkerResolverSnapshot } from './worker-direct-readiness.js';

export const SMOKE_NOTE = 'A version probe alone leaves profiles unqualified. To record direct CLI operator approval, run aiwg doctor --probe-workers --qualify; a version probe is not an authenticated smoke run (see #3005).';

interface ResolvedDirectEntry {
  adapter: WorkerAdapterMetadata;
  adapterRef: string;
}

const ADAPTER_REFERENCE = /^(providers|workerAdapters):(.+)$/;

/**
 * Resolve the configured binding by exact, case-sensitive namespace:id
 * lookup — the same shape `resolveWorkerAdapter` (provider-policy.ts) uses
 * for dispatch and `validateParallelismConfig` uses for config validation.
 * No alias normalization happens for either namespace, so a binding this
 * accepts is also a binding the public config validator accepts, and a
 * custom `workerAdapters:<id>` reference resolves against
 * `registry.workerAdapters`, never against the provider-alias registry.
 *
 * For the `providers` namespace this falls back from `workerAdapter` to
 * `workerHealthAdapter` when no direct-dispatch binding is pinned yet — the
 * install/version metadata is identical either way, and that is exactly
 * what lets install readiness and dispatch eligibility disagree honestly
 * (installed and in range, but the resolver still has no workerAdapter to
 * dispatch through).
 */
export function resolveDirectBinding(
  registry: ProviderModelCapabilityRegistry,
  configuredAdapter: string | undefined,
  cli: string,
): ResolvedDirectEntry | { error: string } {
  let namespace: string;
  let id: string;
  if (configuredAdapter !== undefined) {
    const match = ADAPTER_REFERENCE.exec(configuredAdapter.trim());
    if (!match) return { error: `Invalid worker adapter reference '${configuredAdapter}'` };
    [, namespace, id] = match;
  } else {
    namespace = 'providers';
    id = cli;
  }
  if (namespace === 'providers') {
    const entry = registry.providers[id as keyof typeof registry.providers];
    const adapter = entry?.workerAdapter ?? entry?.workerHealthAdapter;
    if (!adapter) return { error: `No direct worker profile is registered for binding 'providers:${id}'` };
    return { adapter, adapterRef: `providers:${id}` };
  }
  const adapter = registry.workerAdapters?.[id];
  if (!adapter) return { error: `Unknown worker adapter reference 'workerAdapters:${id}'` };
  return { adapter, adapterRef: `workerAdapters:${id}` };
}

export interface DirectWorkerEligibility {
  eligibility: DirectWorkerDispatchEligibility;
  detail: string;
  diagnostics?: DirectWorkerDispatchDiagnostic[];
}

const offlineDirectContext = (): { estimator: string; briefTokens: number; inputTokens: number; toolOutputAllowance: number; reservedOutput: number } => (
  { estimator: 'doctor-offline-direct-context-v1', briefTokens: 0, inputTokens: 0, toolOutputAllowance: 0, reservedOutput: 0 }
);

/**
 * Dispatch eligibility from the actual offline dispatch resolver
 * (`resolveWorkerPlan`): called once per role for every group member
 * referencing this cli, never re-derived. A resolvable binding alone is not
 * reported as eligible — eligibility requires the resolver to actually place
 * at least one referencing member in its eligible/alternatives set. Refusals
 * are member-specific and name the resolver's own missing-evidence or policy
 * diagnostics.
 */
function resolveEligibilityFromDispatchResolver(
  resolverSnapshot: DirectWorkerResolverSnapshot,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  refs: MemberReference[],
): DirectWorkerEligibility {
  const snapshot: WorkerPlanSnapshot = {
    config: resolverSnapshot.config, models: resolverSnapshot.models, modelDigests: resolverSnapshot.modelDigests,
    catalog: resolverSnapshot.catalog, registry, installations: {},
  };
  const diagnostics = new Map<string, DirectWorkerDispatchDiagnostic>();
  const uncovered: string[] = [];
  for (const ref of refs) {
    if (!ref.enabled) continue;
    const matches = (tuple: { group: string; member: string }): boolean =>
      tuple.group === ref.groupId && tuple.member === ref.memberId;
    const seen: DirectWorkerDispatchDiagnostic[] = [];
    let eligibleHere = false;
    for (const role of ref.member.roles) {
      const plan = resolveWorkerPlan(snapshot, {
        role: role as 'efficiency' | 'coding' | 'reasoning', group: ref.groupId, member: ref.memberId,
        now: resolverSnapshot.now, context: offlineDirectContext(),
      });
      if ([plan.selected, ...plan.alternatives].some(tuple => tuple && matches(tuple))) { eligibleHere = true; break; }
      const exclusion = plan.exclusions.find(matches);
      for (const diagnostic of exclusion?.diagnostics ?? plan.diagnostics) {
        // Only an exact member pointer is generalized; other config pointers
        // remain distinct even when their diagnostic text happens to match.
        const memberPointer = `/parallelism/groups/${ref.groupId}/members/${ref.memberId}`;
        const pointer = diagnostic.pointer === memberPointer || diagnostic.pointer.startsWith(`${memberPointer}/`)
          ? `/parallelism/groups/${ref.groupId}/members${diagnostic.pointer.slice(memberPointer.length)}`
          : diagnostic.pointer;
        seen.push({ ...diagnostic, pointer, members: [`${ref.groupId}/${ref.memberId}`],
          roles: diagnostic.roles ?? [role] });
      }
    }
    if (eligibleHere) {
      return { eligibility: 'eligible',
        detail: `Dispatch resolver accepts cli '${cli}' for group '${ref.groupId}' member '${ref.memberId}'. `
          + `Dispatch eligibility: eligible. ${SMOKE_NOTE}` };
    }
    if (!seen.length) uncovered.push(`${ref.groupId}/${ref.memberId}`);
    for (const diagnostic of seen) {
      const key = JSON.stringify([diagnostic.code, diagnostic.pointer, diagnostic.message,
        diagnostic.blocking, diagnostic.origins]);
      const shared = diagnostics.get(key);
      if (shared) {
        shared.members = [...new Set([...shared.members, ...diagnostic.members])];
        shared.roles = [...new Set([...shared.roles, ...diagnostic.roles])];
      } else diagnostics.set(key, diagnostic);
    }
  }
  if (!diagnostics.size && !uncovered.length) {
    return { eligibility: 'blocked',
      detail: `Dispatch resolver has no enabled group member to evaluate for cli '${cli}'. `
        + `Dispatch eligibility: blocked. ${SMOKE_NOTE}` };
  }
  const distinct = [...diagnostics.values()];
  const reasons = distinct.map(diagnostic => `${diagnostic.code} ${diagnostic.pointer}: ${diagnostic.message}`
    + ` [roles: ${diagnostic.roles.join(', ')}; members: ${diagnostic.members.join(', ')}]`);
  if (uncovered.length) reasons.push(`No qualified route [members: ${uncovered.join(', ')}]`);
  return { eligibility: 'blocked', diagnostics: distinct,
    detail: `Dispatch resolver refuses cli '${cli}': ${reasons.join('; ')}. `
      + `Dispatch eligibility: blocked. ${SMOKE_NOTE}` };
}

/**
 * Binding-only fallback used only when the caller has not supplied a
 * `resolverSnapshot` (for example a direct unit-level call that never
 * resolved the wider model config/catalog). States plainly that this is a
 * binding-level result, not the dispatch resolver's verdict.
 */
function resolveEligibilityFromBindingOnly(
  parallelism: ParallelismConfig,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  installReady: boolean,
): DirectWorkerEligibility {
  try {
    const resolved = resolveWorkerGroupInstallation(parallelism, cli, registry);
    return { eligibility: 'eligible',
      detail: `Resolver accepts cli '${cli}' (binding '${resolved.installation.adapter}'). Dispatch eligibility: eligible at binding level only — `
        + `no resolver snapshot was supplied, so group/member qualification was not evaluated. `
        + `Launch additionally requires current installation evidence and model observation under the dispatch resolver's gates. `
        + `${SMOKE_NOTE}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const readyNote = installReady
      ? ' The CLI is installed with an in-range version, but dispatch stays refused for the reason above; '
        + `an authenticated smoke run (see #3005) alone does not satisfy the resolver gates. ${SMOKE_NOTE}`
      : ` ${SMOKE_NOTE}`;
    return { eligibility: 'blocked',
      detail: `Resolver refuses cli '${cli}': ${reason}. Dispatch eligibility: blocked.${readyNote}` };
  }
}

export function checkDispatchEligibility(
  parallelism: ParallelismConfig,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  installReady: boolean,
  resolverSnapshot: DirectWorkerResolverSnapshot | undefined,
  refs: MemberReference[],
): DirectWorkerEligibility {
  if (resolverSnapshot && refs.length) return resolveEligibilityFromDispatchResolver(resolverSnapshot, registry, cli, refs);
  return resolveEligibilityFromBindingOnly(parallelism, registry, cli, installReady);
}

