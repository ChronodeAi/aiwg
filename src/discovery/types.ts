/** Local observations only. Unknown must never be interpreted as ready. */
export type Observation = 'yes' | 'no' | 'unknown';

export interface ToolInventoryEntry {
  executable: string;
  path: string | null;
  installed: Observation;
  configured: Observation;
  authenticated: Observation;
  qualified: Observation;
  version: string | null;
  /** Discovery never executes tools; versions/readiness may be supplied from prior local evidence. */
  evidence: string[];
}

export interface ProviderFile {
  provider: string;
  path: string;
  kind: 'config' | 'context' | 'artifacts';
}

export interface ProjectInventoryEntry {
  root: string;
  sources: Array<'workspace' | 'registry' | 'selected'>;
  vcs: 'git' | 'worktree' | 'none' | 'unknown';
  layout: 'project' | 'package' | 'monorepo' | 'ambiguous';
  packageManifest: string | null;
  workspacePatterns: string[];
  /** Observed package roots only; may be partial when bounded or shallow. */
  packageRoots: string[];
  aiwg: { directory: boolean; configFile: string | null; contextFile: string | null };
  providerFiles: ProviderFile[];
}

export type DiscoveryDiagnosticCode =
  | 'depth-limit' | 'entry-limit' | 'time-limit' | 'file-limit'
  | 'inaccessible' | 'invalid-metadata' | 'symlink-skipped' | 'outside-root'
  | 'ambiguous' | 'excluded' | 'home-scan-refused';

export interface DiscoveryDiagnostic {
  code: DiscoveryDiagnosticCode;
  path: string;
  message: string;
}

export interface DiscoveryInventory {
  projects: ProjectInventoryEntry[];
  tools: ToolInventoryEntry[];
  diagnostics: DiscoveryDiagnostic[];
  limits: { maxDepth: number; maxEntries: number; timeBudgetMs: number; maxFileBytes: number };
  stats: { entriesInspected: number; elapsedMs: number; truncated: boolean };
}

export interface DiscoveryOptions {
  workspaceRoot?: string;
  /** Explicit opt-in to recursive scanning. Never populated from registry seeds. */
  roots?: readonly string[];
  /** Exact project roots from a previously read registry; false disables registry access. */
  registrySeeds?: readonly string[] | false;
  maxDepth?: number;
  /** Conservative global budget: charges filesystem operations, including failed metadata lookups. */
  maxEntries?: number;
  timeBudgetMs?: number;
  maxFileBytes?: number;
  /** Adds to the mandatory exclusions; cannot remove them. */
  excludeNames?: readonly string[];
  pathEnv?: string;
  /** Previously obtained local evidence, never an instruction to probe. */
  toolEvidence?: Readonly<Record<string, Partial<Pick<ToolInventoryEntry,
    'configured' | 'authenticated' | 'qualified' | 'version' | 'evidence'>>>>;
  /** Monotonic clock injection for deterministic deadline tests. */
  now?: () => number;
}
