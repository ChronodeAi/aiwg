/**
 * Executor Registry
 *
 * Manages registered executor instances per the executor contract v1 spec
 * (docs/contracts/executor.v1.md). Each executor registers with
 * `aiwg serve` via POST /api/v1/executors/register and then pushes
 * real-time events over WebSocket at /ws/executors/:executorId.
 *
 * This is the AIWG-side dispatch surface for the executor contract epic.
 * Executor implementations (sandbox adapter, local executor) are in sibling issues.
 *
 * @issue #1179
 * @see #1177 — executor-contract epic
 * @see #1178 — JSON Schema + conformance fixtures (schemas/executor-v1.json)
 * @see docs/contracts/executor.v1.md — authoritative prose spec
 */

import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { constants, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, fsyncSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { FileAdmissionStore, hostProjectAdmissionPolicy, type AdmissionStore, type SharedHostPolicy } from './shared-host-scheduler.js';
import type { MissionA2ABinding } from './mission-hitl.js';
import type {
  A2AProtocolPolicy,
  A2AProtocolVersion,
  NormalizedAgentInterface,
} from '../a2a/types.js';

// ============================================================
// Ajv bootstrap (transitive dep — zero new top-level deps)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _validateRegisterPayload: ((data: unknown) => boolean) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _validateEventEnvelope: ((data: unknown) => boolean) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _validateDispatchPayload: ((data: unknown) => boolean) | null = null;
function loadValidators(): void {
  if (_validateRegisterPayload !== null) return; // already loaded

  try {
    const require = createRequire(fileURLToPath(import.meta.url));
    const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const ajvPaths = [
      join(projectRoot, 'node_modules', 'ajv', 'dist', '2020.js'),
      join(projectRoot, 'node_modules', 'ajv', 'dist', 'ajv.js'),
    ];
    const formatsPath = join(projectRoot, 'node_modules', 'ajv-formats', 'dist', 'index.js');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Ajv: any = null;
    for (const p of ajvPaths) {
      if (existsSync(p)) {
        try { Ajv = require(p); break; } catch { /* try next */ }
      }
    }
    if (!Ajv) return; // graceful: validators stay null, schema checks skipped

    const AjvClass = Ajv?.default ?? Ajv;
    // validateSchema: false — prevents AJV from trying to fetch the draft-2020-12
    // meta-schema URI at runtime. The Ajv2020 constructor already implies the dialect.
    const ajv = new AjvClass({ strict: false, allErrors: true, validateSchema: false });

    if (existsSync(formatsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fmtMod: any = require(formatsPath);
        const addFormats = fmtMod?.default ?? fmtMod;
        if (typeof addFormats === 'function') addFormats(ajv);
      } catch { /* formats optional */ }
    }

    const schemaPath = join(projectRoot, 'schemas', 'executor-v1.json');
    if (!existsSync(schemaPath)) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema: any = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    ajv.addSchema(schema, 'executor.aiwg.io/v1');

    _validateRegisterPayload = ajv.compile({ $ref: 'executor.aiwg.io/v1#/$defs/register_payload' });
    _validateEventEnvelope   = ajv.compile({ $ref: 'executor.aiwg.io/v1#/$defs/event_envelope' });
    _validateDispatchPayload = ajv.compile({ $ref: 'executor.aiwg.io/v1#/$defs/dispatch_payload' });
  } catch { /* validation degraded to no-op */ }
}

export function validateRegisterPayload(data: unknown): { valid: boolean; errors: string } {
  loadValidators();
  if (!_validateRegisterPayload) return { valid: true, errors: '' }; // graceful degradation
  const valid = _validateRegisterPayload(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errors = valid ? '' : JSON.stringify((_validateRegisterPayload as any).errors ?? []);
  return { valid, errors };
}

export function validateEventEnvelope(data: unknown): { valid: boolean; errors: string } {
  loadValidators();
  if (!_validateEventEnvelope) return { valid: true, errors: '' };
  const valid = _validateEventEnvelope(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errors = valid ? '' : JSON.stringify((_validateEventEnvelope as any).errors ?? []);
  return { valid, errors };
}

export function validateDispatchPayload(data: unknown): { valid: boolean; errors: string } {
  loadValidators();
  if (!_validateDispatchPayload) return { valid: true, errors: '' };
  const valid = _validateDispatchPayload(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errors = valid ? '' : JSON.stringify((_validateDispatchPayload as any).errors ?? []);
  return { valid, errors };
}

// ============================================================
// Token issuance
// ============================================================

/**
 * Issue an opaque bearer token — base64url, 32 bytes of entropy.
 * Returned once at register time. Re-register with same executor_id reclaims
 * the prior identity (per ADR §9); the token is NOT rotated on re-register.
 */
function issueToken(): string {
  return randomBytes(32).toString('base64url');
}

// ============================================================
// Types
// ============================================================

/** Transport endpoints as declared in the schema. */
export interface TransportEndpoints {
  rest: string;
  ws: string;
  grpc?: string;
}

/** One active mission tracked by aiwg serve. */
export interface MissionRecord {
  a2a?: MissionA2ABinding;
  missionId: string;
  executorId: string;
  state: MissionState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  recentEvents: EventEnvelope[];
  ptySessionRef?: string;
  exitCode?: number;
  error?: string;
}

export type MissionState =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'paused'
  | 'hitl-required'
  | 'suspended'
  | 'done'
  | 'failed'
  | 'aborted';

/** The terminal states — mission is done and won't change again. */
const TERMINAL_STATES: ReadonlySet<MissionState> = new Set(['done', 'failed', 'aborted']);

export interface EventEnvelope {
  event: string;
  executor_id: string;
  mission_id?: string;
  ts: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, unknown>;
}

/** Per-executor registration record (in-memory). */
export interface ExecutorRegistration {
  /** Stable executor UUID — declared by the executor at registration time. */
  executorId: string;
  /** Optional default A2A sandbox instance id. May differ from executorId. */
  a2aInstanceId?: string;
  /** Last negotiated A2A interface. Cleared when the executor re-registers. */
  a2aProtocol?: A2AProtocolSelectionState;
  name: string;
  version: string;
  specVersion: string;
  transportEndpoints: TransportEndpoints;
  capabilities: string[];
  /** Bearer token issued at first registration; preserved across re-registers. */
  token: string;
  connected: boolean;
  lastEventTs?: string;
  registeredAt: string;
  disconnectedAt?: string;
  /** Non-terminal missions currently owned by this executor. */
  currentMissions: Set<string>;
  /** Live WS connection handle (set by serve.ts on WS upgrade). */
  wsConn?: WebSocketConn;
}

export interface A2AProtocolSelectionState {
  policy: A2AProtocolPolicy;
  selectedVersion: A2AProtocolVersion;
  interface: NormalizedAgentInterface;
  fallbackReason?: string;
  selectedAt: string;
}

/** Minimal WS connection interface (duck-typed from the `ws` package). */
export interface WebSocketConn {
  readyState: number; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Serializable executor summary (used in API responses). */
export interface ExecutorSummary {
  executor_id: string;
  a2a_instance_id?: string;
  a2a_protocol?: {
    policy: A2AProtocolPolicy;
    selected_version: A2AProtocolVersion;
    protocol_binding: string;
    interface_url: string;
    fallback_reason?: string;
    selected_at: string;
  };
  name: string;
  version: string;
  spec_version: string;
  transport_endpoints: TransportEndpoints;
  capabilities: string[];
  connected: boolean;
  last_event_ts?: string;
  active_mission_count: number;
  registered_at: string;
  disconnected_at?: string;
}

/** Request body for POST /api/v1/executors/register (wire shape). */
export interface ExecutorRegisterRequest {
  executor_id: string;
  a2a_instance_id?: string;
  name: string;
  version: string;
  spec_version: string;
  transport_endpoints: TransportEndpoints;
  capabilities: string[];
}

/** Response body for 201 Created. */
export interface ExecutorRegisterResponse {
  executor_id: string;
  token: string;
  registered_at: string;
}

/** Persistent token record saved across server restarts (#969 pattern). */
interface ExecutorIdentityRecord {
  executorId: string;
  token?: string;
  lastSeenAt: string;
  /** Trusted bootstrap data; never copied from the executor wire payload. */
  hostAdmission?: { authorityRef: string; path: string; version: string; workerWritableRoots: string[]; revisionSupport: 1 };
}

/** Filter criteria for executor selection (mirrors ExecutorFilter schema). */
export interface ExecutorFilter {
  /** Pin to specific executor. null = any. */
  executor_id?: string | null;
  /** Executor must advertise ALL listed capabilities. */
  capabilities?: string[];
}

/** Result of picking an executor via pickByFilter(). */
export interface ExecutorPickResult {
  executor: ExecutorRegistration;
  reason: string;
  rejected: Array<{ executorId: string; reason: string }>;
}

// ============================================================
// Identity store (#969 pattern — atomic writes)
// ============================================================

const DEFAULT_EXECUTOR_IDENTITY_STORE_PATH = join(homedir(), '.config', 'aiwg', 'executor-identities.json');

export function resolveExecutorIdentityStorePath(projectRootOverride?: string): string {
  const envOverride = process.env['AIWG_EXECUTOR_IDENTITY_STORE'];
  if (envOverride) return envOverride;

  const projectRoot = projectRootOverride ?? process.cwd();
  const configPath = projectAiwgPath(projectRoot, 'storage.config');
  if (!existsSync(configPath)) return DEFAULT_EXECUTOR_IDENTITY_STORE_PATH;

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      version?: string;
      roots?: Record<string, string>;
    };
    if (parsed.version !== '1') return DEFAULT_EXECUTOR_IDENTITY_STORE_PATH;
    const override = parsed.roots?.['executor_identity'];
    if (override) {
      let resolved = override;
      if (resolved.startsWith('~/')) resolved = join(homedir(), resolved.slice(2));
      else if (resolved === '~') resolved = homedir();
      else if (!isAbsolute(resolved)) resolved = resolvePath(projectRoot, resolved);
      return join(resolved, 'executor-identities.json');
    }
  } catch { /* fall through */ }
  return DEFAULT_EXECUTOR_IDENTITY_STORE_PATH;
}

function loadExecutorIdentityStore(path = resolveExecutorIdentityStorePath(), strict = false): Map<string, ExecutorIdentityRecord> {
  try {
    if (existsSync(path)) {
      let contents: string;
      if (strict) {
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(file);
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw new Error('host registration must be a private bounded regular file');
          contents = readFileSync(file, 'utf-8');
        } finally { closeSync(file); }
      } else contents = readFileSync(path, 'utf-8');
      const data = JSON.parse(contents) as ExecutorIdentityRecord[];
      if (strict && (!Array.isArray(data) || data.some(record => !record || typeof record.executorId !== 'string' || !record.executorId)
        || new Set(data.map(record => record.executorId)).size !== data.length)) throw new Error('invalid trusted executor identity store');
      return new Map(data.map((r) => {
        if (strict) return [r.executorId, r];
        const { hostAdmission: _hostAdmission, ...identity } = r;
        return [r.executorId, identity];
      }));
    }
  } catch (error) { if (strict) throw error; /* legacy best effort */ }
  return new Map();
}

function saveExecutorIdentityStore(store: Map<string, ExecutorIdentityRecord>, path = resolveExecutorIdentityStorePath(), strict = false): void {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, ...(strict ? { mode: 0o700 } : {}) });
    if (strict) assertHostRegistrationPath(path, []);
    const tmp = `${path}.tmp.${process.pid}`;
    if (strict) {
      const file = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(file, JSON.stringify([...store.values()], null, 2)); fsyncSync(file); } finally { closeSync(file); }
    } else writeFileSync(tmp, JSON.stringify([...store.values()], null, 2), 'utf-8');
    try {
      renameSync(tmp, path);
      if (strict) {
        const directory = openSync(dir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  } catch (error) { if (strict) throw error; /* legacy best effort */ }
}

/** Host registration has a fixed user authority location, independent of project
 * storage redirects. A trusted embedding may provide an explicit location. */
function assertHostRegistrationPath(path: string, workerWritableRoots: string[]): void {
  const parent = dirname(path);
  if (!isAbsolute(path) || realpathSync(parent) !== resolvePath(parent)) throw new Error('host registration requires a canonical absolute path');
  const directory = lstatSync(parent);
  if ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error('host registration directory must be private');
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw new Error('host registration must be a private bounded regular file');
  }
  for (const root of workerWritableRoots) {
    const within = relative(realpathSync(root), path);
    if (!within || (!within.startsWith('../') && within !== '..' && !isAbsolute(within))) throw new Error('worker writable mount includes the host registration');
  }
}

