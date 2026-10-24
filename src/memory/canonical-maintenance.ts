import { refreshMaintenanceIndexes } from './maintenance-index.js';
import { CanonicalContextRepository, canonicalMemoryRecord } from './canonical-context.js';
import type { MaintenanceOperation } from './maintenance-contract.js';
import type { MaintenanceOwner } from './maintenance-owner.js';
import type { MemoryRecord } from './maintenance-record.js';

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

  async receipt(key: string): Promise<unknown | undefined> {
    const receipt = this.repository.maintenanceReceipt(key);
    if (receipt !== undefined) await this.refreshIndex();
    return receipt;
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
