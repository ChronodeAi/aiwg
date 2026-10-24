/**
 * Guided setup plan review and apply (epic #3449 slice A4).
 *
 * A3 records answers and builds `actions[]` without writing anything outside
 * the plan file. This module owns the read-only review of a saved plan and
 * the apply engine that executes `remainingPlanActions` through injected
 * owners. The module itself writes nothing: persistence (`save`) and every
 * side effect (config writers, `use` deployment, registry, prompts) arrive
 * through the `PlanReviewIO` / `PlanApplyIO` boundaries so dry runs and unit
 * tests can prove zero-write behavior.
 *
 * Credential values are resolved only at apply time and are never stored on
 * the plan, in receipts, or in rendered output. Only the reference
 * (`env:NAME`, `file:PATH`, `stdin`) is ever rendered or persisted.
 */
import { relative, resolve, sep, isAbsolute } from 'node:path';
import { revalidateSetupPlan, remainingPlanActions } from './plan-store.js';
import type { DiscoveryInventory, Observation } from './types.js';
import { questionId, workspaceSlug } from './interview.js';
import type {
  ActionReceipt,
  ActionRevalidation,
  CredentialReference,
  PlannedAction,
  PlanValue,
  SetupPlan,
  StaleInventoryFact,
} from './plan-types.js';

/** Apply order for plan actions. Dependencies flow config -> verify -> deploy -> register. */
export const PLAN_APPLY_KIND_ORDER = [
  'configure-provider',
  'verify-provider',
  'write-project-config',
  'deploy-framework',
  'register-project',
  'record-decline',
] as const;

/**
 * Optional actions report truthfully on failure but never block core setup.
 * Integrations (framework deploys) are optional: a failing deploy must not
 * fake full success and must not prevent config/registry writes.
 */
export const OPTIONAL_PLAN_ACTION_KINDS: ReadonlySet<string> = new Set(['deploy-framework']);

export function isOptionalPlanAction(kind: string): boolean {
  return OPTIONAL_PLAN_ACTION_KINDS.has(kind);
}

