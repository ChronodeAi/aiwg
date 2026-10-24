import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { sha256 } from './context-pack.js';
import { MaintenancePlanSchema, MaintenanceReceiptSchema, validateMaintenancePlan, type MaintenanceOperation, type MaintenancePlan, type MaintenanceReceipt } from './maintenance-contract.js';
import type { MaintenanceOwner } from './maintenance-owner.js';

export function maintenancePlanDigest(plan: MaintenancePlan): string {
  return sha256(JSON.stringify(MaintenancePlanSchema.parse(plan)));
}
export function maintenanceOperationKey(plan: MaintenancePlan, index: number): string {
  return sha256(`${maintenancePlanDigest(plan)}:${index}`);
}

/** Reject paths escaping through either spelling or an existing symlink. */
export function maintenancePath(root: string, path: string): string {
  const base = realpathSync(root);
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new Error('Maintenance paths must remain inside the workspace');
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  if (actual !== base && !actual.startsWith(`${base}${sep}`)) throw new Error('Maintenance path traverses outside the workspace');
  return target;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function selectOwner(operation: MaintenanceOperation, owners: readonly MaintenanceOwner[]): MaintenanceOwner {
  if (!operation.owner || !operation.review) throw new Error('Executable maintenance requires an owner preview and explicit reviewer');
  const owner = owners.find(value => value.name === operation.owner!.name);
  if (!owner) throw new Error(`Unavailable maintenance owner: ${operation.owner.name}`);
  if (operation.scope !== 'project') throw new Error('These lifecycle owners support explicit project scope only');
  if (operation.sessionEffect !== 'next-session') throw new Error('Durable owner edits require next-session effect; current sessions are unchanged');
  return owner;
}

export function removesResident(operation: MaintenanceOperation): boolean {
  return operation.from.placement === 'resident'
    && (operation.to.placement !== 'resident' || operation.to.lifecycle !== 'active');
}

function checkOwnerUniqueness(plan: MaintenancePlan): void {
  const names = plan.operations.map(op => op.owner?.name);
  if (new Set(names).size !== names.length) {
    throw new Error('One exact snapshot operation per owner is supported per plan; review a new plan for the next revision');
  }
}

/** Read-only review. A plan file is the only output written by the CLI planner. */
export async function previewMaintenancePlan(input: unknown, owners: readonly MaintenanceOwner[]): Promise<MaintenancePlan> {
  const plan = MaintenancePlanSchema.parse(input);
  if (!plan.operations.length) throw new Error('An executable plan requires at least one operation');
  checkOwnerUniqueness(plan);
  for (const operation of plan.operations) {
    const owner = selectOwner(operation, owners);
    if (!await owner.pending?.(operation)) {
      validateMaintenancePlan({ ...plan, operations: [operation] }, await owner.records(), { retirementBasis: operation.review!.retirementBasis });
    }
    await owner.validate(operation);
    if (removesResident(operation) && !await verifyMaintenanceRetrieval(operation, owners)) {
      throw new Error('Indexed retrieval must be verified before removing resident content');
    }
  }
  // Also validate overlap between a target and another operation's merge inputs.
  const inputs = plan.operations.flatMap(op => [op.target.id, ...(op.related ?? []).map(value => value.id)]);
  if (new Set(inputs).size !== inputs.length) throw new Error('Maintenance operations overlap');
  return plan;
}

export async function verifyMaintenanceRetrieval(operation: MaintenanceOperation, owners: readonly MaintenanceOwner[]): Promise<boolean> {
  for (const owner of owners) if (owner.verifyRetrieval && await owner.verifyRetrieval(operation)) return true;
  return false;
}

export class MaintenanceApplyError extends Error {
  readonly receipt: MaintenanceReceipt;
  constructor(message: string, receipt: MaintenanceReceipt) { super(message); this.name = 'MaintenanceApplyError'; this.receipt = receipt; }
}

type OwnerJournalEntry = { operationId: string; owner: string; receipt: unknown };

/** Per-owner commits remain authoritative; this journal records progress, never memory bodies. */
export async function applyMaintenancePlan(input: unknown, options: {
  root: string;
  owners: readonly MaintenanceOwner[];
  confirmedDigest: string;
  afterOwner?: (index: number) => void | Promise<void>;
}): Promise<MaintenanceReceipt> {
  const plan = MaintenancePlanSchema.parse(input);
  const digest = maintenancePlanDigest(plan);
  if (options.confirmedDigest !== digest) throw new Error('Apply requires confirmation of the exact plan digest');
  if (!plan.operations.length) throw new Error('An executable plan requires at least one operation');
  checkOwnerUniqueness(plan);
  const selected = plan.operations.map(op => selectOwner(op, options.owners));
  const journalPath = maintenancePath(options.root, `.aiwg/memory/maintenance/${digest.replace(':', '_')}.json`);
  const lockPath = maintenancePath(options.root, '.aiwg/memory/maintenance/.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  let release: () => Promise<void>;
  try { release = await acquireDirectoryLock(lockPath, { timeoutMs: 0, reclaimDeadOwner: true }); }
  catch (error) { throw new Error(`Concurrent maintenance plan owns the workspace lock: ${error instanceof Error ? error.message : String(error)}`); }
  const resumed = existsSync(journalPath);
  const entries: OwnerJournalEntry[] = [];
  const keys = plan.operations.map((_, index) => maintenanceOperationKey(plan, index));
  const receipt = (): MaintenanceReceipt => {
    const completed = entries.map(entry => entry.operationId);
    const pending = keys.filter(key => !completed.includes(key));
    return MaintenanceReceiptSchema.parse({ schemaVersion: 'aiwg.maintenance-receipt.v1', planDigest: digest,
      ownerReceipts: entries, ...(pending.length ? { partial: { completed, pending } } : {}),
      ...(resumed ? { resumedFrom: journalPath } : {}),
    });
  };
  try {
    if (resumed) {
      const prior = MaintenanceReceiptSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
      if (prior.planDigest !== digest) throw new Error('Maintenance journal belongs to a different plan');
    }
    // Recover commits even if interruption happened before the coordinator journal write.
    for (let index = 0; index < selected.length; index++) {
      const committed = await selected[index].receipt(keys[index]);
      if (committed !== undefined) entries.push({ operationId: keys[index], owner: selected[index].name, receipt: committed });
    }
    const pending = plan.operations.filter((_, index) => !entries.some(entry => entry.operationId === keys[index]));
    if (pending.length) await previewMaintenancePlan({ ...plan, operations: pending }, options.owners);
    writeAtomic(journalPath, receipt());
    for (let index = 0; index < selected.length; index++) {
      if (entries.some(entry => entry.operationId === keys[index])) continue;
      const operation = plan.operations[index];
      if (removesResident(operation) && !await verifyMaintenanceRetrieval(operation, options.owners)) throw new Error('Indexed retrieval is unavailable');
      const result = await selected[index].apply(operation, keys[index]);
      await options.afterOwner?.(index);
      entries.push({ operationId: keys[index], owner: selected[index].name, receipt: result });
      writeAtomic(journalPath, receipt());
    }
    return receipt();
  } catch (error) {
    // A thrown remote refresh or interruption can follow a committed local owner mutation.
    for (let index = 0; index < selected.length; index++) {
      if (entries.some(entry => entry.operationId === keys[index])) continue;
      try {
        const committed = await selected[index].receipt(keys[index]);
        if (committed !== undefined) entries.push({ operationId: keys[index], owner: selected[index].name, receipt: committed });
      } catch { /* Unavailable owner remains pending; never claim its success. */ }
    }
    const partial = receipt();
    writeAtomic(journalPath, partial);
    throw new MaintenanceApplyError(error instanceof Error ? error.message : String(error), partial);
  } finally { await release(); }
}
