import type { DiscoveryInventory, Observation, ProjectInventoryEntry, ToolInventoryEntry } from './types.js';

export const SETUP_PLAN_SCHEMA_VERSION = 1 as const;

export type AnswerSource = 'explicit-flag' | 'existing-setting' | 'interview' | 'default' | 'discovered';

/** A locator only. The installer resolves it at apply time, never while planning. */
export interface CredentialReference {
  kind: 'credential-ref';
  source: 'env' | 'file' | 'stdin-at-apply';
  name: string;
}

/** JSON values only; secret-bearing values are refused by the store. */
export type PlanValue = string | number | boolean | null | PlanValue[] | { [key: string]: PlanValue } | CredentialReference;

export interface SetupAnswer<T extends PlanValue = PlanValue> {
  value: T;
  source: AnswerSource;
  answeredAt: string;
}

export interface SetupRecommendation {
  questionId: string;
  value: PlanValue;
  reason: string;
}

export interface UnresolvedChoice {
  questionId: string;
  options: Array<{ label: string; value: PlanValue }>;
  default: PlanValue;
  whyItMatters: string;
}

/** Selectors into the plan's inventory snapshot, not assertions of readiness. */
export type InventoryFact =
  | { kind: 'project'; root: ProjectInventoryEntry['root']; field: keyof ProjectInventoryEntry }
  | { kind: 'tool'; executable: ToolInventoryEntry['executable']; field: keyof ToolInventoryEntry }
  | { kind: 'path'; workspace: ProjectInventoryEntry['root']; path: string };

export interface PlannedAction {
  id: string;
  workspace: ProjectInventoryEntry['root'];
  provider: string;
  scope: 'project' | 'user';
  /** The apply slice defines the supported operations. */
  kind: string;
  dependsOn: InventoryFact[];
}

export interface ActionReceipt {
  status: 'applied' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  message?: string;
}

export interface WorkspaceReceipt {
  workspace: ProjectInventoryEntry['root'];
  actions: Record<string, ActionReceipt>;
}

export interface SetupPlan {
  schemaVersion: typeof SETUP_PLAN_SCHEMA_VERSION;
  id: string;
  inventoryId: string;
  createdAt: string;
  updatedAt: string;
  /** Question IDs must be stable and include workspace/provider scope when needed. */
  answers: Record<string, SetupAnswer>;
  recommendations: SetupRecommendation[];
  unresolvedChoices: UnresolvedChoice[];
  actions: PlannedAction[];
  receipts: WorkspaceReceipt[];
  inventory: DiscoveryInventory;
}

export interface StaleInventoryFact {
  fact: InventoryFact;
  reason: 'path-missing' | 'tool-not-installed' | 'version-changed' | 'fact-changed' | 'unobserved';
  before: PlanValue | Observation | undefined;
  after: PlanValue | Observation | undefined;
}

export interface ActionRevalidation {
  actionId: PlannedAction['id'];
  workspace: ProjectInventoryEntry['root'];
  changes: StaleInventoryFact[];
}