export function sortPlanActionsForApply(actions: PlannedAction[]): PlannedAction[] {
  const rank = (kind: string): number => {
    const index = PLAN_APPLY_KIND_ORDER.indexOf(kind as (typeof PLAN_APPLY_KIND_ORDER)[number]);
    return index < 0 ? PLAN_APPLY_KIND_ORDER.length : index;
  };
  return [...actions].sort((a, b) => rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
}

export type PlanActionStatus = 'ready' | 'applied' | 'stale' | 'conflict' | 'needs-credential';

export interface PlanActionConflict {
  actionId: string;
  workspace: string;
  reason: 'user-file-preserved' | 'dev-install-preserved' | 'credential-unresolved';
  message: string;
}

export interface PlanActionPreview {
  id: string;
  kind: string;
  provider: string;
  workspace: string;
  scope: 'project' | 'user';
  optional: boolean;
  /** Effective destination bucket: user settings, per-workspace, integration, or verification. */
  destination: string;
  /** One-line description of the diff this action would make. */
  diff: string;
  status: PlanActionStatus;
  conflicts: PlanActionConflict[];
  stale: ActionRevalidation | undefined;
  /** Non-blocking observations (e.g. an unobserved version on a read-only verify). */
  notes: string[];
}

export interface PlanReadiness {
  /** Independent readiness axis: workspace config, provider auth surface, or integration. */
  area: 'workspace' | 'provider' | 'integration';
  workspace: string;
  provider: string;
  ready: boolean;
  detail: string;
}

export interface PlanReview {
  schema: 'aiwg.setup.review.v1';
  planId: string;
  generatedAt: string;
  installMode: string;
  actions: PlanActionPreview[];
  readiness: PlanReadiness[];
  /** Deferred interview questions, asked first next session. */
  deferred: string[];
  /** Unanswered questions still gating actions. */
  unanswered: string[];
  stale: ActionRevalidation[];
  conflicts: PlanActionConflict[];
}

export interface PlanReviewIO {
  exists(path: string): Promise<boolean>;
  installMode(): Promise<{ devMode: boolean; method: string; root: string }>;
}

/** Filesystem-backed review IO. Reads only; used by the CLI (never by dry-run tests). */
export function defaultPlanReviewIO(): PlanReviewIO {
  return {
    async exists(path: string): Promise<boolean> {
      const { stat } = await import('node:fs/promises');
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async installMode(): Promise<{ devMode: boolean; method: string; root: string }> {
      try {
        const { inspectInstallation } = await import('../installation/manager.mjs');
        const status = inspectInstallation({ createIfMissing: false } as never) as {
          identity?: { method?: string; runMode?: string; root?: string } | null;
          actualMethod?: string;
          frameworkRoot?: string;
        };
        const method = status.identity?.method ?? status.actualMethod ?? 'unknown';
        return {
          devMode: status.identity?.runMode === 'development' || method === 'source',
          method,
          root: status.frameworkRoot ?? '',
        };
      } catch {
        return { devMode: false, method: 'unknown', root: '' };
      }
    },
  };
}

/** The credential-source answer recorded for a workspace/provider pair, if any. */
export function credentialReferenceFor(
  plan: SetupPlan,
  workspace: string,
  provider: string,
): CredentialReference | undefined {
  const projectRoot = projectRootForWorkspace(plan, workspace);
  const slug = projectRoot ? workspaceSlug(projectRoot) : undefined;
  const candidates = Object.entries(plan.answers).filter(([id]) =>
    id.startsWith('locations.credential-source.') && id.endsWith(`.${provider}`));
  const scoped = slug ? candidates.find(([id]) => id.includes(`.ws-${slug}.`)) : undefined;
  const value = (scoped ?? candidates[0])?.[1]?.value;
  return isCredentialReference(value) ? value : undefined;
}

function isCredentialReference(value: PlanValue | undefined): value is CredentialReference {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === 'credential-ref';
}

/** The inventory project owning a workspace (workspaces may be selected package roots). */
export function projectRootForWorkspace(plan: SetupPlan, workspace: string): string | undefined {
  if (plan.inventory.projects.some(project => project.root === workspace)) return workspace;
  return plan.inventory.projects.find(project => project.packageRoots.includes(workspace))?.root;
}

function answerFor(plan: SetupPlan, workspace: string, block: string, topic: string, provider?: string): PlanValue | undefined {
  const projectRoot = projectRootForWorkspace(plan, workspace) ?? workspace;
  return plan.answers[questionId(block as never, topic, projectRoot, provider)]?.value;
}

function configPathOf(action: PlannedAction): string | undefined {
  return action.dependsOn.find(fact => fact.kind === 'path')?.path;
}

/** Provider config path from the sibling configure-provider action, if the plan recorded one. */
export function configPathFor(plan: SetupPlan, workspace: string, provider: string): string | undefined {
  return plan.actions.find(action => action.workspace === workspace && action.provider === provider &&
    action.kind === 'configure-provider')?.dependsOn.find(fact => fact.kind === 'path')?.path;
}

/** Effective destination bucket for one action. */
export function destinationOf(action: PlannedAction): string {
  switch (action.kind) {
    case 'configure-provider':
      return action.scope === 'user'
        ? `user settings (${action.provider} user config)`
        : `per-workspace ${action.workspace} (${action.provider} config)`;
    case 'verify-provider':
      return `verification only (${action.provider} in ${action.workspace}; no writes)`;
    case 'write-project-config':
      return `per-workspace ${action.workspace} (.aiwg/aiwg.config)`;
    case 'deploy-framework':
      return `integration (framework deployment for ${action.provider} in ${action.workspace})`;
    case 'register-project':
      return `integration (project registry entry for ${action.workspace})`;
    case 'record-decline':
      return `per-workspace ${action.workspace} (decline marker)`;
    default:
      return `per-workspace ${action.workspace} (${action.kind})`;
  }
}

/** One-line diff description for one action. Reads answers only; never touches disk. */
export function diffOfAction(plan: SetupPlan, action: PlannedAction): string {
  switch (action.kind) {
    case 'configure-provider': {
      const path = configPathOf(action);
      const reference = credentialReferenceFor(plan, action.workspace, action.provider);
      // Hyphenated on purpose: the plan redaction gate rejects
      // `credential <value>` phrasing anywhere in persisted content.
      // configure-provider writes nothing: an existing file is preserved and
      // a missing one is owned by deploy-framework (`aiwg use`).
      const credential = reference ? `credential-ref ${reference.source}:${reference.name}` : 'no credential-reference recorded';
      return path
        ? `preserve ${path} if present, no writes (${credential}); provider files owned by deploy-framework`
        : `no writes for ${action.provider} config (${credential}); provider files owned by deploy-framework`;
    }
    case 'verify-provider':
      return `read back ${action.provider} installation and config; no writes, no secrets`;
    case 'write-project-config': {
      const providers = plan.actions
        .filter(other => other.workspace === action.workspace && other.kind === 'configure-provider')
        .map(other => other.provider);
      return `merge providers [${providers.join(', ') || 'none'}] and policy answers into ${action.workspace}/.aiwg/aiwg.config`;
    }
    case 'deploy-framework': {
      const intent = answerFor(plan, action.workspace, 'intent', 'use');
      return `deploy ${typeof intent === 'string' ? intent : 'suggested'} framework for ${action.provider} via the aiwg use path`;
    }
    case 'register-project':
      return `register ${action.workspace} in the project memory registry`;
    case 'record-decline':
      return `record explicit decline in ${action.workspace} config (no activation)`;
    default:
      return `apply ${action.kind} for ${action.provider} in ${action.workspace}`;
  }
}

/**
 * Split revalidation changes into blocking vs advisory for one action.
 *
 * `verify-provider` is a read-only qualification: it re-observes the tool
 * from fresh inventory at apply time (the owner refuses when the tool is
 * not installed). An `unobserved` version (unknown at plan and apply time,
 * the normal presence-only discovery case) therefore does not invalidate
 * the check — it rides along as an advisory note. Every other reason, and
 * every other action kind, stays blocking: writes are never applied on
 * stale facts.
 */
function splitStale(action: PlannedAction, stale: ActionRevalidation | undefined): {
  blocking: ActionRevalidation | undefined;
  advisory: StaleInventoryFact[];
} {
  if (!stale) return { blocking: undefined, advisory: [] };
  if (action.kind !== 'verify-provider' && action.kind !== 'configure-provider') return { blocking: stale, advisory: [] };
  if (action.kind === 'configure-provider') {
    // configure-provider writes nothing, so the recorded provider path is
    // informational only: the owner re-checks the filesystem at apply time
    // (preserving an existing file, deferring a missing one to
    // deploy-framework). Path-fact changes therefore never block it, while
    // tool/layout facts still do.
    const blocking = stale.changes.filter(change => change.fact.kind !== 'path');
    return { blocking: blocking.length > 0 ? { ...stale, changes: blocking } : undefined, advisory: [] };
  }
  const blocking = stale.changes.filter(change => change.reason !== 'unobserved');
  const advisory = stale.changes.filter(change => change.reason === 'unobserved');
  return { blocking: blocking.length > 0 ? { ...stale, changes: blocking } : undefined, advisory };
}

function isUnder(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel));
}

