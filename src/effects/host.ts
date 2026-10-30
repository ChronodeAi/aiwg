/** Shared host configuration for the effect ledger and its signing consumers. */
import { basename, resolve } from 'node:path';
import { createSecretStore, type SecretStore } from '../auth/credential-store.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { DEFAULT_LEDGER_KEY_SERVICE, LEDGER_TEST_KEY_ENV, credentialStoreKeyProvider, environmentTestKeyProvider, type LedgerKeyProvider } from './keys.js';
import { EffectLedgerError, usageError as usage } from './errors.js';
import { openEffectLedger, type EffectLedger } from './ledger.js';
import type { CheckpointSink } from './checkpoint-sinks.js';
import type { EffectScope, EffectSubsystem } from './types.js';
import type { EffectVerifier, EffectVerifierRegistry } from './verifiers/index.js';
import type { TrackerVerifierOptions } from './verifiers/tracker.js';

export interface EffectKeyProviderConfig {
  /** `credential-store` (default): the host secret service. `file`: an explicit mode-0600 file fallback. */
  type?: 'credential-store' | 'file';
  service?: string;
  /** Defaults to `ledger/<tenant>/<project>/<subsystem>`. */
  account?: string;
  /** Required for `file`. */
  path?: string;
}

export interface EffectHostConfig {
  tenant?: string;
  project?: string;
  writer?: string;
  keyProvider?: EffectKeyProviderConfig;
}

/** Test and embedding seams. Production uses host configuration only. */
export interface EffectCliDeps {
  /** Replace the configured key store. `role` is `current` or `next` (the staged successor during rotation). */
  keyStore?: (role: 'current' | 'next', account: string) => SecretStore;
  sink?: CheckpointSink;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  /**
   * Extra verifiers registered after the built-ins. An extension whose kind is
   * a tracker kind replaces the configured tracker verifier of that kind.
   */
  verifiers?: EffectVerifier[];
  /** Overrides for the tracker verifiers (transport, clock, config and remotes). */
  tracker?: Partial<TrackerVerifierOptions>;
  lockTimeoutMs?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;

function defaultProject(projectDir: string): string {
  const cleaned = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._:/@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return cleaned && IDENTIFIER.test(cleaned) ? cleaned : 'project';
}

async function hostConfig(projectDir: string): Promise<EffectHostConfig> {
  let config: unknown;
  try { config = await readAiwgConfig(projectDir); }
  catch { throw new EffectLedgerError('usage', 'aiwg.config could not be read', 'config-unreadable'); }
  const effects = (config as { effects?: unknown } | null)?.effects;
  if (effects === undefined || effects === null) return {};
  if (typeof effects !== 'object' || Array.isArray(effects)) throw usage('aiwg.config effects must be an object', 'config-invalid');
  return effects as EffectHostConfig;
}

function testContext(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test' || env.CI === 'true' || env.CI === '1';
}

export interface Session {
  projectDir: string;
  scope: EffectScope;
  config: EffectHostConfig;
  account: string;
  deps: EffectCliDeps;
  env: NodeJS.ProcessEnv;
}

export function keyStore(session: Session, role: 'current' | 'next'): SecretStore | null {
  const { deps, config, account } = session;
  if (deps.keyStore) return deps.keyStore(role, account);
  if (session.env[LEDGER_TEST_KEY_ENV] && testContext(session.env)) return null;
  const provider = config.keyProvider ?? {};
  try {
    if (provider.type === 'file') {
      if (!provider.path) throw new Error('missing path');
      const pathname = resolve(session.projectDir, provider.path);
      return createSecretStore({ useFile: true, allowFile: true, pathname: role === 'next' ? `${pathname}.next` : pathname, service: DEFAULT_LEDGER_KEY_SERVICE, account });
    }
    if (provider.type !== undefined && provider.type !== 'credential-store') throw new Error('unknown provider');
    return createSecretStore({ service: provider.service ?? DEFAULT_LEDGER_KEY_SERVICE, account: role === 'next' ? `${account}.next` : account });
  } catch {
    throw new EffectLedgerError('key-unavailable', 'Effect ledger key provider is not configured correctly on this host', 'key-provider-invalid');
  }
}

export function keyProvider(session: Session): LedgerKeyProvider {
  const store = keyStore(session, 'current');
  if (!store) return environmentTestKeyProvider(session.env);
  return credentialStoreKeyProvider({ account: session.account, store });
}

export function describeKeyProvider(session: Session): Record<string, string> {
  if (session.deps.keyStore) return { type: 'injected', account: session.account };
  if (session.env[LEDGER_TEST_KEY_ENV] && testContext(session.env)) return { type: 'environment-test-key' };
  const provider = session.config.keyProvider ?? {};
  if (provider.type === 'file') return { type: 'file', account: session.account };
  return { type: 'credential-store', service: provider.service ?? DEFAULT_LEDGER_KEY_SERVICE, account: session.account };
}

export function openLedger(session: Session, registry?: EffectVerifierRegistry): EffectLedger {
  const writer = session.config.writer ?? 'cli';
  return openEffectLedger({
    projectDir: session.projectDir, scope: session.scope, writer, keyProvider: keyProvider(session),
    ...(session.deps.clock ? { clock: session.deps.clock } : {}),
    ...(session.deps.sink ? { sink: session.deps.sink } : {}),
    ...(registry ? { verifiers: registry } : {}),
    ...(session.deps.lockTimeoutMs ? { lockTimeoutMs: session.deps.lockTimeoutMs } : {}),
  });
}

/** Resolve the same host scope and key provider for CLI and qualification evidence. */
export async function effectSession(projectDir: string, subsystem: EffectSubsystem = 'delivery', deps: EffectCliDeps = {}): Promise<Session> {
  const config = await hostConfig(projectDir);
  const tenant = config.tenant ?? 'local';
  const project = config.project ?? defaultProject(projectDir);
  if (!IDENTIFIER.test(tenant) || !IDENTIFIER.test(project)) throw usage('aiwg.config effects tenant and project must be identifiers', 'config-invalid');
  const scope: EffectScope = { tenant, project, subsystem };
  const env = deps.env ?? process.env;
  const account = config.keyProvider?.account ?? `ledger/${tenant}/${project}/${subsystem}`;
  return { projectDir, scope, config, account, deps, env };
}
