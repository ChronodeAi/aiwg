// Shared read-only eligibility checks keep admission and starvation diagnostics consistent.
import type { AdmissionRecord, AdmissionSnapshot, SharedHostPolicy } from './shared-host-scheduler.js';

export interface AdmissionBlock {
  kind: 'policy-exclusion' | 'budget-denial' | 'capacity-wait' | 'safety-blocked';
  cause: string;
  terminal: boolean;
  dimension?: string;
  dimensions?: string[];
}

export function attemptBlock(snapshot: AdmissionSnapshot, candidate: AdmissionRecord, policy: SharedHostPolicy, now: number): AdmissionBlock | undefined {
  const accounting = candidate.accounting!;
  const deny = (cause: string, kind: AdmissionBlock['kind'] = 'policy-exclusion'): AdmissionBlock => ({ kind, cause, terminal: true });
  const attempts = Object.values(snapshot.records).filter(record => record.accounting?.attemptNumber !== undefined);
  const taskAttempts = attempts.filter(record => record.accounting!.taskKey === accounting.taskKey);
  if (taskAttempts.length) {
    const previous = taskAttempts.sort((a, b) => a.accounting!.attemptNumber! - b.accounting!.attemptNumber!).at(-1)!;
    if (candidate.allowance?.previousRequestId !== previous.requestId) return deny('new attempt must reference the latest task attempt');
    if (previous.state !== 'settled') return deny('previous attempt requires proof-checked reconciliation before replacement');
    const failure = previous.accounting!.failure;
    const purpose = candidate.allowance?.purpose ?? 'retry';
    if (purpose === 'retry' || purpose === 'fallback' || failure?.class === 'rate-limit') {
      if (!failure || !failure.retryable || !['rate-limit', 'unavailable', 'timeout'].includes(failure.class)) return deny('previous failure does not permit automatic retry');
      if (!(policy.managed!.retry?.on ?? ['rate-limit', 'unavailable', 'timeout']).includes(failure.class as 'rate-limit' | 'unavailable' | 'timeout')) return deny(`${failure.class} retries are disabled`);
    }
  } else if (candidate.allowance?.previousRequestId) return deny('unknown previous task attempt');
  for (const key of [accounting.runKey, accounting.taskKey]) {
    const scope = snapshot.allowances![key]!;
    if (Date.parse(scope.deadlineAt ?? '') <= now) return deny('cumulative allowance deadline elapsed');
    const prior = attempts.filter(record => record.accounting!.runKey === key || record.accounting!.taskKey === key);
    if (scope.limits.maxAttempts !== undefined && prior.reduce((sum, record) => sum + record.accounting!.attemptCount, 0) + accounting.attemptCount > scope.limits.maxAttempts) return deny('cumulative attempt allowance exhausted', 'budget-denial');
    for (const [dimension, limit] of [['tokens', scope.limits.maxTokens], ['costUsd', scope.limits.maxCostUsd]] as const) {
      if (limit === undefined) continue;
      let used = 0;
      for (const record of prior) {
        const value = chargedUsage(record, dimension);
        if (value === null) return deny(`unknown ${dimension} charge has no finite reservation`, 'budget-denial');
        used += value;
      }
      const reserved = accounting.reservation[dimension];
      if (reserved === null || reserved === 0 || used + reserved > limit) return deny(`cumulative ${dimension} reservation exceeds allowance`, 'budget-denial');
    }
  }
  if (taskAttempts.some(record => Date.parse(record.accounting!.notBefore ?? '') > now)) return { kind: 'policy-exclusion', cause: 'retry-backoff', terminal: false };
  if (policy.managed!.budgets?.unknownCost === 'deny' && accounting.reservation.costUsd === null) return deny('unknown cost is denied by policy', 'budget-denial');
  const quotaScope = candidate.managed?.cli && snapshot.hostBinding
    ? policy.managed!.upstream![candidate.managed.cli]!.quotaScope : candidate.managed?.quotaScope;
  const quotas = quotaScope ? [`quota/${encodeURIComponent(quotaScope)}`]
    : Object.keys(snapshot.cooldowns ?? {});
  if (quotas.some(key => Date.parse(snapshot.cooldowns?.[key]?.until ?? '') > now)) return { kind: 'policy-exclusion', cause: 'quota-cooldown', terminal: false };
  return undefined;
}