// ============================================================
// Max recent events kept per mission
// ============================================================

const MAX_MISSION_EVENTS = 50;

// ============================================================
// Registry class
// ============================================================

/**
 * ExecutorRegistry — state, auth, and identity store integration for
 * registered executor instances. Parallel to SandboxRegistry.
 *
 * Emits EventEmitter events:
 *   'executor:registered'   — { executorId, name }
 *   'executor:deregistered' — { executorId, reason }
 *   'mission:assigned'      — { missionId, executorId }
 *   'mission:state_change'  — { missionId, executorId, state, prevState }
 */
export class ExecutorRegistry extends EventEmitter {
  private executors = new Map<string, ExecutorRegistration>();
  private admissionAuthorities = new Map<string, { executorId: string; version: string; store: AdmissionStore; restored?: boolean }>();
  private missions  = new Map<string, MissionRecord>();
  /** Persistent token store — executorId → identity record */
  private identityStore: Map<string, ExecutorIdentityRecord>;

  constructor(private readonly hostIdentityStorePath = DEFAULT_EXECUTOR_IDENTITY_STORE_PATH) {
    super();
    this.identityStore = loadExecutorIdentityStore();
  }

  /** Trusted service bootstrap only. This is deliberately absent from the public
   * executor registration payload: an executor cannot grant itself host authority.
   * The owner supplies the protected existing AdmissionStore, never a project path. */
  installHostAdmissionAuthority(executorId: string, version: string, store: AdmissionStore, workerWritableRoots: string[]): void {
    const executor = this.executors.get(executorId);
    const binding = store.read().hostBinding;
    if (!executor || executor.version !== version || !executor.capabilities.includes('x-admission-policy-revision:1') || !binding) {
      throw new Error('qualified executor and revision-aware host admission binding are required');
    }
    if (store instanceof FileAdmissionStore) store.protectHostAuthority(workerWritableRoots);
    else if (!Array.isArray(workerWritableRoots)) throw new Error('worker writable roots are required');
    const previous = this.admissionAuthorities.get(binding.authorityRef);
    if (previous && (previous.executorId !== executorId || previous.store !== store || previous.version !== version)) throw new Error('host admission authority is already installed');
    if (store instanceof FileAdmissionStore) {
      mkdirSync(dirname(this.hostIdentityStorePath), { recursive: true, mode: 0o700 });
      assertHostRegistrationPath(this.hostIdentityStorePath, workerWritableRoots);
      const identities = loadExecutorIdentityStore(this.hostIdentityStorePath, true);
      const identity = identities.get(executorId) ?? { executorId, lastSeenAt: new Date().toISOString() };
      identities.set(executorId, { ...identity, token: executor.token, hostAdmission: { authorityRef: binding.authorityRef,
        path: store.hostAuthorityPath(), version, workerWritableRoots: [...workerWritableRoots], revisionSupport: 1 } });
      saveExecutorIdentityStore(identities, this.hostIdentityStorePath, true);
    }
    if (store.read().hostRegistrationRevoked) store.transact(snapshot => { snapshot.hostRegistrationRevoked = false; });
    this.admissionAuthorities.set(binding.authorityRef, { executorId, version, store });
  }

