/**
 * Mission Control Command Handler
 *
 * Multi-loop background orchestration dashboard. Lets an orchestrator
 * spawn multiple long-running agent loops, monitor all simultaneously,
 * and react to completions or failures without blocking the primary session.
 *
 * Subcommands: start, dispatch, status, watch, abort, pause, resume, stop, list
 *
 * @implements @agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md
 * @source @src/cli/router.ts
 * @issue #483
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { assertMissionWorkerHandoff, assertValidWorkerPayload, validateWorkerPayload, workerConsumerSupport } from '../../mission-protocol/codecs.js';
import { WORKER_BASELINE_FEATURES, type WorkerArtifact, type WorkerBrief, type WorkerDispatch, type WorkerHealthSummary, type WorkerResult, type WorkerSelectionIntent, type WorkerUsage } from '../../mission-protocol/types.js';
import type { AiwgConfig } from '../../config/aiwg-config.js';

// ── Constants ────────────────────────────────────────────────

const MC_ROOT = '.aiwg/ralph-external/mc';
const SESSIONS_DIR = join(MC_ROOT, 'sessions');
const CONTROL_ID_RE = /^[a-zA-Z0-9._-]+$/;

/** Managed callers fail closed on invalid configuration; legacy reads keep their
 * historical best-effort behavior. No activation is installed by a caller. */
async function readAdmissionConfig(projectRoot: string): Promise<AiwgConfig | null> {
  const { readAiwgConfig, readAiwgConfigCandidate } = await import('../../config/aiwg-config.js');
  try {
    return await readAiwgConfig(projectRoot);
  } catch (error) {
    const candidate = await readAiwgConfigCandidate(projectRoot);
    if (candidate?.parallelism?.worker_mode === 'managed') throw error;
    return null;
  }
}

/** Shared binding used by MC and the managed Mission/Flow/Ralph caller paths. */
export async function createMcAdmissionScheduler(projectRoot: string, cfg: AiwgConfig | null,
  hostRegistry?: Pick<import('../../serve/executor-registry.js').ExecutorRegistry, 'resolveHostAdmissionAuthority'>) {
  const { resolveParallelism, workerActivationDigests, workerConfigDigest } = await import('../../config/aiwg-config.js');
  const { FileAdmissionStore, SharedHostScheduler } = await import('../../serve/shared-host-scheduler.js');
  const provider = cfg?.providers[0] ?? 'unknown';
  const parallelism = resolveParallelism(cfg?.parallelism, provider);
  if (parallelism.worker_mode === 'managed') {
    const { managedProjectAdmissionPolicy, projectAdmissionAuthority } = await import('../../serve/shared-host-scheduler.js');
    const activation = parallelism.activation;
    if (!cfg || !activation || activation.configDigest !== workerActivationDigests(cfg).configDigest) {
      throw new Error('managed admission requires a current activated policy');
    }
    const authority = projectAdmissionAuthority(projectRoot);
    const authorityRef = parallelism.admission?.authorityRef ?? 'project';
    const policy = managedProjectAdmissionPolicy(projectRoot, { ...parallelism,
      admission: { ...parallelism.admission, authorityRef: 'project' },
    }, workerConfigDigest(activation), parallelism.max_parallel_subagents);
    const binding = authorityRef === 'project' ? { store: new FileAdmissionStore(authority.path), policy }
      : (hostRegistry ?? (await import('../../serve/executor-registry.js')).executorRegistry).resolveHostAdmissionAuthority(authorityRef, policy);
    const scheduler = new SharedHostScheduler(binding.store, binding.policy);
    scheduler.reconcileNow();
    return scheduler;
  }
  const maxConcurrent = parallelism.max_parallel_mc_missions;
  return new SharedHostScheduler(new FileAdmissionStore(join(projectRoot, MC_ROOT, 'admission.json')), {
    maxConcurrent, leaseTtlMs: 5 * 60_000, agingIntervalMs: 30_000, allowPreemption: false, defaultHostQuota: maxConcurrent,
  });
}

type MissionStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted' | 'paused';
type SessionState = 'active' | 'paused' | 'stopped';

type MissionMode = 'direct' | 'pty-orchestrator';

interface Mission {
  id: string;
  objective: string;
  completion?: string;
  status: MissionStatus;
  loop: number;
  maxIterations: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxTotalCost?: number;
  maxWallClockMinutes?: number;
  explorationQuota?: number;
  budgetStopPolicy?: 'completion-wins' | 'budget-wins';
  priority: string;
  mode: MissionMode;
  targetAgent?: string;
  lastAction?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Ralph loop ID once the mission is launched (#1439) */
  ralphLoopId?: string;
  /** Ralph process PID once the mission is launched (#1439) */
  ralphPid?: number;
  /** Shared-host admission lease backing this local execution (#1566, #1657). */
  admissionRequestId?: string;
  admissionState?: string;
  admissionLeaseExpiresAt?: string;
  admissionSubmittedAt?: string;
  admissionGeneration?: number;
  admissionLaunchClaimed?: boolean;
  admissionExecution?: { pid: number; startedAt: string };
  extensions?: Record<string, unknown>;
  managedWorker?: { invocationPath: string; runDir: string };
}

interface Session {
  id: string;
  name: string;
  state: SessionState;
  maxMissions: number;
  createdAt: string;
  updatedAt: string;
  missions: Mission[];
  /** Idempotency ledger shared by CLI and Cockpit control mutations. */
  mutationKeys?: Record<string, { action: string; target: string; updatedAt: string }>;
}

const mcWorkerSupport = () => workerConsumerSupport([...WORKER_BASELINE_FEATURES, 'worker-health.v1']);

function workerDispatch(mission: Mission): WorkerDispatch | undefined {
  const bindings = new Set<WorkerDispatch>();
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record['aiwg.worker-dispatch']) bindings.add(record['aiwg.worker-dispatch'] as WorkerDispatch);
    visit(record.extensions);
    visit(record.metadata);
    for (const [key, child] of Object.entries(record)) if (key.startsWith('aiwg.source.')) visit(child);
  }
  visit(mission);
  if (bindings.size > 1) throw new Error('Managed task contains multiple dispatch bindings');
  return [...bindings][0];
}

async function readWorkerArtifact<T>(artifact: WorkerArtifact, projectRoot: string): Promise<T> {
  const filename = artifact.ref.startsWith('file:') ? fileURLToPath(artifact.ref) : artifact.ref;
  const inside = relative(projectRoot, filename);
  if (!isAbsolute(filename) || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Managed worker artifacts must be inside the project');
  const bytes = await readWorkerBytes(filename);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) throw new Error('Managed worker artifact digest changed');
  return JSON.parse(bytes.toString('utf8')) as T;
}

async function readWorkerBytes(filename: string): Promise<Buffer> {
  const { inspectWorkerPath } = await import('../../serve/worker-invocation.js');
  if (!await inspectWorkerPath(filename, 'file')) throw Object.assign(new Error('Managed worker artifact is missing'), { code: 'ENOENT' });
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) throw new Error('Invalid managed worker artifact');
    const bytes = Buffer.alloc(1048577);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1048576) throw new Error('Managed worker artifact exceeds its size bound');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function readWorkerJson(filename: string) {
  return JSON.parse((await readWorkerBytes(filename)).toString('utf8'));
}

async function resolveMcWorker(ctx: HandlerContext, session: Pick<Session, 'id'>, mission: Mission, parentKind: 'mission' | 'flow' = 'mission') {
  const dispatch = workerDispatch(mission);
  if (!dispatch) return undefined;
  const projectRoot = ctx.cwd || process.cwd();
  const intent = await readWorkerArtifact<WorkerSelectionIntent>(dispatch.intent, projectRoot);
  assertValidWorkerPayload('workerSelectionIntent', intent);
  if (!dispatch.brief) throw new Error('Managed worker requires a prepared brief');
  const brief = await readWorkerArtifact<WorkerBrief>(dispatch.brief, projectRoot);
  assertValidWorkerPayload('workerBrief', brief);
  const { workerConfigDigest } = await import('../../config/aiwg-config.js');
  if (intent.parent.kind !== parentKind || intent.parent.id !== session.id || intent.objective !== mission.objective
    || intent.taskId !== dispatch.taskId || intent.requestId !== dispatch.requestId
    || brief.invocationId !== dispatch.invocationId || workerConfigDigest(brief.intent) !== workerConfigDigest(intent)
    || brief.intentDigest !== workerConfigDigest(intent)) throw new Error('Managed worker task authority differs from its parent');
  const { loadWorkerInputs } = await import('./models.js');
  const { resolveWorkerInvocation } = await import('../../serve/worker-invocation.js');
  const inputs = await loadWorkerInputs(ctx);
  const plan = await resolveWorkerInvocation(inputs.snapshot, { role: intent.role, task: intent.taskClass, group: intent.group,
    brief: dispatch.brief.ref.startsWith('file:') ? fileURLToPath(dispatch.brief.ref) : dispatch.brief.ref,
    workdir: brief.workspace.path, final_output: brief.output.resultPath, managedIntent: intent }, inputs.drivers);
  if (!plan.invocation || plan.status !== 'eligible' || plan.invocation.readiness !== 'launchable') {
    throw new Error(`Managed worker is ineligible: ${plan.diagnostics.map(item => item.message).join('; ')}`);
  }
  if (parentKind === 'mission' && plan.invocation.transport !== 'shell') throw new Error('Managed Ralph capture requires a qualified shell transport');
  return { dispatch, intent, brief, plan };
}