async function detectConflicts(
  action: PlannedAction,
  install: { devMode: boolean; method: string; root: string },
): Promise<PlanActionConflict[]> {
  const conflicts: PlanActionConflict[] = [];
  // configure-provider needs no conflict gate: it writes nothing. An existing
  // provider file is preserved (applied, left untouched) and a missing one is
  // owned by deploy-framework, which `PLAN_APPLY_KIND_ORDER` runs after every
  // configure-provider. The owner re-checks the filesystem at apply time.
  if (action.kind === 'deploy-framework' && install.devMode && isUnder(install.root, action.workspace)) {
    conflicts.push({
      actionId: action.id,
      workspace: action.workspace,
      reason: 'dev-install-preserved',
      message: `Dev-mode/source install preserved: ${action.workspace} lives under the ${install.method} install root ${install.root}; deployment refuses to overwrite it.`,
    });
  }
  return conflicts;
}

/** Read-only review: revalidate facts, compute diffs, destinations, conflicts, and readiness. Writes nothing. */
export async function reviewGuidedPlan(plan: SetupPlan, fresh: DiscoveryInventory, io: PlanReviewIO, now?: string): Promise<PlanReview> {
  const stale = revalidateSetupPlan(plan, fresh);
  const staleByAction = new Map(stale.map(entry => [entry.actionId, entry]));
  const appliedIds = new Set<string>();
  for (const receipt of plan.receipts) {
    for (const [id, result] of Object.entries(receipt.actions)) {
      if (result.status === 'applied') appliedIds.add(id);
    }
  }
  const install = await io.installMode();
  const previews: PlanActionPreview[] = [];
  for (const action of plan.actions) {
    const { blocking: actionStale, advisory } = splitStale(action, staleByAction.get(action.id));
    const conflicts = await detectConflicts(action, install);
    const reference = action.kind === 'configure-provider'
      ? credentialReferenceFor(plan, action.workspace, action.provider)
      : undefined;
    const needsCredential = action.kind === 'configure-provider' && !reference;
    const status: PlanActionStatus = appliedIds.has(action.id)
      ? 'applied'
      : actionStale
        ? 'stale'
        : conflicts.length > 0
          ? 'conflict'
          : needsCredential
            ? 'needs-credential'
            : 'ready';
    previews.push({
      id: action.id,
      kind: action.kind,
      provider: action.provider,
      workspace: action.workspace,
      scope: action.scope,
      optional: isOptionalPlanAction(action.kind),
      destination: destinationOf(action),
      diff: status === 'applied' ? `already applied '${action.id}'` : diffOfAction(plan, action),
      status,
      conflicts,
      stale: actionStale,
      notes: advisory.map(change => `${describeFact(change.fact)} is unobserved (unknown at plan and apply time); the read-only check re-observes it from fresh inventory.`),
    });
  }
  const readiness: PlanReadiness[] = [];
  const byPair = new Map<string, PlanActionPreview[]>();
  for (const preview of previews) {
    const key = `${preview.workspace}\0${preview.provider}`;
    byPair.set(key, [...(byPair.get(key) ?? []), preview]);
  }
  for (const [key, group] of byPair) {
    const [workspace, provider] = key.split('\0');
    const axis = (area: PlanReadiness['area'], members: PlanActionPreview[]): void => {
      const stuck = members.filter(preview => preview.status === 'stale' || preview.status === 'conflict' || preview.status === 'needs-credential');
      readiness.push({
        area,
        workspace,
        provider,
        ready: stuck.length === 0,
        detail: stuck.length === 0
          ? `${area} ready (${members.filter(member => member.status === 'applied' || member.status === 'ready').length}/${members.length} actions ready or applied)`
          : `${area} blocked: ${stuck.map(member => `'${member.id}' is ${member.status}`).join(', ')}`,
      });
    };
    const kinds = (list: string[]): PlanActionPreview[] => group.filter(preview => list.includes(preview.kind));
    // Axes with no member actions report ready with a zero denominator.
    axis('workspace', kinds(['write-project-config', 'register-project', 'record-decline']));
    axis('provider', kinds(['configure-provider', 'verify-provider']));
    axis('integration', kinds(['deploy-framework']));
  }
  const deferred = plan.unresolvedChoices.filter(choice => choice.deferredAt).map(choice => choice.questionId);
  const unanswered = plan.unresolvedChoices
    .filter(choice => !Object.hasOwn(plan.answers, choice.questionId))
    .map(choice => choice.questionId);
  return {
    schema: 'aiwg.setup.review.v1',
    planId: plan.id,
    generatedAt: now ?? new Date().toISOString(),
    installMode: install.devMode ? `dev (${install.method})` : install.method,
    actions: previews,
    readiness,
    deferred,
    unanswered,
    stale,
    conflicts: previews.flatMap(preview => preview.conflicts),
  };
}

