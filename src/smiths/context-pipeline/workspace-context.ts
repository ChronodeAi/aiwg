// Public facade for the focused context/deployment owners.
export { auditWorkspaceContext, shouldSkipContextWalkDir } from './workspace-audit.js';
export {
  PROVIDER_BOOTSTRAP_HEADING,
  buildProviderBootstrapBlock,
  buildProviderBootstrapFile,
  dedupeProviderBootstrap,
  registerProviderContext,
} from './workspace-bootstrap.js';
export {
  PROJECT_EXTRACTION_END,
  PROJECT_EXTRACTION_START,
  PROVIDER_BOOTSTRAP_END,
  PROVIDER_BOOTSTRAP_START,
  RESIDENT_MEMORY_END,
  RESIDENT_MEMORY_START,
  WORKSPACE_MANAGED_END,
  WORKSPACE_MANAGED_START,
  WORKSPACE_OPERATOR_END,
  WORKSPACE_OPERATOR_START,
  WORKSPACE_SIGNATURE,
} from './workspace-context-shared.js';
export { diagnoseWorkspaceContext, providerContextContract, workspaceLinkedFiles } from './workspace-doctor.js';
export {
  BOOTSTRAP_AUTHORITY_SIGNATURE,
  WORKSPACE_PRECEDENCE_SIGNATURE,
  WORKSPACE_PRECEDENCE_SUPERSEDED,
  buildWorkspaceDocument,
  buildWorkspaceManagedBlock,
  ensureWorkspaceContext,
  providerCopiesStatus,
} from './workspace-document.js';
export { extractExistingProjectContext } from './workspace-extraction.js';
export { migrateWorkspaceContext, rollbackWorkspaceContext } from './workspace-migration.js';
export type {
  WorkspaceContextEnsureResult,
  WorkspaceContextSource,
  WorkspaceDirectiveOverlap,
  WorkspaceDirectiveConflict,
  WorkspaceContextAudit,
  WorkspaceContextRouting,
  ExistingProjectContext,
  WorkspaceMigrationManifest,
  WorkspaceMigrationResult,
  WorkspaceContextDiagnostic,
} from './workspace-context-shared.js';
