// Project bounded group/run service diagnostics without changing admission decisions.
import { createHash } from 'node:crypto';
import { attemptBlock, attemptReadyAt, capacityBlock, type AdmissionBlock } from './shared-host-admission-checks.js';
import type { AdmissionRecord, AdmissionSnapshot, SharedHostPolicy } from './shared-host-scheduler.js';

export interface AdmissionFinding {
  kind: AdmissionBlock['kind'] | 'service-starvation';
  scope: 'group' | 'run';
  scopeId: string;
  projectId?: string;
  requestId: string;
  group?: string;
  runId: string;
  waitMs: number;
  serviceWaitMs: number;
  thresholdMs: number;
  blockingCause: string;
  dimension?: string;
  competingAdmissions: number;
}

export interface AdmissionDiagnostics {
  findings: AdmissionFinding[];
  truncated: number;
}

const maximumFindings = 64;
const label = (value: string): string => Buffer.byteLength(value, 'utf8') <= 256 ? value
  : `${Buffer.from(value).subarray(0, 180).toString('utf8')}#${createHash('sha256').update(value).digest('hex')}`;
const run = (record: AdmissionRecord): string => record.allowance?.runId ?? record.orchestratorId;
const elapsed = (now: number, since: number): number => Math.max(0, now - since);

export function projectAdmissionDiagnostics(
  snapshot: AdmissionSnapshot, policyFor: (record: AdmissionRecord) => SharedHostPolicy,
  now: number, projectId?: string,
): AdmissionDiagnostics {
  const records = Object.values(snapshot.records);
  const findings = new Map<string, AdmissionFinding>();
  // Current waits take precedence over historical denials. Stable ties make
  // truncation repeatable across independent readers of the durable snapshot.
  const candidates = records.filter(record => record.managed && (!projectId || record.projectId === projectId)
    && (record.state === 'queued' || (record.state === 'denied' && record.denial)))
    .sort((a, b) => Number(a.state === 'denied') - Number(b.state === 'denied')
      || (a.state === 'denied' ? Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!) : Date.parse(a.submittedAt) - Date.parse(b.submittedAt))
      || a.requestId.localeCompare(b.requestId));
  for (const candidate of candidates) {
    const submitted = Date.parse(candidate.submittedAt);
    if (candidate.state === 'queued' && submitted + candidate.queueTimeoutMs <= now) continue;
    const policy = policyFor(candidate);
    const thresholdMs = policy.starvationThresholdMs ?? 120_000;
    const waitMs = elapsed(candidate.state === 'denied' ? Date.parse(candidate.finishedAt!) : now, submitted);
    if (candidate.state === 'queued' && waitMs < thresholdMs) continue;
    let block = candidate.denial;
    if (candidate.state === 'queued') {
      block = snapshot.migration || snapshot.authorityRedirect
        ? { kind: 'policy-exclusion', cause: 'authority-frozen', terminal: false }
        : !candidate.accounting
          ? { kind: 'safety-blocked', cause: 'allowance-reconciliation-required', terminal: false }
          : attemptBlock(snapshot, candidate, policy, now) ?? capacityBlock(snapshot, candidate, policy, now);
    }
    if (!block) continue;
    const scopes: Array<['group' | 'run', string]> = [
      ...(candidate.managed?.group ? [['group', candidate.managed.group] as ['group', string]] : []), ['run', run(candidate)],
    ];
    for (const [scope, scopeId] of scopes) {
      const sameScope = (record: AdmissionRecord): boolean => record.projectId === candidate.projectId
        && (scope === 'group' ? record.managed?.group === scopeId : run(record) === scopeId);
      const lastService = records.filter(sameScope).reduce((latest, record) => Math.max(latest, Date.parse(record.admittedAt ?? '') || 0), Math.max(submitted, attemptReadyAt(snapshot, candidate, policy)));
      const serviceWaitMs = elapsed(now, lastService);
      // Admissions from other projects also compete at host-wide dimensions;
      // only counts, never other projects' identities, enter the public view.
      const consumes = (record: AdmissionRecord, dimension: string): boolean => dimension === 'global'
        || (dimension.startsWith('environment/') ? record.environment === candidate.environment
          : dimension.startsWith('provider/') ? record.provider === candidate.provider
            : dimension.startsWith('runtimeKind/') ? record.runtimeKind === candidate.runtimeKind
              : !record.dimensions || record.dimensions.includes(dimension));
      // Every independently binding cap must see competing service. A full
      // global queue cannot mask a local group cap that never frees capacity.
      const competingAdmissions = records.filter(record => record.admittedAt && !sameScope(record)
        && Date.parse(record.admittedAt) > lastService && Date.parse(record.admittedAt) <= now
        && (block!.dimensions ?? (block!.dimension ? [block!.dimension] : [])).every(dimension => consumes(record, dimension))).length;
      const kind = block.kind === 'capacity-wait' && serviceWaitMs >= thresholdMs && competingAdmissions >= 2
        ? 'service-starvation' : block.kind;
      const finding: AdmissionFinding = {
        kind, scope, scopeId: label(scopeId), projectId: candidate.projectId ?? policy.managed?.projectId,
        requestId: label(candidate.requestId), group: candidate.managed?.group, runId: label(run(candidate)),
        waitMs, serviceWaitMs, thresholdMs, blockingCause: block.cause,
        ...(block.dimension ? { dimension: label(block.dimension) } : {}), competingAdmissions,
      };
      const key = JSON.stringify([finding.projectId, scope, scopeId, kind, block.cause, block.dimension]);
      if (!findings.has(key)) findings.set(key, finding);
    }
  }
  return { findings: [...findings.values()].slice(0, maximumFindings), truncated: Math.max(0, findings.size - maximumFindings) };
}