/** Render the human-readable review: per workspace and provider. */
export function renderHumanReview(review: PlanReview): string {
  const lines: string[] = [`Guided setup plan '${review.planId}' (install: ${review.installMode})`, ''];
  const byWorkspace = new Map<string, PlanActionPreview[]>();
  for (const action of review.actions) byWorkspace.set(action.workspace, [...(byWorkspace.get(action.workspace) ?? []), action]);
  for (const [workspace, actions] of [...byWorkspace].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`workspace ${workspace}`);
    const byProvider = new Map<string, PlanActionPreview[]>();
    for (const action of actions) byProvider.set(action.provider, [...(byProvider.get(action.provider) ?? []), action]);
    for (const [provider, group] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  provider ${provider}`);
      for (const preview of group) {
        const flag = preview.optional ? ' (optional)' : '';
        lines.push(`    [${preview.status}] ${preview.id} (${preview.kind})${flag}`);
        lines.push(`      destination: ${preview.destination}`);
        lines.push(`      diff: ${preview.diff}`);
        for (const conflict of preview.conflicts) lines.push(`      conflict: ${conflict.message}`);
        for (const change of preview.stale?.changes ?? []) {
          lines.push(`      stale: ${describeFact(change.fact)} is ${change.reason}; re-run discovery or re-answer before applying.`);
        }
        for (const note of preview.notes) lines.push(`      note: ${note}`);
      }
    }
  }
  lines.push('');
  lines.push('readiness');
  for (const entry of review.readiness) {
    lines.push(`  [${entry.ready ? 'ready' : 'blocked'}] ${entry.area} ${entry.workspace}${entry.provider === 'shared' ? '' : ` / ${entry.provider}`}: ${entry.detail}`);
  }
  if (review.deferred.length > 0) {
    lines.push('');
    lines.push(`deferred questions (asked first next session): ${review.deferred.join(', ')}`);
  }
  if (review.unanswered.length > 0) {
    lines.push(`unanswered questions: ${review.unanswered.join(', ')}`);
  }
  return lines.join('\n');
}

function describeFact(fact: ActionRevalidation['changes'][number]['fact']): string {
  if (fact.kind === 'tool') return `tool ${fact.executable}.${fact.field}`;
  if (fact.kind === 'project') return `project ${fact.root}.${fact.field}`;
  return `path ${fact.path}`;
}

function formatFactValue(value: PlanValue | Observation | undefined): string {
  if (value === undefined) return 'unknown';
  return JSON.stringify(value) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Credentials: resolved only at apply time, never persisted or rendered.
// ---------------------------------------------------------------------------

export interface CredentialIO {
  readEnv(name: string): string | undefined;
  readCredentialFile(path: string): Promise<string>;
  /** Interactive prompt for stdin-at-apply. Absent when headless. Rendered label only; the value never reaches output. */
  promptCredential?(label: string): Promise<string | null>;
}

export type CredentialResolution =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** Resolve a credential reference to its value. The value must stay in memory only. */
export async function resolveCredential(
  reference: CredentialReference,
  provider: string,
  io: CredentialIO,
): Promise<CredentialResolution> {
  // Every message below is receipt-persisted, so wording stays hyphenated:
  // the plan redaction gate rejects `credential <value>` phrasing.
  if (reference.source === 'env') {
    const value = io.readEnv(reference.name);
    if (!value) {
      return { ok: false, message: `Credential-source env:${reference.name} for ${provider} is not set; export it or re-answer locations.credential-source.` };
    }
    return { ok: true, value };
  }
  if (reference.source === 'file') {
    try {
      const value = (await io.readCredentialFile(reference.name)).trim();
      if (!value) return { ok: false, message: `Credential-file ${reference.name} for ${provider} is empty; fix the file or re-answer locations.credential-source.` };
      return { ok: true, value };
    } catch {
      return { ok: false, message: `Credential-file ${reference.name} for ${provider} is unreadable; fix the path or re-answer locations.credential-source.` };
    }
  }
  if (!io.promptCredential) {
    return { ok: false, message: `Stdin-at-apply input for ${provider} needs an interactive terminal; re-run interactively or re-answer with env:/file:.` };
  }
  const value = await io.promptCredential(`Enter ${provider} credential (input is not stored): `);
  if (!value) return { ok: false, message: `No stdin-at-apply input given for ${provider}; the action stays eligible for a later run.` };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Apply engine.
// ---------------------------------------------------------------------------

export interface PlanActionOwnerInput {
  action: PlannedAction;
  /** Resolved credential reference (shape only). The secret value is intentionally absent. */
  credential?: CredentialReference;
  /** Credential was readable at apply time. */
  credentialPresent?: boolean;
}

export interface PlanApplyOwners {
  configureProvider(input: PlanActionOwnerInput & { configPath: string | undefined }): Promise<string>;
  verifyProvider(input: PlanActionOwnerInput): Promise<string>;
  writeProjectConfig(input: PlanActionOwnerInput): Promise<string>;
  deployFramework(input: PlanActionOwnerInput & { intent: PlanValue | undefined }): Promise<string>;
  registerProject(input: PlanActionOwnerInput): Promise<string>;
  recordDecline(input: PlanActionOwnerInput): Promise<string>;
}

export interface PlanApplyIO extends PlanReviewIO, CredentialIO {
  now(): string;
  /** Persists receipts (the only write apply performs, via the plan store owner). */
  save(plan: SetupPlan): Promise<void>;
  owners: PlanApplyOwners;
}

export interface AppliedActionResult {
  actionId: string;
  kind: string;
  workspace: string;
  provider: string;
  optional: boolean;
  status: 'applied' | 'failed' | 'skipped';
  message: string;
}

export interface PlanApplyResult {
  schema: 'aiwg.setup.apply.v1';
  planId: string;
  generatedAt: string;
  results: AppliedActionResult[];
  /** success: everything applied. partial: core applied, optional failed/skipped. failure: core failed/skipped. */
  classification: 'success' | 'partial' | 'failure';
  exitCode: number;
  message: string;
}

function receiptFor(plan: SetupPlan, action: PlannedAction, status: ActionReceipt['status'], message: string | undefined, now: string): SetupPlan {
  const next: SetupPlan = { ...plan, updatedAt: now, receipts: plan.receipts.map(receipt => ({ ...receipt, actions: { ...receipt.actions } })) };
  let workspace = next.receipts.find(receipt => receipt.workspace === action.workspace);
  if (!workspace) {
    workspace = { workspace: action.workspace, actions: {} };
    next.receipts.push(workspace);
  }
  workspace.actions[action.id] = { status, startedAt: now, completedAt: now, ...(message ? { message } : {}) };
  return next;
}

/**
 * Apply remaining actions in dependency order through the injected owners.
 * Stale/unobserved facts are refused (re-ask or re-run discovery), never
 * applied blindly. Failed and skipped actions stay eligible for a later run:
 * only `applied` receipts leave `remainingPlanActions`.
 */
export async function applyGuidedPlan(plan: SetupPlan, fresh: DiscoveryInventory, io: PlanApplyIO): Promise<{ plan: SetupPlan; result: PlanApplyResult }> {
  const staleByAction = new Map(revalidateSetupPlan(plan, fresh).map(entry => [entry.actionId, entry]));
  const install = await io.installMode();
  let current = plan;
  const results: AppliedActionResult[] = [];
  for (const action of sortPlanActionsForApply(remainingPlanActions(plan))) {
    const record = async (status: 'applied' | 'failed' | 'skipped', message: string): Promise<void> => {
      results.push({ actionId: action.id, kind: action.kind, workspace: action.workspace,
        provider: action.provider, optional: isOptionalPlanAction(action.kind), status, message });
      current = receiptFor(current, action, status, message, io.now());
      await io.save(current);
    };
    const { blocking: stale, advisory } = splitStale(action, staleByAction.get(action.id));
    const conflicts = await detectConflicts(action, install);
    if (conflicts.length > 0) {
      await record('skipped', conflicts[0].message);
      continue;
    }
    if (stale) {
      const first = stale.changes[0];
      await record('skipped', `Refused '${action.id}': ${describeFact(first.fact)} is ${first.reason} (was ${formatFactValue(first.before)}, now ${formatFactValue(first.after)}); re-run discovery or re-answer before applying.`);
      continue;
    }
    const advisoryNote = advisory.length > 0
      ? ` (note: ${advisory.map(change => `${describeFact(change.fact)} unobserved; qualified from fresh inventory`).join(', ')})`
      : '';
    if (action.kind === 'configure-provider') {
      const reference = credentialReferenceFor(current, action.workspace, action.provider);
      if (!reference) {
        await record('skipped', `Refused '${action.id}': no credential-reference recorded for ${action.provider}; re-answer locations.credential-source first.`);
        continue;
      }
      const resolved = await resolveCredential(reference, action.provider, io);
      if (!resolved.ok) {
        await record('skipped', `Refused '${action.id}': ${resolved.message}`);
        continue;
      }
      // The secret value stays in this scope only: owners receive the
      // reference shape plus a presence bit, never the value.
      try {
        const message = await io.owners.configureProvider({ action, configPath: configPathOf(action),
          credential: reference, credentialPresent: true });
        await record('applied', message);
      } catch (error) {
        await record('failed', error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    try {
      const message = action.kind === 'verify-provider'
        ? await io.owners.verifyProvider({ action })
        : action.kind === 'write-project-config'
          ? await io.owners.writeProjectConfig({ action })
          : action.kind === 'deploy-framework'
            ? await io.owners.deployFramework({ action, intent: answerFor(current, action.workspace, 'intent', 'use') })
            : action.kind === 'register-project'
              ? await io.owners.registerProject({ action })
              : await io.owners.recordDecline({ action });
      await record('applied', `${message}${advisoryNote}`);
    } catch (error) {
      await record('failed', error instanceof Error ? error.message : String(error));
    }
  }
  const core = results.filter(result => !result.optional);
  const coreBad = core.filter(result => result.status !== 'applied');
  const optionalBad = results.filter(result => result.optional && result.status !== 'applied');
  const classification = coreBad.length > 0 ? 'failure' : optionalBad.length > 0 ? 'partial' : 'success';
  const summary = classification === 'success'
    ? `Applied ${results.length} action(s) from plan '${plan.id}'.`
    : classification === 'partial'
      ? `Partial success: core setup applied, ${optionalBad.length} optional action(s) did not: ${optionalBad.map(result => `'${result.actionId}' ${result.status} (${result.message})`).join('; ')}.`
      : `Setup incomplete: ${coreBad.length} core action(s) did not apply: ${coreBad.map(result => `'${result.actionId}' ${result.status} (${result.message})`).join('; ')}.`;
  return { plan: current, result: {
    schema: 'aiwg.setup.apply.v1',
    planId: plan.id,
    generatedAt: io.now(),
    results,
    classification,
    exitCode: classification === 'success' ? 0 : 1,
    message: summary,
  } };
}
