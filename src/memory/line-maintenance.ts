import { refreshMaintenanceIndexes } from './maintenance-index.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MaintenanceOperationSchema, type MaintenanceOperation } from './maintenance-contract.js';
import type { MaintenanceOwner } from './maintenance-owner.js';
import { loadMemoryRecord, type MemoryRecord } from './maintenance-record.js';

interface LineOwnerModule {
  readLineMaintenanceState(root: string): Promise<{ records: unknown[]; snapshot: string }>;
  validateLineMaintenance(root: string, operation: MaintenanceOperation): Promise<void>;
  applyLineMaintenance(root: string, operation: MaintenanceOperation, key: string,
    options: { verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean> }): Promise<unknown>;
  readLineMaintenanceReceipt(root: string, key: string): Promise<unknown | undefined>;
  pendingLineMaintenance(root: string, operation: MaintenanceOperation): Promise<boolean>;
}

/** Resolve the shipped lifecycle owner from source or compiled CLI installations. */
async function lineOwner(): Promise<LineOwnerModule> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(directory, 'agentic/code/addons/line-memory/commands/line-memory.mjs');
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href) as Promise<LineOwnerModule>;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('The line-memory lifecycle owner is unavailable');
    directory = parent;
  }
}

/** Adapter only: all durable mutations remain in line-memory's locked sidecar transaction. */
export class LineMaintenanceOwner implements MaintenanceOwner {
  readonly name = 'line-memory';
  readonly projectRoot: string;
  private readonly options: {
    verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean>;
  };

  constructor(projectRoot: string, options: {
    verifyRetrieval?: (operation: MaintenanceOperation) => Promise<boolean>;
  } = {}) {
    this.projectRoot = projectRoot;
    this.options = options;
  }

  async records(): Promise<MemoryRecord[]> {
    return (await (await lineOwner()).readLineMaintenanceState(this.projectRoot)).records.map(loadMemoryRecord);
  }

  async snapshot(): Promise<string> {
    return (await (await lineOwner()).readLineMaintenanceState(this.projectRoot)).snapshot;
  }

  async validate(operation: MaintenanceOperation): Promise<void> {
    MaintenanceOperationSchema.parse(operation);
    await (await lineOwner()).validateLineMaintenance(this.projectRoot, operation);
  }

  async apply(operation: MaintenanceOperation, key: string): Promise<unknown> {
    MaintenanceOperationSchema.parse(operation);
    const receipt = await (await lineOwner()).applyLineMaintenance(this.projectRoot, operation, key, { verifyRetrieval: operation => this.verifyRetrieval(operation) });
    await this.refreshIndex();
    return receipt;
  }

  async receipt(key: string): Promise<unknown | undefined> {
    const receipt = await (await lineOwner()).readLineMaintenanceReceipt(this.projectRoot, key);
    if (receipt !== undefined) await this.refreshIndex();
    return receipt;
  }

  private async refreshIndex(): Promise<void> {
    await refreshMaintenanceIndexes(this.projectRoot);
  }

  async pending(operation: MaintenanceOperation): Promise<boolean> {
    return (await lineOwner()).pendingLineMaintenance(this.projectRoot, operation);
  }

  async verifyRetrieval(operation: MaintenanceOperation): Promise<boolean> {
    if (operation.owner?.name !== this.name) return false;
    if (this.options.verifyRetrieval) return this.options.verifyRetrieval(operation);
    throw new Error('line-memory resident removal is unsupported: no owner-native indexed retrieval projection is available');
  }
}