  resolveHostAdmissionAuthority(authorityRef: string, projectPolicy: SharedHostPolicy): { store: AdmissionStore; policy: SharedHostPolicy } {
    if (!this.admissionAuthorities.has(authorityRef) && existsSync(this.hostIdentityStorePath)) {
      assertHostRegistrationPath(this.hostIdentityStorePath, []);
      const identities = loadExecutorIdentityStore(this.hostIdentityStorePath, true);
      for (const identity of identities.values()) {
        const installed = identity.hostAdmission;
        if (installed?.authorityRef !== authorityRef) continue;
        if (installed.revisionSupport !== 1 || !Array.isArray(installed.workerWritableRoots)) throw new Error('host registration lacks policy revision support');
        assertHostRegistrationPath(this.hostIdentityStorePath, installed.workerWritableRoots);
        const store = new FileAdmissionStore(installed.path);
        store.protectHostAuthority(installed.workerWritableRoots);
        if (store.read().hostBinding?.authorityRef !== authorityRef) throw new Error('host registration authority reference mismatch');
        this.admissionAuthorities.set(authorityRef, { executorId: identity.executorId, version: installed.version, store, restored: true });
      }
    }
    const installed = this.admissionAuthorities.get(authorityRef);
    if (installed?.store instanceof FileAdmissionStore) {
      assertHostRegistrationPath(this.hostIdentityStorePath, []);
      const current = loadExecutorIdentityStore(this.hostIdentityStorePath, true).get(installed.executorId)?.hostAdmission;
      if (!current || current.authorityRef !== authorityRef || current.version !== installed.version
        || current.path !== installed.store.hostAuthorityPath()) throw new Error('trusted host executor registration has been revoked or changed');
    }
    const executor = installed && this.executors.get(installed.executorId);
    if (!installed || (!executor && !installed.restored) || (executor && (executor.version !== installed.version || !executor.capabilities.includes('x-admission-policy-revision:1')))) {
      throw new Error('missing current revision-aware trusted host executor binding');
    }
    const snapshot = installed.store.read();
    if (snapshot.hostRegistrationRevoked) throw new Error('trusted host executor registration is revoked');
    const approved = snapshot.hostBinding?.projects[projectPolicy.managed!.projectId]?.policy;
    // Compare complete approved input, including defaults, rather than trusting a
    // caller's activation digest to cover its effective limits.
    const normalize = (value: unknown): string => JSON.stringify(value, function (_key, node) {
      return node && typeof node === 'object' && !Array.isArray(node)
        ? Object.fromEntries(Object.keys(node).sort().filter(key => node[key] !== undefined).map(key => [key, node[key]])) : node;
    });
    if (snapshot.hostBinding?.authorityRef !== authorityRef || normalize(approved) !== normalize(projectPolicy)) throw new Error('project policy is not approved by the host authority');
    return { store: installed.store, policy: hostProjectAdmissionPolicy(snapshot, projectPolicy.managed!.projectId) };
  }