function chargedUsage(record: AdmissionRecord, dimension: 'tokens' | 'costUsd'): number | null {
  const accounting = record.accounting!;
  const usage = accounting.usage;
  const measured = !usage || usage.quality === 'unknown' ? null : dimension === 'costUsd' ? usage.costUsd
    : usage.inputTokens === null || usage.outputTokens === null || usage.cacheTokens === null || usage.reasoningTokens === null ? null
      : usage.inputTokens + usage.outputTokens + usage.cacheTokens + usage.reasoningTokens;
  const reservation = accounting.reservation[dimension];
  // Uncertain execution can still accrue spend; estimates never refund a reserve.
  if (record.state !== 'settled' || usage?.quality !== 'reported') {
    return reservation === null || measured === null ? reservation : Math.max(reservation, measured);
  }
  return measured ?? reservation;
}

export function capacityBlock(snapshot: AdmissionSnapshot, candidate: AdmissionRecord, policy: SharedHostPolicy, now = -Infinity): AdmissionBlock | undefined {
  const slots = policy.managed ? candidate.reservedSlots ?? 1 : 1;
  const active = Object.values(snapshot.records).filter(record => record.state === 'admitted' || (policy.managed && record.state === 'uncertain'));
  const limits: Array<{ dimension: string; cap: number; matches: (record: AdmissionRecord) => boolean }> = [
    { dimension: 'global', cap: policy.maxConcurrent, matches: () => true },
  ];
  if (policy.managed) for (const key of candidate.dimensions ?? []) {
    const cap = policy.managed.dimensionCaps[key];
    if (cap !== undefined) limits.push({ dimension: key, cap, matches: record => !record.dimensions || record.dimensions.includes(key) });
  }
  for (const [field, quotas] of [
    ['environment', policy.environmentQuotas], ['provider', policy.providerQuotas],
    ['runtimeKind', { host: policy.defaultHostQuota ?? 1, ...policy.runtimeQuotas }],
  ] as const) {
    const cap = (quotas as Partial<Record<string, number>> | undefined)?.[candidate[field]];
    if (cap !== undefined) limits.push({ dimension: `${field}/${candidate[field]}`, cap: policy.managed ? cap : Math.ceil(cap), matches: record => record[field] === candidate[field] });
  }
  const impossible = limits.find(limit => slots > limit.cap);
  if (impossible) return { kind: 'policy-exclusion', cause: 'request-exceeds-cap', dimension: impossible.dimension, terminal: false };
  const used = (records: AdmissionRecord[], limit: typeof limits[number]) => records.filter(limit.matches)
    .reduce((sum, record) => sum + (policy.managed ? record.reservedSlots ?? 1 : 1), 0);
  const blocked = limits.filter(limit => used(active, limit) + slots > limit.cap);
  if (!blocked.length) return undefined;
  const dimensions = blocked.map(limit => limit.dimension);
  const certain = active.filter(record => record.state === 'admitted' && !(Date.parse(record.leaseExpiresAt ?? '') <= now));
  if (policy.managed && blocked.some(limit => used(certain, limit) + slots <= limit.cap)) {
    return { kind: 'safety-blocked', cause: 'uncertain-lease', dimension: dimensions[0], dimensions, terminal: false };
  }
  return { kind: 'capacity-wait', cause: 'capacity-cap', dimension: dimensions[0], dimensions, terminal: false };
}

/** Past retry/cooldown exclusion does not count toward an eligible service gap. */
export function attemptReadyAt(snapshot: AdmissionSnapshot, candidate: AdmissionRecord, policy: SharedHostPolicy): number {
  const retry = Object.values(snapshot.records).filter(record => record.accounting?.attemptNumber !== undefined
    && record.accounting.taskKey === candidate.accounting?.taskKey)
    .reduce((latest, record) => Math.max(latest, Date.parse(record.accounting!.notBefore ?? '') || 0), 0);
  const quota = candidate.managed?.cli && snapshot.hostBinding
    ? policy.managed!.upstream![candidate.managed.cli]!.quotaScope : candidate.managed?.quotaScope;
  const cooldown = Object.entries(snapshot.cooldowns ?? {}).filter(([key]) => !quota || key === `quota/${encodeURIComponent(quota)}`)
    .reduce((latest, [, value]) => Math.max(latest, Date.parse(value.until) || 0), 0);
  return Math.max(retry, cooldown);
}