/** Flow adapters use the same eligibility, project authority and allowance owner. */
export async function createMcFlowAdapter(ctx: HandlerContext, bindings: {
  prepareNode(request: { runId: string; node: { id: string } }): Promise<{ objective: string; dispatch: WorkerDispatch }>;
  invokeNode(request: unknown, context: unknown): Promise<unknown>;
}) {
  const cfg = await readAdmissionConfig(ctx.cwd);
  if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed') {
    throw new Error('OG_CONTRACT_UNSUPPORTED: Flow shared dispatch requires managed mode');
  }
  const scheduler = await createMcAdmissionScheduler(ctx.cwd, cfg);
  const { managedAllowanceFromOwner } = await import('../../serve/shared-host-scheduler.js');
  const { createManagedCompositionAdapter } = await import(join(ctx.frameworkRoot, 'agentic/code/addons/composition-engine/lib/runtime.mjs'));
  return createManagedCompositionAdapter({ scheduler, allowanceFromOwner: managedAllowanceFromOwner,
    invokeNode: bindings.invokeNode,
    prepareNode: async (request: { runId: string; node: { id: string } }) => {
      const binding = await bindings.prepareNode(request);
      const worker = await resolveMcWorker(ctx, { id: request.runId }, {
        id: request.node.id, objective: binding.objective, status: 'queued', loop: 0,
        maxIterations: 1, priority: 'normal', mode: 'direct', extensions: { 'aiwg.worker-dispatch': binding.dispatch },
      }, 'flow');
      if (!worker || worker.intent.taskId !== request.node.id) throw new Error('Flow task authority differs from node identity');
      const selected = worker.plan.selected!;
      return { invocation: worker.plan.invocation, plan: worker.plan, brief: worker.brief,
        admission: { requestId: worker.dispatch.requestId, orchestratorId: request.runId,
          environment: process.env.AIWG_ENVIRONMENT ?? 'default', provider: selected.inferenceProvider, runtimeKind: 'host',
          priority: 10, submittedAt: new Date().toISOString(), queueTimeoutMs: (cfg.parallelism!.admission?.queueTimeoutSeconds ?? 300) * 1000,
          preemptible: false, metadata: { nodeId: request.node.id, invocationId: worker.dispatch.invocationId },
          managed: { kind: 'external', group: selected.group, member: selected.member, cli: selected.cli,
            model: selected.modelKey, quotaScope: cfg.parallelism!.clis![selected.cli].quotaScope },
          allowance: { runId: request.runId, taskId: request.node.id,
            taskBudgets: { maxAttempts: worker.intent.limits.maxAttempts, maxTokens: worker.intent.limits.tokens,
              maxCostUsd: worker.intent.limits.costUsd ?? undefined, timeoutSeconds: worker.intent.limits.wallSeconds },
            reservation: { tokens: worker.plan.invocation!.limits.tokens, costUsd: worker.plan.invocation!.limits.costUsd } },
        } };
    },
  });
}

