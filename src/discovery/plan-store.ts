import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveProjectAiwgDir, resolveProjectAiwgDirForWrite, type ProjectArtifactEnv } from '../config/project-artifacts-runtime.mjs';
import type { DiscoveryInventory, ProjectInventoryEntry } from './types.js';
import { SETUP_PLAN_SCHEMA_VERSION, type ActionRevalidation, type InventoryFact, type PlanValue,
  type SetupPlan, type StaleInventoryFact } from './plan-types.js';
import { assertPlanRedacted, planIdSchema, validateSetupPlan } from './plan-validation.js';

function checkedId(id: string): string {
  assertPlanRedacted(id);
  if (!planIdSchema.safeParse(id).success) throw new Error('Setup plan ID must be 1-120 letters, digits, underscores, or hyphens, starting with a letter or digit.');
  return id;
}

/** Explicit compatibility seam: pre-release v0 lacked receipts and updatedAt. Never migrate on disk during read. */
export function migrateSetupPlan(input: unknown): SetupPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Setup plan must be a versioned JSON object.');
  const value = input as Record<string, unknown>;
  const version = value.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error('Setup plan schemaVersion must be a non-negative integer.');
  }
  if (version > SETUP_PLAN_SCHEMA_VERSION) {
    throw new Error(`Setup plan schemaVersion ${version} is newer than supported version ${SETUP_PLAN_SCHEMA_VERSION}; upgrade AIWG before resuming.`);
  }
  switch (version) {
    case 0:
      return validateSetupPlan({ ...value, schemaVersion: SETUP_PLAN_SCHEMA_VERSION,
        updatedAt: value.updatedAt === undefined ? value.createdAt : value.updatedAt,
        receipts: value.receipts === undefined ? [] : value.receipts });
    case SETUP_PLAN_SCHEMA_VERSION:
      return validateSetupPlan(value);
    default:
      throw new Error('No migration exists for this setup plan schemaVersion.');
  }
}

/** One resolved artifact root owns the entire plan, including receipts for other workspaces. */
export async function writeSetupPlan(projectDir: string, input: SetupPlan, env?: ProjectArtifactEnv): Promise<string> {
  // Scan the serialized snapshot too: toJSON/getters cannot introduce an unscanned write.
  assertPlanRedacted(input);
  let snapshot: unknown;
  try { snapshot = JSON.parse(JSON.stringify(input)); }
  catch { throw new Error('Setup plan must contain serializable JSON values.'); }
  const plan = validateSetupPlan(snapshot);
  const id = checkedId(plan.id);
  const root = resolveProjectAiwgDirForWrite(projectDir, env);
  const destination = join(root, 'setup', 'plans', `${id}.json`);
  const temporary = join(dirname(destination), `.${id}.${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(plan, null, 2) + '\n', 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, destination);
  } catch (error) {
    // The error code names the cause (EACCES, ENOSPC, ENOENT) without echoing plan data.
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new Error(`Cannot write setup plan under the resolved artifact root${code ? ` (${code})` : ''}. Check that the corpus is attached and writable; no fallback was used.`);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return destination;
}

export async function readSetupPlan(projectDir: string, id: string, env?: ProjectArtifactEnv): Promise<SetupPlan> {
  checkedId(id);
  const root = resolveProjectAiwgDir(projectDir, env);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Resolved AIWG artifact root is unavailable. Reconnect or attach the corpus before reading setup plans; no fallback was used.');
  }
  let content: string;
  try { content = await readFile(join(root, 'setup', 'plans', `${id}.json`), 'utf8'); }
  catch { throw new Error('Cannot read setup plan from the resolved artifact root. Check the plan ID and file permissions; no fallback was used.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('Setup plan is not valid JSON. Restore the plan from a valid copy.'); }
  const plan = migrateSetupPlan(parsed);
  if (plan.id !== id) throw new Error('Setup plan ID does not match its filename.');
  return plan;
}

/** Failed and skipped actions remain eligible. The apply slice decides retry/skip policy. */
export function remainingPlanActions(plan: SetupPlan): SetupPlan['actions'] {
  return plan.actions.filter(action => !plan.receipts.some(receipt => receipt.workspace === action.workspace &&
    Object.hasOwn(receipt.actions, action.id) && receipt.actions[action.id].status === 'applied'));
}

/** Presence counts, including false, null, and default/discovered answers. Never fill/overwrite answers here. */
export function unansweredPlanChoices(plan: SetupPlan): SetupPlan['unresolvedChoices'] {
  return plan.unresolvedChoices.filter(choice => !Object.hasOwn(plan.answers, choice.questionId));
}

function observedPaths(project: ProjectInventoryEntry): string[] {
  return [project.root, project.packageManifest, ...project.packageRoots,
    project.aiwg.directory ? join(project.root, '.aiwg') : null, project.aiwg.configFile,
    project.aiwg.contextFile, ...project.providerFiles.map(file => file.path)].filter((path): path is string => path !== null);
}

function factValue(inventory: DiscoveryInventory, fact: InventoryFact): unknown {
  if (fact.kind === 'tool') return inventory.tools.find(tool => tool.executable === fact.executable)?.[fact.field];
  const root = fact.kind === 'project' ? fact.root : fact.workspace;
  const project = inventory.projects.find(entry => entry.root === root);
  if (fact.kind === 'project') return project?.[fact.field];
  if (project && observedPaths(project).includes(fact.path)) return true;
  // Missing observations in a partial inventory cannot establish absence.
  if (inventory.stats.truncated || inventory.diagnostics.some(d =>
    ['inaccessible', 'symlink-skipped', 'outside-root'].includes(d.code))) return undefined;
  return false;
}

/** Pure comparison of local observations. Does not inspect paths, execute tools, or authorize apply. */
export function revalidateSetupPlan(plan: SetupPlan, fresh: DiscoveryInventory): ActionRevalidation[] {
  return plan.actions.flatMap(action => {
    const changes: StaleInventoryFact[] = action.dependsOn.flatMap(fact => {
      const before = factValue(plan.inventory, fact);
      const after = factValue(fresh, fact);
      let reason: StaleInventoryFact['reason'] | undefined;
      if (before === undefined || after === undefined || before === 'unknown' || after === 'unknown') reason = 'unobserved';
      if (fact.kind === 'tool') {
        const tool = fresh.tools.find(entry => entry.executable === fact.executable);
        if (!tool || tool.installed === 'unknown') reason = 'unobserved';
        else if (tool.installed === 'no') reason = 'tool-not-installed';
        else if (fact.field === 'version' && (before === null || after === null)) reason = 'unobserved';
        else if (fact.field === 'version' && !isDeepStrictEqual(before, after)) reason = 'version-changed';
      }
      if (fact.kind === 'project' && before !== undefined && after === undefined && !fresh.stats.truncated &&
        !fresh.diagnostics.some(d => d.path === fact.root && d.code === 'inaccessible')) reason = 'path-missing';
      if (!reason && !isDeepStrictEqual(before, after)) {
        reason = fact.kind === 'path' && after === false ? 'path-missing' : 'fact-changed';
      }
      return reason ? [{ fact, reason, before: before as PlanValue | undefined, after: after as PlanValue | undefined }] : [];
    });
    return changes.length ? [{ actionId: action.id, workspace: action.workspace, changes }] : [];
  });
}