  private revokeHostAdmissionAuthority(executorId: string): void {
    const installed = [...this.admissionAuthorities.values()].filter(entry => entry.executorId === executorId);
    const stored = this.loadHostIdentities().get(executorId)?.hostAdmission;
    if (stored && !installed.length) {
      const store = new FileAdmissionStore(stored.path);
      store.protectHostAuthority(stored.workerWritableRoots);
      installed.push({ executorId, version: stored.version, store });
    }
    if (!installed.length) return;
    // Fence first. A failed registration write can leave a discoverable binding,
    // but cannot make an old scheduler's policy current again.
    for (const entry of installed) entry.store.transact(snapshot => {
      if (snapshot.hostBinding) { snapshot.hostBinding.revision++; snapshot.hostRegistrationRevoked = true; }
    });
    if (installed.some(entry => entry.store instanceof FileAdmissionStore)) {
      assertHostRegistrationPath(this.hostIdentityStorePath, []);
      const identities = loadExecutorIdentityStore(this.hostIdentityStorePath, true);
      const identity = identities.get(executorId);
      if (identity) { delete identity.hostAdmission; saveExecutorIdentityStore(identities, this.hostIdentityStorePath, true); }
    }
    for (const [ref, entry] of this.admissionAuthorities) if (entry.executorId === executorId) this.admissionAuthorities.delete(ref);
  }