/** Capture completion is evidence for the parent, never an independent gate. */
async function readManagedWorkerState(mission: Mission, scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>) {
  const binding = mission.managedWorker!;
  const observation = await readWorkerJson(join(binding.runDir, 'health.json'));
  assertValidWorkerPayload('workerHealthSummary', observation.health);
  const dispatch = workerDispatch(mission)!;
  if (observation.invocationId !== dispatch.invocationId || observation.health.observerGeneration !== mission.admissionGeneration) {
    throw new Error('Stale managed worker observation');
  }
  let exit;
  try { exit = await readWorkerJson(join(binding.runDir, 'exit.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!exit) return { status: 'running', health: observation.health };
  if (exit.invocationId !== dispatch.invocationId || exit.managedAdmission?.requestId !== mission.admissionRequestId
    || exit.managedAdmission?.generation !== mission.admissionGeneration) throw new Error('Stale managed worker exit evidence');
  const record = scheduler.snapshot().records[mission.admissionRequestId!]!;
  const usage: WorkerUsage = { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null,
    costUsd: null, quality: 'unknown', reservedTokens: record.accounting!.reservation.tokens!,
    reservedUsd: record.accounting!.reservation.costUsd };
  const plan = await readWorkerJson(binding.invocationPath);
  const succeeded = exit.exitCode === 0 && !exit.errorCode && !exit.timedOut && !exit.cancelled;
  const result: WorkerResult = { version: 1, taskId: dispatch.taskId, invocationId: dispatch.invocationId,
    briefDigest: plan.invocation.briefDigest, worker: null,
    execution: { status: succeeded ? 'completed' : 'failed', exitCode: exit.exitCode,
      requested: plan.invocation.selected, observedModel: null, observedFamily: null, observedEffort: null,
      identityEvidence: [], identityQuality: 'unavailable', startedAt: mission.startedAt!, endedAt: exit.endedAt,
      termination: exit.termination, usage, failure: null, health: observation.health },
    verification: { status: 'pending', verifierId: null, runnerRef: null, artifactDigest: null, evidence: [], findings: [] } };
  try {
    const claims = await readWorkerJson(plan.invocation.finalPath);
    assertValidWorkerPayload('workerClaims', claims);
    result.worker = claims;
  } catch { /* Invalid or absent claims remain separate from execution evidence. */ }
  assertValidWorkerPayload('workerResult', result);
  // Use the checkpoint's own directory; request IDs need not contain a session ID.
  const destination = `${binding.invocationPath}.result.json`;
  const bytes = JSON.stringify(result);
  await fs.writeFile(destination, bytes, { mode: 0o600 });
  dispatch.result = { ref: pathToFileURL(destination).href, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  scheduler.acceptFinal(mission.admissionRequestId!, mission.admissionGeneration!, observation.health, usage);
  // A surviving or unobservable outer supervisor cannot prove its own stop.
  let supervisorGone = false;
  try { process.kill(mission.admissionExecution!.pid, 0); }
  catch (error) { supervisorGone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (supervisorGone && exit.termination === 'confirmed' && exit.descendants === 'stopped') {
    const settled = scheduler.settle(mission.admissionRequestId!, mission.admissionGeneration!, observation.health, usage, undefined, mission.admissionExecution);
    mission.admissionState = settled.state;
  }
  dispatch.state = mission.admissionState === 'settled' ? succeeded ? 'completed' : 'failed' : 'uncertain';
  // Verification and original completion criteria remain with the parent.
  return { status: succeeded && result.worker?.status === 'completed' ? 'paused' : 'failed', health: observation.health };
}

// ── Helpers ──────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSession(sessionId: string): Promise<Session | null> {
  if (!CONTROL_ID_RE.test(sessionId)) return null;
  const path = join(SESSIONS_DIR, sessionId, 'session.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

async function writeSession(session: Session, { touch = true }: { touch?: boolean } = {}): Promise<void> {
  const dir = join(SESSIONS_DIR, session.id);
  await ensureDir(dir);
  if (touch) session.updatedAt = new Date().toISOString();
  const destination = join(dir, 'session.json');
  const temporary = join(dir, `.session.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(session, null, 2));
  await fs.rename(temporary, destination);
}

async function appendLog(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const logPath = join(SESSIONS_DIR, sessionId, 'log.jsonl');
  const entry = JSON.stringify({ ...event, ts: new Date().toISOString() });
  await fs.appendFile(logPath, entry + '\n');
}

type MutationResult =
  | { ok: true; session: Session; replayed: boolean }
  | { ok: false; code: 'mission_conflict' | 'session_not_found' | 'target_not_found' | 'invalid_state' | 'capacity'; message: string };

/**
 * Apply one durable Mission Control mutation under a cross-process lock.
 * `expectedUpdatedAt` provides optimistic concurrency and `requestId` makes
 * retries idempotent across CLI/Cockpit reconnects.
 */
async function mutateSession(
  sessionId: string,
  action: string,
  target: string,
  expectedUpdatedAt: string | undefined,
  requestId: string | undefined,
  mutate: (session: Session) => string | undefined,
): Promise<MutationResult> {
  if (!CONTROL_ID_RE.test(sessionId) || !CONTROL_ID_RE.test(target)) {
    return { ok: false, code: 'target_not_found', message: 'invalid Mission control identifier' };
  }
  const dir = join(SESSIONS_DIR, sessionId);
  await ensureDir(dir);
  const lockPath = join(dir, '.control.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, code: 'mission_conflict', message: 'another Mission control mutation is in progress' };
    }
    throw error;
  }
  try {
    const session = await readSession(sessionId);
    if (!session) return { ok: false, code: 'session_not_found', message: `Session not found: ${sessionId}` };
    if (expectedUpdatedAt && session.updatedAt !== expectedUpdatedAt) {
      return { ok: false, code: 'mission_conflict', message: `expected revision ${expectedUpdatedAt}; current revision is ${session.updatedAt}` };
    }
    if (requestId && session.mutationKeys?.[requestId]) {
      const prior = session.mutationKeys[requestId]!;
      if (prior.action !== action || prior.target !== target) {
        return { ok: false, code: 'mission_conflict', message: `request id '${requestId}' was already used for another mutation` };
      }
      return { ok: true, session, replayed: true };
    }
    const errorCode = mutate(session);
    if (errorCode === 'target_not_found') return { ok: false, code: errorCode, message: `Mission not found: ${target}` };
    if (errorCode === 'invalid_state') return { ok: false, code: errorCode, message: `Mutation '${action}' is invalid from state '${session.state}'` };
    if (errorCode === 'capacity') return { ok: false, code: errorCode, message: `Session at capacity (${session.maxMissions} missions)` };
    const nextUpdatedAt = new Date().toISOString();
    session.updatedAt = nextUpdatedAt;
    if (requestId) {
      session.mutationKeys = { ...(session.mutationKeys ?? {}), [requestId]: { action, target, updatedAt: nextUpdatedAt } };
    }
    await writeSession(session, { touch: false });
    await appendLog(session.id, { event: `control_${action}`, target, requestId: requestId ?? null, replayed: false, revision: session.updatedAt });
    return { ok: true, session, replayed: false };
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function mutationFlags(args: string[]): { expectedUpdatedAt?: string; requestId?: string } {
  return {
    expectedUpdatedAt: parseFlag(args, '--expected-updated-at'),
    requestId: parseFlag(args, '--request-id'),
  };
}

function mutationFailure(result: Extract<MutationResult, { ok: false }>): HandlerResult {
  ui.error(`${result.code}: ${result.message}`);
  return { exitCode: result.code === 'mission_conflict' ? 3 : 1, message: `${result.code}: ${result.message}` };
}

async function listSessions(): Promise<Session[]> {
  try {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const s = await readSession(entry.name);
        if (s) sessions.push(s);
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

async function findActiveSession(sessionIdArg?: string): Promise<Session | null> {
  if (sessionIdArg) return readSession(sessionIdArg);

  // Find latest active session
  const sessions = await listSessions();
  const active = sessions
    .filter(s => s.state === 'active' || s.state === 'paused')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return active[0] || null;
}

function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      return i + 1 < args.length ? args[i + 1] : undefined;
    }
    // Support --flag=value — previously silently ignored, which for budget
    // flags meant an unbounded loop the operator believed was capped (#1770)
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Parse a numeric flag. A flag that is PRESENT but not a positive number is a
 * usage error collected into `invalidSink` — silently dropping it used to
 * dispatch missions with no ceiling while the operator believed one applied
 * (#1770).
 */
function parseNumberFlag(args: string[], flag: string, invalidSink?: string[], integer = false): number | undefined {
  if (!args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) return undefined;
  const raw = parseFlag(args, flag);
  // Presence and validity are distinct: a trailing flag must not silently
  // disappear, and counter limits must not accept fractional/unsafe values.
  const decimal = typeof raw === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw);
  const value = decimal ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    invalidSink?.push(`${flag} (got '${raw}')`);
    return undefined;
  }
  return value;
}

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Per-subcommand usage strings (#1440).
 *
 * `aiwg mc <subcommand> --help` MUST print this text and exit before any
 * side-effecting logic. The previous behavior — running `aiwg mc start --help`
 * actually created a session — violated the universal `--help` convention.
 */
const subcommandUsage: Record<string, string> = {
  start: `Usage: aiwg mc start [--name "<label>"] [--max-missions N]

Create a new Mission Control session for tracking background missions.

  --name <label>       Human-readable session name (default: "Mission YYYY-MM-DD")
  --max-missions N     Capacity limit for queued missions (default: 10)

Note: 'start' only creates the session. Use 'dispatch' to queue missions and
'run' to drain the queue.`,

  dispatch: `Usage: aiwg mc dispatch <session-id> "<objective>" [options]

Queue a mission onto a session. Does NOT execute — use 'aiwg mc run' to launch.

  --completion "<criteria>"     Verifiable completion criteria (required for 'mc run')
  --priority <level>            Priority hint (default: normal)
  --max-iterations N            Ralph iteration cap when launched (default: 10)
  --max-total-tokens N          Hard cumulative token ceiling when observable
  --max-output-tokens N         Hard cumulative output-token ceiling
  --max-tool-calls N            Hard cumulative tool-call ceiling
  --max-total-cost USD          Hard cumulative provider-reported spend ceiling
  --max-wall-clock-minutes N    Hard cumulative runtime ceiling
  --exploration-quota K         Require structural variant after K flat cycles
                                (off unless declared; no default K)
  --budget-stop-policy P        completion-wins (default) | budget-wins
  --mode pty-orchestrator       PTY-orchestrator mode (requires --target-agent)
  --target-agent <id>           Required for --mode pty-orchestrator
  --worker-dispatch <path>      Prepared managed worker dispatch JSON (queues only)
  --expected-updated-at <time>  Reject stale state with exit 3
  --request-id <id>             Idempotent dispatch key`,

  run: `Usage: aiwg mc run [<session-id>] [--accept-cost]

Drain queued missions in a session by launching each as a ralph loop. Missions
without --completion criteria are skipped with a warning.

  --accept-cost   Skip the cost-warning gate (required for non-TTY contexts
                  when estimated cumulative cost exceeds $5). See #1450.

The estimate is the cumulative iteration floor (missions x max-iterations x
~$1.60 cache cost per headless iteration). A mission's --max-total-cost caps its
share of that estimate only on a provider that reports spend; on a provider that
reports none the ceiling is inert (#1766), so it is reported but not subtracted.
See #2522.`,

  status: `Usage: aiwg mc status [<session-id>] [--json]

Show mission status for a session. Auto-syncs from ralph loop state files.

  --json   Emit JSON instead of human-readable table`,

  watch: `Usage: aiwg mc watch [<session-id>]

Live-monitor mission progress (non-interactive context prints status once).`,

  abort: `Usage: aiwg mc abort <session-id> <mission-id>

Mark a specific mission as aborted.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  pause: `Usage: aiwg mc pause [<session-id>]

Pause an active session; running missions transition to 'paused' status.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  resume: `Usage: aiwg mc resume [<session-id>]

Resume a paused session; paused missions transition back to 'running'.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  stop: `Usage: aiwg mc stop [<session-id>] [--drain]

Shut down a session.

  --drain   Cancel queued, let running finish (default: abort all non-completed)`,

  list: `Usage: aiwg mc list [--json]

List all Mission Control sessions.`,

  agents: `Usage: aiwg mc agents [filters] [--json]

Query routable agents from a local 'aiwg serve' instance.

  --framework <name>       Require an AIWG framework (repeatable)
  --sandbox <id>           Restrict to a sandbox
  --agent <id>             Restrict to a specific agent ID
  --name <n>               Match by logical name
  --max-cpu <pct>          Reject agents above this CPU %
  --min-memory <gb>        Reject agents below this memory threshold
  --json                   Output raw JSON`,
};

function printSubcommandHelp(name: string): void {
  const text = subcommandUsage[name];
  ui.blank();
  if (text) {
    console.log(`  ${text}`);
  } else {
    console.log(`  No detailed help for 'aiwg mc ${name}'. Run 'aiwg mc --help' for the full reference.`);
  }
  ui.blank();
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      // Skip flag and its value if it has one
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    positional.push(args[i]);
  }
  return positional;
}

// ── Subcommand handlers ──────────────────────────────────────

async function mcStart(ctx: HandlerContext): Promise<HandlerResult> {
  const name = parseFlag(ctx.args, '--name') || `Mission ${new Date().toISOString().slice(0, 10)}`;
  const maxMissions = parseInt(parseFlag(ctx.args, '--max-missions') || '10', 10);

  const session: Session = {
    id: genId('mc'),
    name,
    state: 'active',
    maxMissions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    missions: [],
  };

  await writeSession(session);
  await appendLog(session.id, { event: 'session_started', name, maxMissions });

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — ${ui.accent(name)}`);
  ui.rule();
  ui.success(`Session started: ${session.id}`);
  ui.info(`Max missions: ${maxMissions}`);
  // #1439: the lifecycle is start → dispatch → run → status. State this
  // up-front so users don't get stuck wondering why missions never execute.
  ui.info(`Next: \`aiwg mc dispatch ${session.id} "<objective>" --completion "<criteria>"\``);
  ui.info(`Then: \`aiwg mc run ${session.id}\` to drain the queue (missions stay 'queued' until you do).`);
  ui.blank();

  return { exitCode: 0, message: session.id };
}

async function mcDispatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const objective = positional.slice(1).join(' ') || parseFlag(ctx.args, '--objective');
  const completion = parseFlag(ctx.args, '--completion');
  const priority = parseFlag(ctx.args, '--priority') || 'normal';
  const invalidFlags: string[] = [];
  const maxIterations = parseNumberFlag(ctx.args, '--max-iterations', invalidFlags, true) ?? 10;
  const maxTotalTokens = parseNumberFlag(ctx.args, '--max-total-tokens', invalidFlags, true);
  const maxOutputTokens = parseNumberFlag(ctx.args, '--max-output-tokens', invalidFlags, true);
  const maxToolCalls = parseNumberFlag(ctx.args, '--max-tool-calls', invalidFlags, true);
  const maxTotalCost = parseNumberFlag(ctx.args, '--max-total-cost', invalidFlags);
  const maxWallClockMinutes = parseNumberFlag(ctx.args, '--max-wall-clock-minutes', invalidFlags);
  const explorationQuota = parseNumberFlag(ctx.args, '--exploration-quota', invalidFlags, true);
  const budgetStopPolicyRaw = parseFlag(ctx.args, '--budget-stop-policy');
  let budgetStopPolicy: 'completion-wins' | 'budget-wins' | undefined;
  if (budgetStopPolicyRaw !== undefined) {
    if (budgetStopPolicyRaw === 'completion-wins' || budgetStopPolicyRaw === 'budget-wins') {
      budgetStopPolicy = budgetStopPolicyRaw;
    } else {
      invalidFlags.push(`--budget-stop-policy (got '${budgetStopPolicyRaw}', expected completion-wins|budget-wins)`);
    }
  }
  const modeRaw = parseFlag(ctx.args, '--mode') || 'direct';
  const mode: MissionMode = modeRaw === 'pty-orchestrator' ? 'pty-orchestrator' : 'direct';
  const targetAgent = parseFlag(ctx.args, '--target-agent');

  if (!objective) {
    // #1438: keep this in sync with subcommandUsage.dispatch above so 'mc
    // dispatch' with bad args and 'mc dispatch --help' agree on flags.
    ui.error('Usage: aiwg mc dispatch <session-id> "<objective>" [--completion "<criteria>"] [--max-iterations N] [--priority <level>] [--mode pty-orchestrator] [--target-agent <agent-id>]');
    return { exitCode: 1 };
  }

  if (invalidFlags.length > 0) {
    ui.error(`Invalid numeric flag value(s): ${invalidFlags.join(', ')}. Budget/quota flags require positive numbers. Mission not dispatched.`);
    return { exitCode: 1 };
  }

  if (mode === 'pty-orchestrator' && !targetAgent) {
    ui.error('--mode pty-orchestrator requires --target-agent <agent-id>');
    return { exitCode: 1 };
  }

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  // mission-dispatch accepts only the frozen objective envelope. Worker
  // bindings can arrive through its existing session, so inspect that payload.
  try {
    const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    const support = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed' ? mcWorkerSupport() : undefined;
    assertMissionWorkerHandoff(selected, 'mc-cli', support);
    for (const mission of selected.missions) assertMissionWorkerHandoff(mission, 'mc-cli', support);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }

  // #1361: Check project-level parallelism cap. Active missions = running or
  // queued; if at cap, warn but still queue (FIFO behavior — the mission goes
  // into the session as 'queued' and will run when a slot frees up).
  let capWarning: string | undefined;
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const activeCount = selected.missions.filter(
        m => m.status === 'running' || m.status === 'queued' || m.status === 'paused',
      ).length;
      if (activeCount >= resolved.max_parallel_mc_missions) {
        capWarning = `Active missions (${activeCount}) at or above project parallelism cap (${resolved.max_parallel_mc_missions}). Mission will queue; bump via 'aiwg config set --project parallelism.max_parallel_mc_missions N'.`;
      }
    }
  } catch {
    // Non-fatal — config read failure doesn't block dispatch
  }

  const flags = mutationFlags(ctx.args);
  const mission: Mission = {
    id: flags.requestId
      ? `m-${createHash('sha256').update(flags.requestId).digest('hex').slice(0, 16)}`
      : genId('m'),
    objective,
    completion,
    status: 'queued',
    loop: 0,
    maxIterations,
    maxTotalTokens,
    maxOutputTokens,
    maxToolCalls,
    maxTotalCost,
    maxWallClockMinutes,
    explorationQuota,
    budgetStopPolicy,
    priority,
    mode,
    targetAgent: targetAgent || undefined,
  };

  const dispatchPath = parseFlag(ctx.args, '--worker-dispatch');
  if (dispatchPath) {
    try {
      const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
      if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed' || mode !== 'direct') {
        throw new Error('OG_CONTRACT_UNSUPPORTED: worker dispatch requires the managed MC caller');
      }
      if (!isAbsolute(dispatchPath) || relative(ctx.cwd, dispatchPath).startsWith('..')) throw new Error('Worker dispatch path must be inside the project');
      const dispatch = await readWorkerJson(dispatchPath) as WorkerDispatch;
      mission.extensions = { 'aiwg.worker-dispatch': dispatch };
      assertMissionWorkerHandoff(mission, 'mc-cli', mcWorkerSupport());
      await resolveMcWorker(ctx, selected, mission);
    } catch (error) { return managedControlFailure(error); }
  }

  const result = await mutateSession(selected.id, 'dispatch', mission.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    if (session.missions.length >= session.maxMissions) return 'capacity';
    session.missions.push(mission);
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);
  if (!result.replayed) {
    await appendLog(selected.id, {
      event: 'mission_dispatched',
      missionId: mission.id,
      objective,
      priority,
      mode,
      targetAgent,
      requestId: flags.requestId ?? null,
      lfdBudgets: {
        maxTotalTokens,
        maxOutputTokens,
        maxToolCalls,
        maxTotalCost,
        maxWallClockMinutes,
        explorationQuota,
      },
    });
  }

  if (capWarning) ui.warn(capWarning);
  ui.success(`${result.replayed ? 'Replayed dispatch for' : 'Dispatched mission'} ${mission.id}: ${objective}`);
  const modeLabel = mode === 'pty-orchestrator' ? ` | Mode: PTY orchestrator → ${targetAgent}` : '';
  ui.info(`Priority: ${priority} | Max iterations: ${maxIterations}${modeLabel}`);
  const lfdLimits = [
    maxTotalTokens ? `total tokens ${maxTotalTokens}` : null,
    maxOutputTokens ? `output tokens ${maxOutputTokens}` : null,
    maxToolCalls ? `tool calls ${maxToolCalls}` : null,
    maxTotalCost ? `total cost $${maxTotalCost}` : null,
    maxWallClockMinutes ? `wall clock ${maxWallClockMinutes}m` : null,
    explorationQuota ? `exploration quota ${explorationQuota}` : null,
  ].filter(Boolean);
  if (lfdLimits.length > 0) {
    ui.info(`LFD limits: ${lfdLimits.join(' | ')}`);
  }

  // #1439: dispatch alone does NOT execute the mission. Surface the next step
  // so the user knows the queue won't drain on its own.
  ui.info(`Next: run \`aiwg mc run ${selected.id}\` to launch queued missions as ralph loops.`);

  return { exitCode: 0, message: mission.id };
}

/**
 * Drain queued missions in a session by launching each as a ralph loop (#1439).
 *
 * Before this command existed, missions sat in `queued` status forever because
 * no supervisor process drained the queue. `mc run` is the explicit supervisor
 * step: for every queued direct-mode mission, spawn a detached ralph process
 * via launchExternalRalph(), record the resulting loopId + pid on the mission,
 * and flip the mission to `running`.
 *
 * Status sync back from ralph to mc happens lazily via syncMissionsFromRalph()
 * called from `mc status` and `mc watch` — no separate daemon needed.
 *
 * Limitations of cycle 1:
 * - pty-orchestrator missions are skipped with a warning (separate codepath)
 * - missions launch sequentially (each call to launchExternalRalph spawns a
 *   detached process, so they DO run in parallel after launch — the loop here
 *   is just for orderly dispatch, not for parallel scheduling)
 */
/**
 * Per-iteration cache-creation floor for a headless claude session (sonnet
 * baseline; opus is ~$3.90).
 */
export const SONNET_CACHE_USD = 1.60;

/** Estimate at or above which `mc run` warns and refuses in non-TTY contexts. */
export const COST_WARNING_THRESHOLD_USD = 5.0;

/**
 * Providers whose headless stream reports spend, so a declared `--max-total-cost`
 * ceiling can actually fire mid-loop.
 *
 * Only `claude` emits cost on its stream-json events, which is what
 * `SessionLauncher._extractUsageStats` reads. Adapters without stream-json
 * (codex, factory, opencode, deepseek) emit no usage events at all — #1766
 * recorded that a spend ceiling on those is inert and never fires. Adapters that
 * do stream JSON but have not been observed carrying cost fields (omp, pi) stay
 * out of this set deliberately: assuming an observability we have not seen would
 * weaken the gate in exactly the case where the operator has least protection.
 */
export const COST_REPORTING_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

export interface MissionRunCostEstimate {
  /** Estimated cumulative spend, in USD, used for the warning threshold. */
  estimateUsd: number;
  /** Uncapped iteration floor, for comparison against `estimateUsd`. */
  iterationFloorUsd: number;
  /** Sum of every declared `maxTotalCost`, whether or not it can fire. */
  declaredCeilingUsd: number;
  /** Missions whose declared ceiling was applied to the estimate. */
  cappedMissions: number;
  /** Missions declaring a ceiling that cannot fire on this provider. */
  inertCeilingMissions: number;
  /** Whether the target provider reports spend. */
  spendObservable: boolean;
}

/**
 * Estimate cumulative spend for a set of queued missions (#2522).
 *
 * The floor for each mission is `maxIterations × SONNET_CACHE_USD`. A declared
 * `maxTotalCost` bounds that floor **only** when the target provider reports
 * spend — on a provider that reports none, the ceiling is inert (#1766), so
 * subtracting it would make the warning weaker precisely where the operator has
 * no enforced protection. Those ceilings are counted and surfaced instead.
 */
export function estimateMissionRunCost(
  missions: ReadonlyArray<Pick<Mission, 'maxIterations' | 'maxTotalCost'>>,
  provider: string,
): MissionRunCostEstimate {
  const spendObservable = COST_REPORTING_PROVIDERS.has(provider);
  let estimateUsd = 0;
  let iterationFloorUsd = 0;
  let declaredCeilingUsd = 0;
  let cappedMissions = 0;
  let inertCeilingMissions = 0;

  for (const mission of missions) {
    const floor = mission.maxIterations * SONNET_CACHE_USD;
    iterationFloorUsd += floor;
    const ceiling = typeof mission.maxTotalCost === 'number' && Number.isFinite(mission.maxTotalCost)
      ? mission.maxTotalCost
      : undefined;
    if (ceiling === undefined) {
      estimateUsd += floor;
      continue;
    }
    declaredCeilingUsd += ceiling;
    if (spendObservable) {
      cappedMissions += 1;
      estimateUsd += Math.min(floor, ceiling);
    } else {
      inertCeilingMissions += 1;
      estimateUsd += floor;
    }
  }

  return {
    estimateUsd,
    iterationFloorUsd,
    declaredCeilingUsd,
    cappedMissions,
    inertCeilingMissions,
    spendObservable,
  };
}

async function mcRun(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const acceptCost = hasFlag(ctx.args, '--accept-cost');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  const queued = session.missions.filter((m) => m.status === 'queued');
  let cfg: AiwgConfig | null;
  try {
    cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    const support = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed' ? mcWorkerSupport() : undefined;
    assertMissionWorkerHandoff(session, 'mc-cli', support);
    for (const mission of queued) assertMissionWorkerHandoff(mission, 'mc-cli', support);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  if (queued.length === 0) {
    ui.info(`No queued missions in session ${session.id}. Run \`aiwg mc dispatch ${session.id} "<objective>"\` to add one.`);
    return { exitCode: 0 };
  }

  // #1450 P0: cost warning gate, with declared ceilings honored (#2522).
  //
  // Each headless claude session pays a ~$1.60 cache-creation cost on iteration
  // 1 before any user-meaningful work (sonnet baseline; opus is ~$3.90). Across
  // N missions × M iterations the floor compounds quickly. Warn before launch
  // and refuse in non-TTY contexts unless --accept-cost is set.
  const eligible = queued.filter(m => m.mode !== 'pty-orchestrator' && !!m.completion);

  const projectRoot = ctx.cwd || process.cwd();
  const frameworkRoot = ctx.frameworkRoot;
  let scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>;
  try {
    scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  const provider = cfg?.providers[0] ?? 'unknown';

  const estimate = estimateMissionRunCost(eligible, provider);

  if (estimate.estimateUsd >= COST_WARNING_THRESHOLD_USD && !acceptCost) {
    ui.blank();
    ui.warn(`Cost estimate: ~$${estimate.estimateUsd.toFixed(2)} (${eligible.length} missions × iteration floors × ~$${SONNET_CACHE_USD.toFixed(2)} cache cost per claude headless iter).`);
    if (estimate.cappedMissions > 0) {
      ui.warn(`Declared ceilings: $${estimate.declaredCeilingUsd.toFixed(2)} across ${estimate.cappedMissions} mission(s) — counted toward the estimate because ${provider} reports spend.`);
    }
    if (estimate.inertCeilingMissions > 0) {
      ui.warn(`${estimate.inertCeilingMissions} mission(s) declare --max-total-cost totalling $${estimate.declaredCeilingUsd.toFixed(2)}, but ${provider} does not report spend — those ceilings cannot fire and are NOT subtracted from this estimate (#1766).`);
    }
    ui.warn('Actual spend may be lower if missions complete early, higher if model is opus or context grows.');
    if (!process.stdout.isTTY) {
      ui.error('Refusing to launch in non-interactive context. Re-run with `--accept-cost` to proceed.');
      return { exitCode: 1 };
    }
    // TTY path: surface the warning and continue. A future revision should
    // prompt y/N here; for now the warning is informational and the operator
    // can Ctrl+C before launches actually begin.
    ui.info('Continuing (TTY). Use Ctrl+C to abort within the next 2 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — running ${queued.length} queued mission(s) in ${ui.accent(session.id)}`);
  ui.rule();

  // Lazy import — ralph-launcher pulls in node:child_process and other heavy
  // deps we don't want to pay for on every mc subcommand.
  const { launchExternalRalph } = await import('./ralph-launcher.js');

  let launched = 0;
  let skipped = 0;
  let failed = 0;
  const managed = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed';
  const allowanceOwner = managed ? await import('../../serve/shared-host-scheduler.js') : null;

  // Qualify every worker before admission; one parent retains completion gates.
  const workers = new Map<string, Awaited<ReturnType<typeof resolveMcWorker>>>();
  try {
    for (const mission of queued) if (workerDispatch(mission)) workers.set(mission.id, await resolveMcWorker(ctx, session, mission));
  } catch (error) { return managedControlFailure(error); }

  for (const mission of queued) {
    const worker = workers.get(mission.id);
    if (mission.mode === 'pty-orchestrator') {
      ui.warn(`Mission ${mission.id} mode=pty-orchestrator is not yet wired to mc run; skipping. Use 'aiwg ralph' directly for PTY-orchestrator workflows.`);
      skipped += 1;
      continue;
    }

    if (!mission.completion) {
      ui.warn(`Mission ${mission.id} has no --completion criteria; ralph requires one. Skipping. Re-dispatch with --completion "<criteria>" to include this mission.`);
      skipped += 1;
      continue;
    }

    const admissionRequestId = mission.admissionState === 'released'
      ? `${session.id}.${mission.id}.${Date.now().toString(36)}`
      : mission.admissionRequestId ?? worker?.dispatch.requestId ?? `${session.id}.${mission.id}`;
    const admissionSubmittedAt = mission.admissionState === 'released'
      ? new Date().toISOString()
      : mission.admissionSubmittedAt ?? new Date().toISOString();
    const admission = scheduler.submit({
      requestId: admissionRequestId,
      orchestratorId: session.id,
      environment: process.env.AIWG_ENVIRONMENT ?? 'default',
      provider: worker?.plan.invocation?.selected.inferenceProvider ?? provider,
      runtimeKind: 'host',
      priority: mission.priority === 'critical' ? 100 : mission.priority === 'high' ? 50 : mission.priority === 'low' ? 0 : 10,
      submittedAt: admissionSubmittedAt,
      queueTimeoutMs: managed ? (cfg?.parallelism?.admission?.queueTimeoutSeconds ?? 300) * 1000 : 24 * 60 * 60_000,
      preemptible: false,
      metadata: { missionId: mission.id, ...(worker ? { invocationId: worker.dispatch.invocationId } : {}) },
      ...(managed ? { managed: worker ? { kind: 'external' as const, group: worker.plan.selected!.group,
        member: worker.plan.selected!.member, cli: worker.plan.selected!.cli, model: worker.plan.selected!.modelKey,
        quotaScope: cfg!.parallelism!.clis![worker.plan.selected!.cli].quotaScope } : { kind: 'native' as const },
        allowance: worker ? { runId: session.id, taskId: worker.intent.taskId,
          taskBudgets: { maxAttempts: Math.min(worker.intent.limits.maxAttempts, mission.maxIterations),
            maxTokens: Math.min(worker.intent.limits.tokens, mission.maxTotalTokens ?? Infinity),
            maxCostUsd: worker.intent.limits.costUsd === null ? mission.maxTotalCost
              : Math.min(worker.intent.limits.costUsd, mission.maxTotalCost ?? Infinity),
            timeoutSeconds: Math.min(worker.intent.limits.wallSeconds, (mission.maxWallClockMinutes ?? Infinity) * 60) },
          reservation: { tokens: worker.plan.invocation!.limits.tokens, costUsd: worker.plan.invocation!.limits.costUsd },
        } : allowanceOwner!.managedAllowanceFromOwner(session.id, mission.id, {
          kind: 'ralph', maxIterations: mission.maxIterations, maxTotalTokens: mission.maxTotalTokens,
          maxTotalCost: mission.maxTotalCost, maxWallClockMinutes: mission.maxWallClockMinutes,
        }),
      } : {}),
    });
    mission.admissionRequestId = admissionRequestId;
    mission.admissionSubmittedAt = admissionSubmittedAt;
    mission.admissionState = admission.state;
    mission.admissionLeaseExpiresAt = admission.leaseExpiresAt;
    if (managed) mission.admissionGeneration = admission.leaseGeneration;
    await writeSession(session);
    if (admission.state !== 'admitted') {
      await appendLog(session.id, {
        event: 'mission_admission_queued',
        missionId: mission.id,
        admissionRequestId,
        reason: admission.reason,
      });
      ui.info(`Queued ${mission.id}: ${admission.reason}`);
      skipped += 1;
      continue;
    }

    try {
      let maxWallClockMinutes = mission.maxWallClockMinutes;
      if (managed) {
        const scopes = scheduler.snapshot().allowances!;
        const deadlines = [scopes[admission.accounting!.runKey]!.deadlineAt, scopes[admission.accounting!.taskKey]!.deadlineAt]
          .filter((value): value is string => value !== undefined).map(Date.parse);
        const remainingMs = Math.min(...deadlines) - Date.now();
        if (remainingMs <= 0) throw new Error('cumulative allowance deadline elapsed before launch');
        maxWallClockMinutes = deadlines.length ? remainingMs / 60_000 : undefined;
      }
      if (worker) {
        if (worker.brief.lease.generation !== mission.admissionGeneration || worker.brief.lease.reservationId !== admissionRequestId
          || worker.brief.lease.authorityRef !== 'project') throw new Error('Managed brief lease differs from current admission');
        const invocationPath = join(projectRoot, SESSIONS_DIR, session.id, `${mission.id}.invocation.json`);
        const runDir = join(projectRoot, SESSIONS_DIR, session.id, `${mission.id}.run`);
        await fs.writeFile(invocationPath, JSON.stringify(worker.plan), { mode: 0o600 });
        mission.managedWorker = { invocationPath, runDir };
      }
      if (managed) {
        scheduler.claimLaunch(admissionRequestId, mission.admissionGeneration!);
        mission.admissionLaunchClaimed = true;
        await writeSession(session);
      }
      const result = await launchExternalRalph(frameworkRoot, projectRoot, {
        objective: mission.objective,
        completionCriteria: mission.completion,
        maxIterations: managed ? admission.accounting!.attemptCount : mission.maxIterations,
        maxTotalTokens: managed ? admission.accounting!.reservation.tokens ?? undefined : mission.maxTotalTokens,
        maxOutputTokens: mission.maxOutputTokens,
        maxToolCalls: mission.maxToolCalls,
        maxTotalCost: managed ? admission.accounting!.reservation.costUsd ?? undefined : mission.maxTotalCost,
        maxWallClockMinutes,
        explorationQuota: mission.explorationQuota,
        budgetStopPolicy: mission.budgetStopPolicy,
        // Defaults for cycle 1; advanced options can be added per-mission later.
        verbose: false,
        ...(managed ? { managedAdmission: { requestId: admissionRequestId, generation: mission.admissionGeneration! } } : {}),
        ...(worker ? { managedWorker: mission.managedWorker } : {}),
      });

      if (managed) {
        if (!result.execution || result.execution.pid !== result.pid) throw new Error('managed launch requires its OS process birth identity');
        scheduler.bindExecution(admissionRequestId, mission.admissionGeneration!, result.execution);
        mission.admissionExecution = result.execution;
        mission.ralphLoopId = result.loopId;
        mission.ralphPid = result.pid;
        const current = scheduler.renew(admissionRequestId, mission.admissionGeneration);
        if (current.state !== 'admitted') {
          await cancelManagedMission(ctx, scheduler, mission);
          throw new Error('managed launch lost admission during execution checkpoint; reconcile uncertain work');
        }
      }
      mission.status = 'running';
      if (worker) worker.dispatch.state = 'running';
      mission.startedAt = new Date().toISOString();
      mission.ralphLoopId = result.loopId;
      mission.ralphPid = result.pid;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_started',
        missionId: mission.id,
        loopId: result.loopId,
        pid: result.pid,
      });

      ui.success(`Started ${mission.id} → ralph loop ${result.loopId} (PID ${result.pid})`);
      launched += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mission.status = 'failed';
      mission.error = msg;
      mission.completedAt = new Date().toISOString();
      if (managed) mission.admissionState = scheduler.stop(admissionRequestId, mission.admissionGeneration!, 'observer-loss').state;
      else {
        scheduler.release(admissionRequestId);
        mission.admissionState = 'released';
      }
      mission.admissionLeaseExpiresAt = undefined;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_launch_failed',
        missionId: mission.id,
        error: msg,
      });
      ui.error(`Failed to start ${mission.id}: ${msg}`);
      failed += 1;
    }
  }

  ui.blank();
  ui.info(`Launched: ${launched} | Skipped: ${skipped} | Failed: ${failed}`);
  if (launched > 0) {
    ui.info(`Monitor: \`aiwg mc status ${session.id}\` or \`aiwg mc watch ${session.id}\``);
  }

  return { exitCode: failed > 0 && launched === 0 ? 1 : 0 };
}

/**
 * Sync mission statuses from their backing ralph loop state files (#1439).
 *
 * Each mission launched by `mc run` carries a `ralphLoopId`. The ralph loop
 * writes its own session-state.json with a `status` field
 * (running|completed|failed|paused|aborted). This helper polls those files
 * and reflects the truth back into the mc session.json so `mc status` and
 * `mc watch` show actual progress without manual intervention.
 *
 * Sync is best-effort — a missing or unreadable ralph state file leaves the
 * mission status unchanged (typically 'running' until the ralph process
 * actually writes state).
 */
async function syncMissionsFromRalph(session: Session, projectRoot: string): Promise<boolean> {
  let mutated = false;
  const cfg = await readAdmissionConfig(projectRoot);
  const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  const managed = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed';
  for (const mission of session.missions) {
    const wasRunning = mission.status === 'running';
    if (!wasRunning && !(managed && mission.managedWorker && mission.admissionState === 'uncertain')) continue;
    if (!mission.ralphLoopId) continue;
    const ralphStatePath = join(
      projectRoot,
      '.aiwg',
      'ralph-external',
      'loops',
      mission.ralphLoopId,
      'session-state.json',
    );
    if (managed) {
      const current = mission.admissionRequestId ? scheduler.snapshot().records[mission.admissionRequestId] : undefined;
      if (!current || !mission.admissionGeneration || current.leaseGeneration !== mission.admissionGeneration) continue;
    }
    try {
      const state = managed && mission.managedWorker
        ? await readManagedWorkerState(mission, scheduler)
        : JSON.parse(await fs.readFile(ralphStatePath, 'utf-8'));
      const ralphStatus = String(state.status || '').toLowerCase();
      if (managed && mission.admissionRequestId && state.health !== undefined) {
        if (!validateWorkerPayload('workerHealthSummary', state.health).valid) throw new Error('invalid Ralph worker health');
        const observed = scheduler.observeHealth(mission.admissionRequestId, mission.admissionGeneration!, state.health as WorkerHealthSummary);
        mission.admissionState = observed.state;
        mutated = true;
      }
      // Map ralph status → mc mission status
      let nextStatus: MissionStatus | null = null;
      if (ralphStatus === 'completed') nextStatus = 'done';
      else if (ralphStatus === 'failed' || ralphStatus === 'crashed') nextStatus = 'failed';
      else if (ralphStatus === 'aborted') nextStatus = 'aborted';
      else if (ralphStatus === 'paused') nextStatus = 'paused';
      if (!wasRunning) nextStatus = null;
      // 'running' stays running

      // Reflect iteration count if available
      const iter = typeof state.iteration === 'number' ? state.iteration : (typeof state.currentIteration === 'number' ? state.currentIteration : null);
      if (iter !== null && iter !== mission.loop) {
        mission.loop = iter;
        mutated = true;
      }

      // mission.status is narrowed to 'running' by the early-continue above,
      // and nextStatus is one of {done, failed, aborted, paused}. So the
      // transition is always real when nextStatus is set — no equality
      // check needed.
      if (nextStatus) {
        mission.status = nextStatus;
        mission.completedAt = new Date().toISOString();
        if (nextStatus === 'failed' && typeof state.error === 'string') {
          mission.error = state.error;
        }
        mutated = true;
        if (mission.admissionRequestId) {
          if (managed) {
            if (!mission.managedWorker) {
              if (state.health) scheduler.acceptFinal(mission.admissionRequestId, mission.admissionGeneration!, state.health as WorkerHealthSummary);
            }
            if (mission.admissionState !== 'settled') mission.admissionState = scheduler.stop(mission.admissionRequestId, mission.admissionGeneration!, 'observer-loss').state;
          }
          else {
            try { scheduler.release(mission.admissionRequestId); } catch { /* already expired or released */ }
            mission.admissionState = 'released';
          }
          mission.admissionLeaseExpiresAt = undefined;
        }
      } else if (mission.admissionRequestId) {
        try {
          const renewed = managed
            ? scheduler.renew(mission.admissionRequestId, mission.admissionGeneration)
            : scheduler.renew(mission.admissionRequestId);
          mission.admissionState = renewed.state;
          mission.admissionLeaseExpiresAt = renewed.leaseExpiresAt;
          mutated = true;
        } catch {
          // An expired lease is reconciled on the next run; status remains best-effort.
        }
      }
    } catch {
      if (managed && mission.admissionRequestId) {
        mission.admissionState = scheduler.disconnect(mission.admissionRequestId, mission.admissionGeneration!).state;
        mission.admissionLeaseExpiresAt = undefined;
        mutated = true;
      }
      // Missing supervision preserves the last task status and all artifacts.
    }
  }
  if (mutated) {
    session.updatedAt = new Date().toISOString();
    await writeSession(session);
  }
  return mutated;
}

async function mcStatus(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const json = hasFlag(ctx.args, '--json');

  const session = await findActiveSession(sessionId);
  if (!session) {
    if (json) {
      console.log(JSON.stringify({ error: 'no_active_session' }));
    } else {
      ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session.');
    }
    return { exitCode: 1 };
  }

  // #1439: Sync mission statuses from ralph loop state files BEFORE display
  // so 'mc status' reflects the true state of any in-flight ralph processes
  // (otherwise missions launched by 'mc run' stay 'running' in mc.session.json
  // even after the ralph loop has completed).
  await syncMissionsFromRalph(session, ctx.cwd || process.cwd());

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return { exitCode: 0 };
  }

  const statusIcons: Record<MissionStatus, string> = {
    done: '✓',
    running: '⏳',
    queued: '⏺',
    failed: '✗',
    aborted: '⊘',
    paused: '⏸',
  };

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('MISSION CONTROL')} — ${ui.accent(session.name)}  [${session.id}]`);
  ui.rule(60);

  // Header
  // #1441: ui.dim() returns void (it prints) — wrapping in console.log emitted
  // a literal "undefined" between the header and the separator. Use dimText()
  // (returns a string) for inline styling.
  const header = `  ${'#'.padEnd(4)} ${'Mission'.padEnd(32)} ${'Mode'.padEnd(6)} ${'Status'.padEnd(12)} ${'Loop'.padEnd(8)} ${'Started'.padEnd(8)}`;
  console.log(ui.dimText(header));
  ui.rule(68);

  for (let i = 0; i < session.missions.length; i++) {
    const m = session.missions[i];
    const icon = statusIcons[m.status] || '?';
    const num = String(i + 1).padEnd(4);
    const obj = m.objective.length > 30 ? m.objective.slice(0, 27) + '...' : m.objective.padEnd(32);
    const modeTag = m.mode === 'pty-orchestrator' ? 'PTY'.padEnd(6) : '—'.padEnd(6);
    const status = `${icon} ${m.status.toUpperCase()}`.padEnd(12);
    const loop = m.status === 'queued' ? '—'.padEnd(8) : `${m.loop}/${m.maxIterations}`.padEnd(8);
    const started = m.startedAt ? new Date(m.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
    console.log(`  ${num} ${obj} ${modeTag} ${status} ${loop} ${started}`);
    // Show last action for PTY-orchestrated missions
    if (m.mode === 'pty-orchestrator' && m.lastAction && m.status === 'running') {
      console.log(ui.dimText(`       └─ Last: ${m.lastAction}`));
    }
  }

  ui.rule(68);

  const counts = {
    done: session.missions.filter(m => m.status === 'done').length,
    running: session.missions.filter(m => m.status === 'running').length,
    queued: session.missions.filter(m => m.status === 'queued').length,
    failed: session.missions.filter(m => m.status === 'failed').length,
  };

  console.log(`  ${session.missions.length} missions  |  ${counts.done} done  |  ${counts.running} running  |  ${counts.queued} queued  |  ${counts.failed} failed`);

  // #1361: Show project parallelism cap when one is configured.
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const active = counts.running + counts.queued;
      const cap = resolved.max_parallel_mc_missions;
      const overCap = active > cap ? ` ${ui.dim(`(${active - cap} over cap — queued)`)}` : '';
      console.log(`  Parallelism cap: ${active}/${cap} active${overCap}`);
    }
  } catch {
    // Non-fatal
  }

  ui.blank();

  return { exitCode: 0 };
}

async function managedControlScheduler(ctx: HandlerContext, missions: Mission[]) {
  const projectRoot = ctx.cwd || process.cwd();
  const cfg = await readAdmissionConfig(projectRoot);
  if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed') return undefined;
  const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  const snapshot = scheduler.snapshot();
  for (const mission of missions) {
    if (!mission.admissionRequestId) continue;
    const record = snapshot.records[mission.admissionRequestId];
    if (!record || !mission.admissionGeneration || record.leaseGeneration !== mission.admissionGeneration) {
      throw new Error('stale managed Mission checkpoint generation');
    }
  }
  return scheduler;
}

function managedControlFailure(error: unknown): HandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(message);
  return { exitCode: 1, message };
}

async function cancelManagedMission(
  ctx: HandlerContext, scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>, mission: Mission,
): Promise<void> {
  if (!mission.admissionRequestId) return;
  const cancelled = scheduler.cancel(mission.admissionRequestId, mission.admissionGeneration);
  mission.admissionState = cancelled.state;
  mission.admissionLeaseExpiresAt = undefined;
  if (cancelled.state !== 'uncertain' || !mission.ralphLoopId || !mission.admissionExecution) return;
  try {
    const { cancelManagedRalph } = await import('./ralph-launcher.js');
    await cancelManagedRalph(ctx.frameworkRoot, ctx.cwd || process.cwd(), mission.ralphLoopId, {
      requestId: mission.admissionRequestId, generation: mission.admissionGeneration!, execution: mission.admissionExecution,
    });
  } catch {
    // Reservation is already uncertain; unavailable signalling cannot release it.
  }
}

async function mcAbort(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const missionId = positional[1];

  if (!sessionId || !missionId) {
    ui.error('Usage: aiwg mc abort <session-id> <mission-id>');
    return { exitCode: 1 };
  }

  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try {
    const selected = await readSession(sessionId);
    managedScheduler = await managedControlScheduler(ctx, selected?.missions.filter(mission => mission.id === missionId) ?? []);
  } catch (error) { return managedControlFailure(error); }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(sessionId, 'cancel', missionId, flags.expectedUpdatedAt, flags.requestId, session => {
    const mission = session.missions.find(m => m.id === missionId);
    if (!mission) return 'target_not_found';
    if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'aborted') return 'invalid_state';
    mission.status = 'aborted';
    mission.completedAt = new Date().toISOString();
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  if (!result.replayed) {
    const mission = result.session.missions.find(candidate => candidate.id === missionId);
    if (mission?.admissionRequestId) {
      try {
        if (managedScheduler) {
          await cancelManagedMission(ctx, managedScheduler, mission);
          await writeSession(result.session);
        } else {
          const projectRoot = ctx.cwd || process.cwd();
          const cfg = await readAdmissionConfig(projectRoot);
          const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
          scheduler.cancel(mission.admissionRequestId);
        }
      } catch (error) {
        if (managedScheduler) return managedControlFailure(error);
        // Legacy leases keep their existing best-effort cancellation behavior.
      }
    }
  }

  ui.success(`${result.replayed ? 'Replayed' : 'Aborted'} mission: ${missionId}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcPause(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error('No active session to pause.');
    return { exitCode: 1 };
  }
  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try { managedScheduler = await managedControlScheduler(ctx, selected.missions.filter(mission => mission.status === 'running')); }
  catch (error) { return managedControlFailure(error); }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'pause', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    session.state = 'paused';
    for (const mission of session.missions) if (mission.status === 'running') mission.status = 'paused';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  if (!result.replayed && managedScheduler) {
    for (const mission of result.session.missions) {
      if (mission.status === 'paused') await cancelManagedMission(ctx, managedScheduler, mission);
    }
    await writeSession(result.session);
  }

  ui.success(`${result.replayed ? 'Replayed pause for' : 'Paused'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcResume(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected || selected.state !== 'paused') {
    ui.error('No paused session to resume.');
    return { exitCode: 1 };
  }
  try {
    const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    if (cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed') {
      const scheduler = await createMcAdmissionScheduler(ctx.cwd || process.cwd(), cfg);
      const snapshot = scheduler.snapshot();
      for (const mission of selected.missions.filter(candidate => candidate.status === 'paused')) {
        if (!mission.admissionRequestId) continue;
        const record = snapshot.records[mission.admissionRequestId];
        if (!record || record.leaseGeneration !== mission.admissionGeneration || record.state !== 'admitted') {
          throw new Error('managed resume requires current admission and reconciliation of uncertain work');
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'resume', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'paused') return 'invalid_state';
    session.state = 'active';
    for (const mission of session.missions) if (mission.status === 'paused') mission.status = 'running';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  ui.success(`${result.replayed ? 'Replayed resume for' : 'Resumed'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcStop(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const drain = hasFlag(ctx.args, '--drain');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to stop.');
    return { exitCode: 1 };
  }

  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try {
    managedScheduler = await managedControlScheduler(ctx, session.missions.filter(mission =>
      mission.status === 'queued' || (!drain && (mission.status === 'running' || mission.status === 'paused'))));
  } catch (error) { return managedControlFailure(error); }

  if (drain) {
    // Mark queued missions as aborted, let running finish
    for (const m of session.missions) {
      if (m.status === 'queued') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
    ui.info('Draining: queued missions cancelled, running missions will complete.');
  } else {
    // Abort all non-completed missions
    for (const m of session.missions) {
      if (m.status === 'running' || m.status === 'queued' || m.status === 'paused') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
  }

  if (managedScheduler) {
    for (const mission of session.missions) {
      if (mission.status === 'aborted') await cancelManagedMission(ctx, managedScheduler, mission);
    }
  }
  session.state = 'stopped';
  await writeSession(session);
  await appendLog(session.id, { event: 'session_stopped', drain });

  ui.success(`Stopped session: ${session.id}`);
  return { exitCode: 0 };
}

async function mcList(ctx: HandlerContext): Promise<HandlerResult> {
  const json = hasFlag(ctx.args, '--json');
  const sessions = await listSessions();

  if (json) {
    console.log(JSON.stringify(sessions.map(s => ({
      id: s.id,
      name: s.name,
      state: s.state,
      missions: s.missions.length,
      created: s.createdAt,
      updated: s.updatedAt,
    })), null, 2));
    return { exitCode: 0 };
  }

  if (sessions.length === 0) {
    ui.info('No Mission Control sessions. Run `aiwg mc start` to create one.');
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control Sessions')}`);
  ui.rule();

  for (const s of sessions) {
    const stateIcon = s.state === 'active' ? '●' : s.state === 'paused' ? '⏸' : '○';
    const missionCount = s.missions.length;
    const done = s.missions.filter(m => m.status === 'done').length;
    console.log(`  ${stateIcon} ${s.id}  ${ui.accent(s.name)}  (${done}/${missionCount} done)  [${s.state}]`);
  }

  ui.blank();
  return { exitCode: 0 };
}

async function mcWatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to watch.');
    return { exitCode: 1 };
  }

  // For non-interactive contexts, show status once with a note
  // Real streaming would use fs.watch on the session file
  ui.info(`Watch mode: polling session ${session.id}`);
  ui.info('Press Ctrl+C to stop watching.');
  ui.blank();

  // Show current status
  ctx.args = [session.id];
  return mcStatus(ctx);
}

// ── Agent routing query ──────────────────────────────────────

/**
 * aiwg mc agents [--filter key=value...] [--json]
 *
 * Queries GET /api/agents/candidates on the local aiwg serve instance and
 * prints a table of agents that match the given routing filter. This is a thin
 * CLI wrapper over the #916 routing endpoint so operators can check routing
 * from a terminal without opening the dashboard.
 *
 * Filter flags:
 *   --framework <name>       Require a specific AIWG framework (repeatable)
 *   --sandbox <id>           Restrict to a specific sandbox
 *   --agent <id>             Restrict to a specific agent ID
 *   --name <n>               Match by logical name
 *   --max-cpu <pct>          Reject agents above this CPU %
 *   --min-memory <gb>        Reject agents below this memory threshold
 *   --json                   Output raw JSON
 */
async function mcAgents(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args;
  const json = hasFlag(args, '--json');

  const port = process.env['AIWG_SERVE_PORT'] ?? '7337';
  const base = `http://127.0.0.1:${port}`;

  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--framework' && args[i + 1]) { params.append('frameworks', args[++i]!); }
    else if (a === '--sandbox' && args[i + 1]) { params.set('sandbox_id', args[++i]!); }
    else if (a === '--agent' && args[i + 1]) { params.set('agent_id', args[++i]!); }
    else if (a === '--name' && args[i + 1]) { params.set('agent_name', args[++i]!); }
    else if (a === '--max-cpu' && args[i + 1]) { params.set('max_cpu_percent', args[++i]!); }
    else if (a === '--min-memory' && args[i + 1]) { params.set('min_memory_gb', args[++i]!); }
  }

  // 5s timeout so a wedged serve cannot hang the CLI. Override with
  // AIWG_FETCH_TIMEOUT_MS for slow local environments or integration tests.
  const fetchTimeoutMs = (() => {
    const raw = process.env['AIWG_FETCH_TIMEOUT_MS'];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 5_000;
  })();

  let result: { selected?: Record<string, unknown>; candidates: Record<string, unknown>[] };
  try {
    // Combine user-cancel (Ctrl-C) with the per-call timeout so the fetch
    // aborts on either. `AbortSignal.any` requires Node 20+.
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(fetchTimeoutMs)])
      : AbortSignal.timeout(fetchTimeoutMs);
    const resp = await fetch(`${base}/api/agents/candidates?${params.toString()}`, {
      signal,
    });
    if (!resp.ok) {
      ui.error(`aiwg serve returned ${resp.status} — is it running on port ${port}?`);
      return { exitCode: 1 };
    }
    result = await resp.json() as typeof result;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      ui.error(`aiwg serve on port ${port} timed out after ${fetchTimeoutMs}ms. Is it wedged?`);
    } else {
      ui.error(`Cannot reach aiwg serve on port ${port}. Start it with: aiwg serve`);
    }
    return { exitCode: 1 };
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Agent Routing Candidates')}`);
  ui.rule();

  if (result.candidates.length === 0) {
    ui.info('No matching agents found for the given filter.');
    return { exitCode: 0 };
  }

  for (const c of result.candidates) {
    const agent = c['agent'] as Record<string, unknown> | undefined;
    const agentId = agent?.['agentId'] as string ?? '?';
    const logicalName = agent?.['logicalName'] as string | undefined;
    const sandboxName = c['sandboxName'] as string ?? '';
    const cpu = (agent?.['latestMetrics'] as Record<string, number> | undefined)?.['cpu_percent'];
    const status = agent?.['status'] as string ?? '';
    const isSelected = (result.selected as Record<string, unknown> | undefined)?.['sandboxName'] === sandboxName &&
      ((result.selected as Record<string, unknown>)?.['agent'] as Record<string, unknown> | undefined)?.['agentId'] === agentId;

    const label = logicalName ? `${logicalName} (${agentId})` : agentId;
    const cpuStr = cpu !== undefined ? ` cpu:${cpu.toFixed(0)}%` : '';
    const selectedMark = isSelected ? ' ← selected' : '';
    console.log(`  • ${ui.bold(label)}  sandbox:${sandboxName}  status:${status}${cpuStr}${selectedMark}`);
    const reason = c['matchReason'] as string | undefined;
    if (reason) console.log(`      reason: ${reason}`);
  }

  ui.blank();
  return { exitCode: 0 };
}

// ── Subcommand router ────────────────────────────────────────

const subcommands: Record<string, (ctx: HandlerContext) => Promise<HandlerResult>> = {
  start: mcStart,
  dispatch: mcDispatch,
  run: mcRun, // #1439
  status: mcStatus,
  watch: mcWatch,
  abort: mcAbort,
  cancel: mcAbort,
  pause: mcPause,
  resume: mcResume,
  stop: mcStop,
  list: mcList,
  agents: mcAgents,
};

function showMcHelp(): void {
  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — multi-loop background orchestration`);
  ui.rule();
  console.log(`
  ${ui.bold('Usage:')} aiwg mc <subcommand> [options]

  ${ui.bold('Lifecycle:')}
    1. start    — create a session (state-tracking only)
    2. dispatch — queue one or more missions onto a session
    3. run      — drain the queue by launching each mission as a ralph loop
    4. status   — view progress (auto-syncs from ralph loop state)
    5. watch    — live tail of progress
    6. stop     — shut down the session

  ${ui.bold('Subcommands:')}
    start                         Start a new Mission Control session
    dispatch <id> "<objective>"   Queue a mission on the session (does NOT execute)
                                  [--completion "<criteria>"] [--max-iterations N]
                                  [--max-total-tokens N] [--max-output-tokens N]
                                  [--max-tool-calls N] [--max-total-cost USD]
                                  [--max-wall-clock-minutes N] [--exploration-quota N]
                                  [--mode pty-orchestrator] [--target-agent <id>]
    run <id> [--accept-cost]      Launch queued missions as ralph loops (#1439)
                                  Cost gate warns/refuses above ~$5 estimate
    status [<id>] [--json]        View mission status dashboard
    watch [<id>]                  Live monitor (streaming)
    abort|cancel <session> <mission> Abort a specific mission
    pause [<id>]                  Pause active session
    resume [<id>]                 Resume paused session
    stop [<id>] [--drain]         Shut down session
    list [--json]                 List all sessions
    agents [--filter] [--json]    Query routable agents from aiwg serve (#916)
  ${ui.bold('Examples:')}
    aiwg mc start --name "Sprint 4"
    aiwg mc dispatch mc-abc123 "Fix auth" --completion "tests pass"
    aiwg mc dispatch mc-abc123 "Fix auth" --completion "tests pass" --max-total-tokens 5000 --exploration-quota 2
    aiwg mc dispatch mc-abc123 "Refactor users" --completion "npm test passes"
    aiwg mc run mc-abc123                     # launches queued missions
    aiwg mc status mc-abc123                  # syncs progress from ralph loops
    aiwg mc dispatch mc-abc123 "Supervise agent-01" --mode pty-orchestrator --target-agent agent-01 --completion "migration complete"
    aiwg mc stop mc-abc123 --drain
    aiwg mc agents --framework sdlc-complete --max-cpu 80

  ${ui.bold('A2A route for new sandbox work:')}
    GET  /api/v2/admin/instances
    GET  /agents/{instance_id}/.well-known/agent-card.json
    GET  /agents/{instance_id}/v1/extendedAgentCard
    POST /agents/{instance_id}/v1/messages:send
`);
}

// ── Exported handler ─────────────────────────────────────────

export const mcHandler: CommandHandler = {
  id: 'mc',
  name: 'Mission Control',
  description: 'Multi-loop background orchestration (start, dispatch, status, watch, stop)',
  category: 'orchestration',
  aliases: ['mission-control'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      showMcHelp();
      return { exitCode: 0 };
    }

    const handler = subcommands[subcmd];
    if (!handler) {
      ui.error(`Unknown subcommand: ${subcmd}. Run 'aiwg mc --help' for usage.`);
      return { exitCode: 1 };
    }

    // #1440: '--help' / '-h' on any subcommand prints usage and exits BEFORE
    // any side-effecting logic. The previous behavior — e.g. 'mc start --help'
    // actually creating a session — violated the universal --help convention.
    const subArgs = ctx.args.slice(1);
    if (wantsHelp(subArgs)) {
      printSubcommandHelp(subcmd);
      return { exitCode: 0 };
    }

    // Pass remaining args to subcommand
    const subCtx: HandlerContext = {
      ...ctx,
      args: subArgs,
    };

    return handler(subCtx);
  },
};

/**
 * All MC-related handlers for bulk registration
 */
export const mcHandlers: CommandHandler[] = [mcHandler];
