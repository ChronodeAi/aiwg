import type { MemoryRecord } from './maintenance-record.js';
import type { MaintenanceOperation } from './maintenance-contract.js';

/** Lifecycle owners supply durable, exact-preview operations; the coordinator stores receipts only. */
export interface MaintenanceOwner {
  readonly name: string;
  records(): Promise<MemoryRecord[]>;
  /** Digest of every source/metadata input consumed by this owner. Read-only. */
  snapshot(): Promise<string>;
  /** Validate executable details without writing. Called again under the owner's lock. */
  validate(operation: MaintenanceOperation): Promise<void>;
  /** Idempotency key is bound to the exact plan and operation. Persist with the owner mutation. */
  apply(operation: MaintenanceOperation, key: string): Promise<unknown>;
  /** Retrieve a committed operation after interruption before coordinator journaling. */
  receipt(key: string): Promise<unknown | undefined>;
  /** Exact interrupted transaction recognized by its lifecycle owner. Never authorizes another plan. */
  pending?(operation: MaintenanceOperation): Promise<boolean>;
  /** Verify an ordinary indexed retrieval path, not just a source file's existence. */
  verifyRetrieval?(operation: MaintenanceOperation): Promise<boolean>;
}