  private loadHostIdentities(): Map<string, ExecutorIdentityRecord> {
    if (!existsSync(this.hostIdentityStorePath)) return new Map();
    assertHostRegistrationPath(this.hostIdentityStorePath, []);
    return loadExecutorIdentityStore(this.hostIdentityStorePath, true);
  }

  // ---- Registration ----

  /**
   * Register an executor. Validates payload against `register_payload` schema.
   * Returns a 400 error on invalid payload or 401 for unauthorized host re-registration.
   * Host-bound IDs require the current bearer token before any update.
   * Other IDs reclaim the prior token on re-register (per ADR §9; #3439).
   */
  register(req: ExecutorRegisterRequest, bearerToken = ''): ExecutorRegisterResponse | { error: string; status: 400 | 401 } {
    // Validate against JSON Schema
    const { valid, errors } = validateRegisterPayload(req);
    if (!valid) {
      return { error: `Invalid register payload: ${errors}`, status: 400 };
    }

    const now = new Date().toISOString();
    const { executor_id: executorId } = req;

    // Check for existing token in identity store (re-register reclaims it)
    const existing = this.executors.get(executorId);
    const storedIdentity = this.identityStore.get(executorId);
    const hostRecord = this.loadHostIdentities().get(executorId);
    const hostAdmission = hostRecord?.hostAdmission;
    const installedAuthority = [...this.admissionAuthorities.values()].find(binding => binding.executorId === executorId);
    // Host-bound IDs authenticate only against the live executor or the protected
    // host record, never the environment/project-selectable identity store.
    const hostToken = this.executors.get(executorId)?.token ?? hostRecord?.token;
    if ((hostAdmission || installedAuthority) && (!bearerToken || !hostToken || hostToken !== bearerToken)) {
      return { error: 'Unauthorized', status: 401 };
    }
    const token = existing?.token ?? storedIdentity?.token ?? issueToken();
    if ((hostAdmission && (hostAdmission.version !== req.version || !req.capabilities.includes('x-admission-policy-revision:1')))
      || (installedAuthority && (installedAuthority.version !== req.version || !req.capabilities.includes('x-admission-policy-revision:1')))) {
      this.revokeHostAdmissionAuthority(executorId);
    }

    // Update or create in-memory registration
    if (existing) {
      // Upsert — preserve token and registeredAt
      existing.name = req.name;
      existing.a2aInstanceId = req.a2a_instance_id;
      delete existing.a2aProtocol;
      existing.version = req.version;
      existing.specVersion = req.spec_version;
      existing.transportEndpoints = req.transport_endpoints;
      existing.capabilities = req.capabilities;
      existing.connected = false; // WS will update this on upgrade
    } else {
      const registration: ExecutorRegistration = {
        executorId,
        a2aInstanceId: req.a2a_instance_id,
        name: req.name,
        version: req.version,
        specVersion: req.spec_version,
        transportEndpoints: req.transport_endpoints,
        capabilities: req.capabilities,
        token,
        connected: false,
        registeredAt: now,
        currentMissions: new Set(),
      };
      this.executors.set(executorId, registration);
    }

    // Persist token to identity store
    this.identityStore.set(executorId, {
      executorId,
      token,
      lastSeenAt: now,
    });
    const identityPath = resolveExecutorIdentityStorePath();
    if (identityPath === this.hostIdentityStorePath) {
      mkdirSync(dirname(this.hostIdentityStorePath), { recursive: true, mode: 0o700 });
      const identities = this.loadHostIdentities();
      for (const [id, identity] of this.identityStore) identities.set(id, { ...identities.get(id), ...identity });
      saveExecutorIdentityStore(identities, this.hostIdentityStorePath, true);
    } else saveExecutorIdentityStore(this.identityStore, identityPath);

    // Emit event (for dashboard SSE, etc.)
    this.emit('executor:registered', { executorId, name: req.name });

    return {
      executor_id: executorId,
      token,
      registered_at: existing?.registeredAt ?? now,
    };
  }

