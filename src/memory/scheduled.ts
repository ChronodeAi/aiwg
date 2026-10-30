import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectAiwgWritePath } from '../config/project-artifacts.js';
import { auditMemory } from './audit.js';
import { recommendMemory, RecommendationInputsSchema } from './recommend.js';
import { parseMemoryAuditOptions, resolveMemoryCostInputs } from './cli.js';
import { createMaintenanceOwners } from './maintenance-cli.js';
import { applyMaintenancePlan, MaintenanceApplyError, maintenanceOperationKey, maintenancePath, maintenancePlanDigest, previewMaintenancePlan, verifyMaintenancePlan } from './maintenance.js';
import { MaintenancePlanSchema, type MaintenanceReceipt } from './maintenance-contract.js';

/** Read-only owner views; the routed report is the only payload written. */
export async function reportScheduledMemory(kind: string, args: Record<string, string>, workspace: string, at: string) {
  const options = parseMemoryAuditOptions(['scope', 'provider'].flatMap(key => args[key] ? [`--${key}`, args[key]] : []));
  // Resolve before scanning: an unavailable external destination must fail closed.
  const reportPath = projectAiwgWritePath(workspace, 'reports', 'memory', `${kind}-${randomUUID()}.json`);
  const audit = await auditMemory({ ...options, workspace, at });
  const report = kind === 'memory.recommend'
    ? recommendMemory(audit,
      args.evidence ? RecommendationInputsSchema.parse(JSON.parse(readFileSync(resolve(workspace, args.evidence), 'utf8'))) : {},
      await resolveMemoryCostInputs({ demote: [], usage: args.usage ? resolve(workspace, args.usage) : undefined }))
    : audit;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const candidates = 'candidates' in report ? report.candidates.length : 0;
  const findings = audit.findings.length;
  // Findings are a normal report outcome, not a job failure: a non-zero exit
  // would make the scheduler retry an unchanged read-only report.
  return { exitStatus: 0,
    summary: `${kind}: ${audit.items.length} items, ${findings} findings, ${candidates} recommendations`,
    detail: { schemaVersion: report.schemaVersion, reportPath, counts: { items: audit.items.length, findings, candidates },
      findingsStatus: findings || candidates ? 'findings' : 'clear', complete: report.coverage.complete } };
}

/** Scheduling executes one exact reviewed plan. It never prepares or resumes one. */
export async function applyScheduledMemory(args: { plan: string; confirmedDigest: string }, root: string) {
  try {
    const plan = MaintenancePlanSchema.parse(JSON.parse(readFileSync(maintenancePath(root, args.plan), 'utf8')));
    if (maintenancePlanDigest(plan) !== args.confirmedDigest) throw new Error('Recorded plan digest mismatch; review and register the exact plan again');
    const owners = await createMaintenanceOwners(root);
    const receipts = await Promise.all(plan.operations.map(async (operation, index) => {
      const owner = owners.find(value => value.name === operation.owner?.name);
      if (!owner) throw new Error('Unavailable maintenance owner');
      const receipt = await owner.receipt(maintenanceOperationKey(plan, index), { readOnly: true });
      if (receipt === undefined && await owner.pending?.(operation)) throw new Error('Interrupted owner transaction requires manual recovery');
      return receipt;
    }));
    const completed = receipts.filter(receipt => receipt !== undefined).length;
    if (completed && completed !== receipts.length) throw new Error('Partial plan requires manual owner recovery; scheduling cannot replay it');
    // Refuse invalid previews before even creating a coordinator journal.
    // Apply repeats these checks, including the owners' checks under lock.
    if (!completed) await previewMaintenancePlan(plan, owners);
    let applied: MaintenanceReceipt | null = null;
    let applyError: unknown;
    let applyFailed = false;
    if (completed !== receipts.length) {
      try { applied = await applyMaintenancePlan(plan, { root, owners, confirmedDigest: args.confirmedDigest }); }
      catch (error) {
        applyFailed = true;
        applyError = error;
        if (error instanceof MaintenanceApplyError) applied = error.receipt;
      }
    }
    const verification = await verifyMaintenancePlan(plan, owners);
    if (applyFailed || applied?.partial || verification.findings.length) {
      return { exitStatus: 1, uncertain: true, summary: `Memory apply requires inspection of partial results or verification findings${applyError instanceof Error ? `: ${applyError.message}` : ''}`,
        detail: { applied, verification } };
    }
    return { exitStatus: 0, summary: applied ? 'Reviewed memory plan applied and verified' : 'Reviewed memory plan already applied and verified; no changes',
      detail: { planDigest: args.confirmedDigest, alreadyApplied: applied === null, applied, verification } };
  } catch (error) {
    return { exitStatus: 1, uncertain: true, summary: `Memory apply refused; inspect before recovery: ${error instanceof Error ? error.message : String(error)}`,
      ...(error instanceof MaintenanceApplyError ? { detail: { applied: error.receipt } } : {}) };
  }
}
