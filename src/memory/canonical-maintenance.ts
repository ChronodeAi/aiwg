import { refreshMaintenanceIndexes } from './maintenance-index.js';
import { CanonicalContextRepository, canonicalMemoryRecord } from './canonical-context.js';
import type { MaintenanceOperation } from './maintenance-contract.js';
import type { MaintenanceOwner } from './maintenance-owner.js';
import type { MemoryRecord } from './maintenance-record.js';
import { sha256 } from './context-pack.js';
import { isDeepStrictEqual } from 'node:util';

/** Routes reviewed placement and lifecycle changes through the canonical owner. */
export class CanonicalMaintenanceOwner implements MaintenanceOwner {
  readonly name = 'compound-memory';
  private readonly repository: CanonicalContextRepository;
  private readonly projectRoot: string;
  private readonly options: { verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean> };
  constructor(projectRoot: string, options: {
    verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean>;
  } = {}) {
    this.options = options;
    this.projectRoot = projectRoot;
    this.repository = new CanonicalContextRepository(projectRoot);
  }

  async records(): Promise<MemoryRecord[]> {
    return Object.values(this.repository.read().entries).map(canonicalMemoryRecord);
  }

  async snapshot(): Promise<string> { return this.repository.snapshot(); }

  async validate(operation: MaintenanceOperation): Promise<void> {
    this.repository.previewMaintenance(operation);
  }

  async apply(operation: MaintenanceOperation, key: string): Promise<unknown> {
    const prior = this.repository.maintenanceReceipt(key, operation);
    if (prior) { await this.refreshIndex(); return prior; }
    const preview = this.repository.previewMaintenance(operation);
    const receipt = await this.repository.confirmMaintenance({
      preview, operation, key, verifyRetrieval: operation => this.verifyRetrieval(operation),
    });
    await this.refreshIndex();
    return receipt;
  }

  async receipt(key: string, options: { readOnly?: boolean } = {}): Promise<unknown | undefined> {
    const receipt = this.repository.maintenanceReceipt(key);
    if (receipt !== undefined && !options.readOnly) await this.refreshIndex();
    return receipt;
  }

  async verifyEndState(operation: MaintenanceOperation, key: string): Promise<string[]> {
    const state = this.repository.read();
    const receipt = this.repository.maintenanceReceipt(key);
    const findings: string[] = [];
    if (receipt && (receipt.operation !== 'maintenance'
      || receipt.operationId !== sha256(JSON.stringify({ operation, snapshot: operation.owner?.snapshot })))) {
      findings.push('Owner receipt does not bind the exact reviewed operation');
    }
    for (const target of [operation.target, ...(operation.related ?? [])]) {
      const entry = Object.values(state.entries).find(item => canonicalMemoryRecord(item).id === target.id);
      if (!entry) continue;
      const history = entry.maintenance?.history;
      if (history !== undefined && !Array.isArray(history)) throw new Error('Invalid canonical maintenance history');
      const prior = history?.find(item => item.record.id === target.id && item.record.version === target.version
        && item.record.digest === target.digest && item.record.placement === operation.from.placement
        && item.record.lifecycle === operation.from.lifecycle);
      if (!prior) findings.push(`Reviewed source history is missing: ${target.id}`);
      if (operation.category && entry.maintenance?.category !== operation.category) findings.push(`Reviewed category differs: ${target.id}`);
      if (prior && !isDeepStrictEqual(prior.record.authority, canonicalMemoryRecord(entry).authority)) {
        findings.push(`Source authority changed: ${target.id}`);
      }
      if (operation.op === 'restore' && !prior?.record.tombstone) findings.push(`Recovery tombstone history is missing: ${target.id}`);
      if (canonicalMemoryRecord(entry).lifecycle !== 'active' && !entry.maintenance?.tombstone) findings.push(`Retained owner tombstone is missing: ${target.id}`);
      if (receipt && !receipt.entryIds.includes(entry.entryId)) findings.push(`Receipt omits retained source: ${target.id}`);
    }
    for (const replacement of operation.replacements ?? []) {
      const entry = Object.values(state.entries).find(item => item.key === replacement.key
        && receipt?.entryIds.includes(item.entryId));
      if (!entry || sha256(entry.value) !== sha256(replacement.value)) findings.push(`Receipt replacement differs: ${replacement.key}`);
      if (replacement.category && entry?.maintenance?.category !== replacement.category) findings.push(`Replacement category differs: ${replacement.key}`);
    }
    return findings;
  }

  private async refreshIndex(): Promise<void> {
    await refreshMaintenanceIndexes(this.projectRoot);
  }

  async verifyRetrieval(operation: MaintenanceOperation): Promise<boolean> {
    if (operation.owner?.name !== this.name) return false;
    if (this.options.verifyRetrieval) return this.options.verifyRetrieval(operation);
    throw new Error('compound-memory resident removal is unsupported: no owner-native indexed retrieval projection is available');
  }
}