  /**
   * Deregister an executor by ID. Auth must be checked by the caller.
   * Emits 'executor:deregistered'.
   */
  deregister(executorId: string, reason: 'graceful_shutdown' | 'operator_deleted' | 'timeout' = 'operator_deleted'): boolean {
    const executor = this.executors.get(executorId);
    if (!executor) return false;
    this.revokeHostAdmissionAuthority(executorId);

    // Close WS if open
    if (executor.wsConn && executor.wsConn.readyState <= 1) {
      try { executor.wsConn.close(1000, 'deregistered'); } catch { /* ignore */ }
    }

    this.executors.delete(executorId);
    this.emit('executor:deregistered', { executorId, reason });
    return true;
  }

  /**
   * Validate bearer token for an executor.
   */
  authenticate(executorId: string, token: string): boolean {
    const executor = this.executors.get(executorId);
    if (executor) return executor.token === token;
    // A host-bound ID authenticates only against the protected host record,
    // never the environment/project-selectable identity store (#2923 review).
    let hostRecord: ExecutorIdentityRecord | undefined;
    try { hostRecord = this.loadHostIdentities().get(executorId); } catch { return false; } // unreadable host store fails closed
    if (hostRecord?.hostAdmission || [...this.admissionAuthorities.values()].some(entry => entry.executorId === executorId)) {
      return !!token && hostRecord?.token === token;
    }
    // Fall back to identity store for executors that registered in a prior server run
    const stored = this.identityStore.get(executorId);
    return stored !== undefined && stored.token === token;
  }

  /**
   * Mark the WS event stream as connected or disconnected.
   */
  setConnected(executorId: string, connected: boolean, wsConn?: WebSocketConn): void {
    const executor = this.executors.get(executorId);
    if (!executor) return;
    executor.connected = connected;
    if (connected && wsConn) {
      executor.wsConn = wsConn;
    } else if (!connected) {
      executor.disconnectedAt = new Date().toISOString();
      executor.wsConn = undefined;
    }
  }

  /**
   * Push a message to the executor's live WS connection.
   * Returns true if sent, false if the executor has no open connection.
   */
  pushToExecutor(executorId: string, event: EventEnvelope): boolean {
    const executor = this.executors.get(executorId);
    if (!executor?.wsConn || executor.wsConn.readyState !== 1) return false;
    try {
      executor.wsConn.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  // ---- Event handling ----

  /**
   * Handle an inbound event from an executor WS connection.
   * Validates against event_envelope schema; updates mission state.
   */
  handleEvent(envelope: EventEnvelope): void {
    const executor = this.executors.get(envelope.executor_id);
    if (!executor) return;

    executor.lastEventTs = envelope.ts || new Date().toISOString();

    const missionId = envelope.mission_id;

    switch (envelope.event) {
      case 'executor.resync': {
        // Reconcile mission state on reconnect
        const ownedIds: string[] = (envelope.data?.['owned_mission_ids'] as string[]) ?? [];
        for (const mid of ownedIds) {
          const mission = this.missions.get(mid);
          if (mission && !TERMINAL_STATES.has(mission.state)) {
            const prevState = mission.state;
            mission.state = 'running';
            mission.updatedAt = envelope.ts;
            this.appendMissionEvent(mission, envelope);
            this.emit('mission:state_change', { missionId: mid, executorId: envelope.executor_id, state: 'running', prevState });
          }
        }
        break;
      }

      case 'mission.assigned': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'assigned';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'assigned', prevState });
        }
        break;
      }

      case 'mission.started': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'running';
          mission.updatedAt = envelope.ts;
          if (envelope.data?.['pty_session_id']) {
            mission.ptySessionRef = envelope.data['pty_session_id'] as string;
          }
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'running', prevState });
        }
        break;
      }

      case 'mission.progress': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
        }
        break;
      }

      case 'mission.hitl_required': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'hitl-required';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'hitl-required', prevState });
        }
        break;
      }

      case 'mission.paused': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'paused';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'paused', prevState });
        }
        break;
      }

      case 'mission.resumed': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'running';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'running', prevState });
        }
        break;
      }

      case 'mission.suspended': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'suspended';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'suspended', prevState });
        }
        break;
      }

      case 'mission.reconnected': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'running';
          mission.updatedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'running', prevState });
        }
        break;
      }

      case 'mission.completed': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'done';
          mission.updatedAt = envelope.ts;
          mission.completedAt = envelope.ts;
          if (typeof envelope.data?.['exit_code'] === 'number') {
            mission.exitCode = envelope.data['exit_code'] as number;
          }
          this.appendMissionEvent(mission, envelope);
          executor.currentMissions.delete(missionId);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'done', prevState });
        }
        break;
      }

      case 'mission.failed': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'failed';
          mission.updatedAt = envelope.ts;
          mission.completedAt = envelope.ts;
          if (typeof envelope.data?.['error'] === 'string') {
            mission.error = envelope.data['error'] as string;
          }
          if (typeof envelope.data?.['exit_code'] === 'number') {
            mission.exitCode = envelope.data['exit_code'] as number;
          }
          this.appendMissionEvent(mission, envelope);
          executor.currentMissions.delete(missionId);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'failed', prevState });
        }
        break;
      }

      case 'mission.aborted': {
        if (!missionId) break;
        const mission = this.missions.get(missionId);
        if (mission) {
          const prevState = mission.state;
          mission.state = 'aborted';
          mission.updatedAt = envelope.ts;
          mission.completedAt = envelope.ts;
          this.appendMissionEvent(mission, envelope);
          executor.currentMissions.delete(missionId);
          this.emit('mission:state_change', { missionId, executorId: envelope.executor_id, state: 'aborted', prevState });
        }
        break;
      }

      default:
        // Unknown or pass-through event — update timestamp, do not crash
        break;
    }
  }

  private appendMissionEvent(mission: MissionRecord, envelope: EventEnvelope): void {
    mission.recentEvents.push(envelope);
    if (mission.recentEvents.length > MAX_MISSION_EVENTS) {
      mission.recentEvents = mission.recentEvents.slice(-MAX_MISSION_EVENTS);
    }
  }

  // ---- Mission management ----

  /**
   * Create a mission record and associate it with an executor.
   * Called by the dispatch route after forwarding succeeds.
   */
  assignMission(missionId: string, executorId: string): MissionRecord {
    const now = new Date().toISOString();
    const mission: MissionRecord = {
      missionId,
      executorId,
      state: 'assigned',
      createdAt: now,
      updatedAt: now,
      recentEvents: [],
    };
    this.missions.set(missionId, mission);

    const executor = this.executors.get(executorId);
    if (executor) executor.currentMissions.add(missionId);

    this.emit('mission:assigned', { missionId, executorId });
    return mission;
  }

  /**
   * Mark a mission as failed (e.g. executor unreachable on forward).
   */
  failMission(missionId: string, error: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) return;
    const prevState = mission.state;
    mission.state = 'failed';
    mission.error = error;
    mission.updatedAt = new Date().toISOString();
    mission.completedAt = mission.updatedAt;
    const executor = this.executors.get(mission.executorId);
    if (executor) executor.currentMissions.delete(missionId);
    this.emit('mission:state_change', { missionId, executorId: mission.executorId, state: 'failed', prevState });
  }

  /**
   * Get a mission record by ID.
   */
  getMission(missionId: string): MissionRecord | undefined {
    return this.missions.get(missionId);
  }

  /**
   * Transition a mission to a requested operator state.
   * Returns false if the mission is in a terminal state or not found.
   */
  transitionMission(missionId: string, targetState: 'paused' | 'running' | 'aborted'): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;
    if (TERMINAL_STATES.has(mission.state)) return false;
    const prevState = mission.state;
    mission.state = targetState;
    mission.updatedAt = new Date().toISOString();
    if (TERMINAL_STATES.has(targetState)) {
      mission.completedAt = mission.updatedAt;
      const executor = this.executors.get(mission.executorId);
      if (executor) executor.currentMissions.delete(missionId);
    }
    this.emit('mission:state_change', { missionId, executorId: mission.executorId, state: targetState, prevState });
    return true;
  }

  // ---- Query ----

  /**
   * List all executors as serializable summaries.
   */
  list(): ExecutorSummary[] {
    return [...this.executors.values()].map(toSummary);
  }

  /**
   * Get a single executor summary.
   */
  get(executorId: string): ExecutorSummary | undefined {
    const executor = this.executors.get(executorId);
    return executor ? toSummary(executor) : undefined;
  }

  /**
   * Get the raw registration record (internal use by dispatch).
   */
  getRegistration(executorId: string): ExecutorRegistration | undefined {
    return this.executors.get(executorId);
  }

  /** Publish the negotiated interface used for the most recent A2A dispatch. */
  recordA2AProtocolSelection(
    executorId: string,
    selection: Omit<A2AProtocolSelectionState, 'selectedAt'> & { selectedAt?: string }
  ): boolean {
    const executor = this.executors.get(executorId);
    if (!executor) return false;
    executor.a2aProtocol = {
      ...selection,
      selectedAt: selection.selectedAt ?? new Date().toISOString(),
    };
    this.emit('executor:a2a_protocol_selected', {
      executorId,
      selectedVersion: selection.selectedVersion,
      protocolBinding: selection.interface.protocolBinding,
      interfaceUrl: selection.interface.url,
      ...(selection.fallbackReason ? { fallbackReason: selection.fallbackReason } : {}),
    });
    return true;
  }

  /**
   * Pick the best executor matching the given filter.
   *
   * Default-selection policy (per ADR §3):
   *   1. Sandbox-first: prefer any executor with isolation:vm or isolation:container
   *   2. Local fallback: isolation:none or isolation:host
   *   3. 503 if no executor available
   *
   * `long_running: true` requires a 'resumable' capability.
   */
  pickByFilter(filter: ExecutorFilter, longRunning = false): ExecutorPickResult | null {
    const candidates = [...this.executors.values()].filter((e) => e.connected);
    const rejected: Array<{ executorId: string; reason: string }> = [];

    // A pin selects an identity; it cannot waive the same controls used by automatic routing.
    const rejection = (executor: ExecutorRegistration): string | undefined => {
      if (longRunning && !executor.capabilities.includes('resumable')) {
        return 'long_running requires resumable capability';
      }
      const missing = (filter.capabilities ?? []).filter(capability => !executor.capabilities.includes(capability));
      if (missing.length > 0) return `missing capabilities: ${missing.join(', ')}`;
      return undefined;
    };
    if (filter.executor_id) {
      const pinned = this.executors.get(filter.executor_id);
      if (!pinned?.connected || rejection(pinned)) return null;
      return { executor: pinned, reason: 'pinned by executor_id', rejected: [] };
    }

    const filtered: ExecutorRegistration[] = [];
    for (const executor of candidates) {
      const reason = rejection(executor);
      if (reason) rejected.push({ executorId: executor.executorId, reason });
      else filtered.push(executor);
    }

    if (filtered.length === 0) return null;

    // ADR §3 sandbox-first policy: prefer vm/container isolation
    const sandboxFirst = filtered.filter((e) =>
      e.capabilities.some((c) => c === 'isolation:vm' || c === 'isolation:container')
    );
    const chosen = sandboxFirst.length > 0 ? sandboxFirst[0]! : filtered[0]!;

    return {
      executor: chosen,
      reason: sandboxFirst.length > 0 ? 'sandbox-first (isolation:vm/container)' : 'local fallback',
      rejected,
    };
  }

  /** Total registered executor count. */
  get size(): number {
    return this.executors.size;
  }

  /** Shut down — clear all state. */
  shutdown(): void {
    for (const executor of this.executors.values()) {
      if (executor.wsConn && executor.wsConn.readyState <= 1) {
        try { executor.wsConn.close(1000, 'server shutdown'); } catch { /* ignore */ }
      }
    }
    this.admissionAuthorities.clear();
    this.executors.clear();
    this.missions.clear();
    this.removeAllListeners();
  }
}

// ============================================================
// Serialization helper
// ============================================================

function toSummary(e: ExecutorRegistration): ExecutorSummary {
  const summary: ExecutorSummary = {
    executor_id: e.executorId,
    name: e.name,
    version: e.version,
    spec_version: e.specVersion,
    transport_endpoints: e.transportEndpoints,
    capabilities: e.capabilities,
    connected: e.connected,
    last_event_ts: e.lastEventTs,
    active_mission_count: e.currentMissions.size,
    registered_at: e.registeredAt,
    disconnected_at: e.disconnectedAt,
  };
  if (e.a2aInstanceId) summary.a2a_instance_id = e.a2aInstanceId;
  if (e.a2aProtocol) {
    summary.a2a_protocol = {
      policy: e.a2aProtocol.policy,
      selected_version: e.a2aProtocol.selectedVersion,
      protocol_binding: e.a2aProtocol.interface.protocolBinding,
      interface_url: e.a2aProtocol.interface.url,
      selected_at: e.a2aProtocol.selectedAt,
      ...(e.a2aProtocol.fallbackReason ? { fallback_reason: e.a2aProtocol.fallbackReason } : {}),
    };
  }
  return summary;
}

// Singleton instance
export const executorRegistry = new ExecutorRegistry();
