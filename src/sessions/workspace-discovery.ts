import { createReadStream } from 'node:fs';
import {
  access, mkdir, readFile, readdir, realpath, rename, stat, writeFile,
} from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { inspectMuseNativeWorkspace, type MuseWorkspaceInspection } from './adapters/muse.js';
import { readOmpSessionHeader } from './adapters/omp.js';
import { grokbotConversationIdFromLocator } from './adapters/grokbot-locator.js';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import {
  SESSION_PROVIDER_IDS,
  SessionCoveragePreflightSchema,
  SessionContractError,
  type SessionCoveragePreflight,
  type SessionRuntimeIdentity,
  sha256,
  type AuthorizedScope,
  type SessionProviderId,
  type SourceDescriptor,
} from './contracts.js';
import { redactSourceLocator, type SessionSourceAdapterRegistry } from './discovery.js';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import { coveragePreflight, expectedSessionProviders } from './coverage-preflight.js';
import { fingerprintSourceFile } from './readers.js';
import { matchSessionWorkspace, type WorkspaceMatchKind } from './workspace-matching.js';

export const DISCOVERY_MANIFEST_VERSION = '1.0.0' as const;

export type DiscoveryProviderStatus =
  | 'checked'
  | 'unavailable'
  | 'export-required'
  | 'not-checked';

export interface DiscoveryManifestSource {
  sourceId: string;
  provider: SessionProviderId;
  locator: string;
  redactedLocator: string;
  locatorClass: string;
  authorizedRoot: string;
  modifiedAt: string;
  sizeBytes: number;
  digest: string;
}

export interface DiscoveryProviderReport {
  provider: string;
  status: DiscoveryProviderStatus;
  disposition: 'discoverable' | 'manual-export' | 'unsupported';
  sourceCount: number;
  matchedBySubfolder?: number;
  matchedByWorktree?: number;
  dateRange: { earliest: string | null; latest: string | null };
  dateRangeBasis: 'source-mtime';
  reasonCode: string | null;
  remediation: string | null;
  rootCounts?: Array<{
    root: string;
    rootId: string;
    status: 'checked' | 'unavailable';
    sourceCount: number;
    duplicateCount: number;
  }>;
  museSourceInspections?: Array<MuseWorkspaceInspection & {
    sourceKey: string;
    redactedLocator: string;
    nativeSessionId?: string;
  }>;
}

export interface SessionDiscoveryManifest {
  schemaVersion: typeof DISCOVERY_MANIFEST_VERSION;
  manifestId: string;
  createdAt: string;
  workspaceId: string;
  workspacePath: string;
  preflight?: SessionCoveragePreflight;
  /** Exact canonical roots authorized by the discovery invocation. */
  authorizedRoots?: Partial<Record<SessionProviderId, string[]>>;
  providers: DiscoveryProviderReport[];
  sources: DiscoveryManifestSource[];
}

export interface DiscoverWorkspaceOptions {
  workspace: string;
  /** Logical paths to the same canonical workspace, used for provider project keys. */
  workspaceAliases?: readonly string[];
  expectedProviders?: readonly string[];
  registry?: SessionSourceAdapterRegistry;
  runtime?: SessionRuntimeIdentity;
  providerHome?: string;
  operatorHome?: string;
  codexRoot?: string;
  codexRoots?: readonly string[];
  ompRoot?: string;
  museRoot?: string;
  dshRoot?: string;
  grokbotRoot?: string;
  createdAt?: string;
  /** Restrict maintenance discovery to previously authorized roots, with no defaults. */
  authorizedRoots?: Partial<Record<SessionProviderId, string[]>>;
}

interface DiscoverableProvider {
  provider: 'claude' | 'codex' | 'cursor' | 'factory' | 'pi' | 'omp' | 'deepseek-harness' | 'muse' | 'grokbot';
  roots: string[];
}

const MANUAL_EXPORT_PROVIDERS = new Set<SessionProviderId>([
  'copilot', 'hermes', 'opencode', 'openclaw', 'openhuman', 'grok-build',
  'warp', 'devin-desktop', 'generic',
]);

export async function discoverWorkspaceHistories(
  options: DiscoverWorkspaceOptions,
): Promise<SessionDiscoveryManifest> {
  const registry = options.registry ?? createSessionAdapterRegistry();
  const expectedProviders = expectedSessionProviders(options.expectedProviders ?? SESSION_PROVIDER_IDS);
  const supportedProviders = new Set(registry.list().map((adapter) => adapter.provider));
  const workspacePath = await canonicalPath(options.workspace);
  const workspaceId = workspacePath;
  const workspacePaths = [...new Set([workspacePath, resolve(options.workspace),
    ...(options.workspaceAliases ?? []).map((alias) => resolve(alias))])];
  for (const alias of workspacePaths) {
    if (await canonicalPath(alias) !== workspacePath) {
      throw new SessionContractError('INVALID_ARGUMENT', 'workspace alias resolves to a different workspace');
    }
  }
  const providerHomes = providerHomeCandidates(options.providerHome, options.operatorHome);
  const discoverable: DiscoverableProvider[] = [
    { provider: 'deepseek-harness', roots: options.dshRoot
      ? [resolve(options.dshRoot)] : options.providerHome
        ? [join(resolve(options.providerHome), '.dsh', 'sessions')] : [] },
    { provider: 'omp', roots: options.ompRoot
      ? [resolve(options.ompRoot)] : options.providerHome
        ? [resolveOmpPaths({ home: resolve(options.providerHome), cwd: workspacePath }).sessionsDir] : [] },
    { provider: 'muse', roots: options.museRoot
      ? [resolve(options.museRoot)] : [] },
    // Grok Bot conversations carry no workspace/cwd field, so unlike
    // claude/cursor/factory there is no per-workspace default path to derive
    // from providerHome. Native discovery requires an explicit
    // --grokbot-root (same shared-root authorization model as
    // codex/omp/deepseek-harness/muse below), and every authorized
    // conversation surfaces to whichever workspace runs discovery (same
    // no-filtering behavior already used for `pi`/`deepseek-harness`).
    { provider: 'grokbot', roots: options.grokbotRoot
      ? [resolve(options.grokbotRoot)] : [] },
    {
      provider: 'claude',
      roots: providerHomes.flatMap((providerHome) => workspacePaths.map(
        (workspace) => join(providerHome, '.claude', 'projects', claudeProjectKey(workspace)),
      )),
    },
    {
      provider: 'codex',
      roots: options.authorizedRoots || !expectedProviders.includes('codex')
        ? [] : await codexDiscoveryRoots(options),
    },
    {
      provider: 'cursor',
      roots: providerHomes.flatMap((providerHome) => workspacePaths.map(
        (workspace) => join(providerHome, '.cursor', 'projects', workspaceKey(workspace, false), 'agent-transcripts'),
      )),
    },
    {
      provider: 'factory',
      roots: providerHomes.flatMap((providerHome) => workspacePaths.flatMap((workspace) => [
        join(providerHome, '.factory', 'projects', workspaceKey(workspace, true)),
        join(providerHome, '.factory', 'sessions', workspaceKey(workspace, true)),
      ])),
    },
    {
      // Pi stores every working directory's sessions in its own
      // subdirectory of the sessions root, named `--<path>--` where
      // `<path>` has its leading separator removed and `/`, `\`, and `:`
      // replaced with `-` (https://pi.dev/docs/latest/session-format,
      // "File Location", verified 2026-10-12) — the same transform
      // `workspaceKey(path, false)` already applies for Cursor below.
      // Scanning the whole sessions root (as before) would import every
      // other workspace's history into this one's catalog (#2656).
      provider: 'pi',
      roots: (process.env.PI_CODING_AGENT_SESSION_DIR
        ? [resolve(process.env.PI_CODING_AGENT_SESSION_DIR)]
        : providerHomes.map(
          (providerHome) => join(providerHome, '.pi', 'agent', 'sessions'),
        )
      ).flatMap((sessionsRoot) => workspacePaths.map(
        (workspace) => join(sessionsRoot, `--${workspaceKey(workspace, false)}--`),
      )),
    },
  ];

  const authorizedRoots: Partial<Record<SessionProviderId, string[]>> = { ...options.authorizedRoots };
  const reports = new Map<string, DiscoveryProviderReport>();
  const candidates: DiscoveryManifestSource[] = [];
  const seen = new Set<string>();
  for (const entry of discoverable) {
    if (!expectedProviders.includes(entry.provider) || !supportedProviders.has(entry.provider)) continue;
    const adapter = registry.get(entry.provider);
    if (adapter.disposition === 'unsupported' || !adapter.supportedOperations.includes('discover')) continue;
    const availableRoots: string[] = [];
    const rootCounts = new Map<string, NonNullable<DiscoveryProviderReport['rootCounts']>[number]>();
    for (const root of options.authorizedRoots ? options.authorizedRoots[entry.provider] ?? [] : entry.roots) {
      if (await pathExists(root)) {
        const canonical = await canonicalPath(root);
        if (options.authorizedRoots && canonical !== root) {
          throw new SessionContractError('INVALID_ARGUMENT', 'previously authorized provider root changed; rediscover with explicit authorization');
        }
        if (!availableRoots.includes(canonical)) {
          availableRoots.push(canonical);
          rootCounts.set(canonical, {
            root: redactSourceLocator(canonical), rootId: sha256(canonical),
            status: 'checked', sourceCount: 0, duplicateCount: 0,
          });
        }
      } else {
        rootCounts.set(root, {
          root: redactSourceLocator(root), rootId: sha256(root),
          status: 'unavailable', sourceCount: 0, duplicateCount: 0,
        });
      }
    }
    if (availableRoots.length === 0) {
      const codexNeedsAuthorization = (entry.provider === 'codex' || entry.provider === 'omp'
        || entry.provider === 'deepseek-harness' || entry.provider === 'muse'
        || entry.provider === 'grokbot')
        && entry.roots.length === 0;
      reports.set(entry.provider, providerReport(
        entry.provider,
        codexNeedsAuthorization ? 'export-required' : 'unavailable',
        codexNeedsAuthorization ? 'manual-export' : 'discoverable',
        [],
        codexNeedsAuthorization
          ? 'SHARED_ROOT_AUTHORIZATION_REQUIRED'
          : 'PROVIDER_ROOT_UNAVAILABLE',
        codexNeedsAuthorization
          ? `Pass --${entry.provider === 'deepseek-harness' ? 'dsh' : entry.provider}-root with an explicitly authorized sessions root.`
          : `No authorized ${entry.provider} workspace history root was found.`,
      ));
      if (entry.provider === 'codex') reports.get(entry.provider)!.rootCounts = [...rootCounts.values()];
      continue;
    }
    authorizedRoots[entry.provider] = availableRoots;
    const scope: AuthorizedScope = {
      workspaceId,
      allowedRoots: availableRoots,
    };
    const providerSources: DiscoveryManifestSource[] = [];
    let matchedBySubfolder = 0;
    let matchedByWorktree = 0;
    const museSourceInspections: NonNullable<DiscoveryProviderReport['museSourceInspections']> = [];
    for await (const descriptor of adapter.discover(scope)) {
      let workspaceMatch: WorkspaceMatchKind | null = null;
      if (entry.provider === 'muse') {
        const inspection = await inspectMuseNativeWorkspace({
          ...descriptor,
          sourceId: 'discovery',
          authorizedScope: scope,
        }, workspacePath);
        museSourceInspections.push({
          sourceKey: sha256(['muse-workspace-inspection-v1', descriptor.locator].join('\0')),
          redactedLocator: redactSourceLocator(descriptor.locator),
          nativeSessionId: basename(dirname(descriptor.locator)),
          ...inspection,
        });
        if (inspection.outcome !== 'matched') continue;
        workspaceMatch = inspection.matchKind ?? null;
      }
      const locator = await canonicalPath(descriptor.locator);
      if (entry.provider === 'codex') {
        workspaceMatch = await codexSourceWorkspaceMatch(locator, workspacePath);
        if (!workspaceMatch) continue;
      }
      const ompHeader = entry.provider === 'omp' ? await readOmpSessionHeader({ ...descriptor, sourceId: 'discovery', authorizedScope: scope }) : undefined;
      if (ompHeader) {
        workspaceMatch = await matchSessionWorkspace(ompHeader.cwd, workspacePath);
        if (!workspaceMatch) continue;
      }
      const details = await stat(locator);
      const authorizedRoot = scope.allowedRoots.find(
        (root) => locator === root || locator.startsWith(`${root}/`),
      );
      if (!authorizedRoot) continue;
      if (entry.provider === 'claude'
        && !await claudeSourceMatchesWorkspace(locator, workspacePath)) continue;
      const fingerprint = await fingerprintSourceFile({
        selectedPath: locator,
        allowedRoots: [authorizedRoot],
      });
      const rolloutId = entry.provider === 'codex' && descriptor.locatorClass === 'codex-rollout-jsonl'
        ? await codexRolloutId(locator) : undefined;
      const dedupeKey = rolloutId
        ? `codex\0rollout\0${rolloutId}`
        : `${entry.provider}\0${fingerprint.digest}\0${fingerprint.size}`;
      const rootCount = rootCounts.get(authorizedRoot)!;
      if (seen.has(dedupeKey)) {
        rootCount.duplicateCount += 1;
        continue;
      }
      seen.add(dedupeKey);
      if (workspaceMatch === 'subfolder') matchedBySubfolder += 1;
      if (workspaceMatch === 'worktree') matchedByWorktree += 1;
      rootCount.sourceCount += 1;
      const source = sourceFromDescriptor(
        descriptor,
        locator,
        authorizedRoot,
        details,
        fingerprint.digest,
      );
      if (ompHeader) source.sourceId = sha256(['omp-native-source-v1', workspaceId, ompHeader.id].join('\0'));
      if (entry.provider === 'grokbot') {
        // The replica is rewritten wholesale as its sliding window evicts
        // old entries, so a content-digest sourceId (the default above)
        // would churn every re-discovery and break checkpoint continuity.
        // Key it on the conversation id instead, same rationale as the OMP
        // override above.
        const conversationId = grokbotConversationIdFromLocator(locator);
        if (conversationId) {
          source.sourceId = sha256(['grokbot-native-source-v1', workspaceId, conversationId].join('\0'));
        }
      }
      providerSources.push(source);
      candidates.push(source);
    }
    const incompleteMuseInspection = museSourceInspections.some(
      (inspection) => inspection.outcome === 'inconclusive',
    );
    const report = providerReport(
      entry.provider,
      incompleteMuseInspection ? 'not-checked' : 'checked',
      'discoverable',
      providerSources,
      incompleteMuseInspection ? 'MUSE_SOURCE_INSPECTION_INCOMPLETE'
        : providerSources.length === 0 ? 'NO_WORKSPACE_SOURCES' : null,
      incompleteMuseInspection
        ? 'Review unattributed museSourceInspections and their limit name/value; authorize a supported Muse export for unresolved sources before claiming workspace coverage.'
        : providerSources.length === 0
        ? `The ${entry.provider} root was checked, but no source matched the authorized workspace.`
        : null,
    );
    if (entry.provider === 'muse') {
      report.museSourceInspections = museSourceInspections.sort(
        (a, b) => a.sourceKey.localeCompare(b.sourceKey),
      );
    }
    report.matchedBySubfolder = matchedBySubfolder;
    report.matchedByWorktree = matchedByWorktree;
    if (entry.provider === 'codex') report.rootCounts = [...rootCounts.values()];
    reports.set(entry.provider, report);
  }

  for (const provider of expectedProviders) {
    if (reports.has(provider)) continue;
    const manual = MANUAL_EXPORT_PROVIDERS.has(provider as SessionProviderId);
    if (!supportedProviders.has(provider as SessionProviderId)) {
      reports.set(provider, providerReport(provider, 'not-checked', 'unsupported', [],
        'MISSING_ADAPTER', 'Deliberately select a compatible runtime or an authorized supported export.'));
      continue;
    }
    const grokBuild = provider === 'grok-build';
    reports.set(provider, providerReport(
      provider,
      manual ? 'export-required' : 'not-checked',
      manual ? 'manual-export' : 'unsupported',
      [],
      grokBuild ? 'CLI_EXPORT_REQUIRED'
        : manual ? 'EXPLICIT_EXPORT_REQUIRED' : 'PROVIDER_NOT_CHECKED',
      grokBuild
        ? 'Run `grok sessions list` or `grok sessions search`, then export an authorized session with `grok export <id> <id>.md`; Grok Build resolves $GROK_HOME itself.'
        : manual
        ? `Select and authorize a supported ${provider} export before importing it.`
        : `No discovery strategy is registered for ${provider}.`,
    ));
  }

  const sources = candidates.sort(compareSources);
  const providers = [...reports.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const preflight = coveragePreflight({
    expectedProviders, expectedProviderBasis: options.expectedProviders ? 'explicit' : 'declared-default',
    registry, runtime: options.runtime, reports: providers,
  });
  const identity = {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    workspaceId,
    preflight,
    authorizedRoots,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
    })),
    providers: providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
      ...(provider.matchedBySubfolder !== undefined ? { matchedBySubfolder: provider.matchedBySubfolder } : {}),
      ...(provider.matchedByWorktree !== undefined ? { matchedByWorktree: provider.matchedByWorktree } : {}),
      ...(provider.rootCounts ? { rootCounts: provider.rootCounts } : {}),
      ...(provider.museSourceInspections ? { museSourceInspections: provider.museSourceInspections } : {}),
    })),
  };
  return {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    manifestId: sha256(JSON.stringify(identity)),
    createdAt: options.createdAt ?? new Date().toISOString(),
    workspaceId,
    workspacePath,
    preflight,
    authorizedRoots,
    providers,
    sources,
  };
}

export function defaultDiscoveryManifestPath(workspace: string): string {
  return resolve(workspace, '.aiwg', 'sessions', 'discovery-manifest.json');
}

export async function writeDiscoveryManifest(
  path: string,
  manifest: SessionDiscoveryManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readDiscoveryManifest(path: string): Promise<SessionDiscoveryManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as SessionDiscoveryManifest;
  if (value.schemaVersion !== DISCOVERY_MANIFEST_VERSION
    || typeof value.manifestId !== 'string'
    || typeof value.workspaceId !== 'string'
    || !Array.isArray(value.providers)
    || !Array.isArray(value.sources)) {
    throw new Error('session discovery manifest is malformed or unsupported');
  }
  if (value.preflight) {
    const parsed = SessionCoveragePreflightSchema.safeParse(value.preflight);
    if (!parsed.success) throw new SessionContractError('INVALID_ARGUMENT', 'invalid discovery coverage preflight');
  }
  const expected = await rediscoverManifestIdentity(value);
  if (expected !== value.manifestId) {
    throw new Error('session discovery manifest identity does not match its contents');
  }
  return value;
}

export function publicDiscoveryManifest(manifest: SessionDiscoveryManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    manifestId: manifest.manifestId,
    createdAt: manifest.createdAt,
    workspaceId: manifest.workspaceId,
    workspacePath: manifest.workspacePath,
    preflight: manifest.preflight,
    providers: manifest.providers,
    sources: manifest.sources.map(({ locator: _locator, authorizedRoot: _root, ...source }) => source),
    totals: {
      providers: manifest.providers.length,
      sources: manifest.sources.length,
      matchedBySubfolder: manifest.providers.reduce((sum, provider) => sum + (provider.matchedBySubfolder ?? 0), 0),
      matchedByWorktree: manifest.providers.reduce((sum, provider) => sum + (provider.matchedByWorktree ?? 0), 0),
    },
  };
}

function sourceFromDescriptor(
  descriptor: SourceDescriptor,
  locator: string,
  authorizedRoot: string,
  details: Awaited<ReturnType<typeof stat>>,
  digest: string,
): DiscoveryManifestSource {
  return {
    sourceId: sha256([
      'workspace-source-v1', descriptor.provider, descriptor.locatorClass, digest,
    ].join('\0')),
    provider: descriptor.provider,
    locator,
    redactedLocator: redactSourceLocator(locator),
    locatorClass: descriptor.locatorClass,
    authorizedRoot,
    modifiedAt: details.mtime.toISOString(),
    sizeBytes: Number(details.size),
    digest,
  };
}

function providerReport(
  provider: string,
  status: DiscoveryProviderStatus,
  disposition: DiscoveryProviderReport['disposition'],
  sources: DiscoveryManifestSource[],
  reasonCode: string | null,
  remediation: string | null,
): DiscoveryProviderReport {
  const timestamps = sources.map((source) => source.modifiedAt).sort();
  return {
    provider,
    status,
    disposition,
    sourceCount: sources.length,
    matchedBySubfolder: 0,
    matchedByWorktree: 0,
    dateRange: {
      earliest: timestamps.at(0) ?? null,
      latest: timestamps.at(-1) ?? null,
    },
    dateRangeBasis: 'source-mtime',
    reasonCode,
    remediation,
  };
}

async function rediscoverManifestIdentity(manifest: SessionDiscoveryManifest): Promise<string> {
  const identity = {
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    ...(manifest.preflight ? { preflight: manifest.preflight } : {}),
    ...(manifest.authorizedRoots ? { authorizedRoots: manifest.authorizedRoots } : {}),
    sources: manifest.sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
    })),
    providers: manifest.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
      ...(provider.matchedBySubfolder !== undefined ? { matchedBySubfolder: provider.matchedBySubfolder } : {}),
      ...(provider.matchedByWorktree !== undefined ? { matchedByWorktree: provider.matchedByWorktree } : {}),
      ...(provider.rootCounts ? { rootCounts: provider.rootCounts } : {}),
      ...(provider.museSourceInspections ? { museSourceInspections: provider.museSourceInspections } : {}),
    })),
  };
  return sha256(JSON.stringify(identity));
}

async function codexDiscoveryRoots(options: DiscoverWorkspaceOptions): Promise<string[]> {
  const explicit = [...(options.codexRoots ?? []), ...(options.codexRoot ? [options.codexRoot] : [])];
  if (explicit.length > 0) return [...new Set(explicit.map((root) => resolve(root)))];
  // Shared stores require the same explicit provider-home authorization as the default root.
  if (!options.providerHome) return [];
  const codexHome = join(resolve(options.providerHome), '.codex');
  const roots = [join(codexHome, 'sessions')];
  if (process.env.CODEX_HOME) roots.push(resolve(process.env.CODEX_HOME, 'sessions'));
  try {
    const roles = await readdir(join(codexHome, 'roles-runtime'), { withFileTypes: true });
    for (const role of roles.sort((a, b) => a.name.localeCompare(b.name))) {
      if (role.isDirectory() || role.isSymbolicLink()) {
        roots.push(join(codexHome, 'roles-runtime', role.name, '.codex', 'sessions'));
      }
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  return [...new Set(roots)];
}

async function codexRolloutId(locator: string): Promise<string | undefined> {
  const input = createReadStream(locator, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 50) break;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const record = asObject(value);
      const id = asObject(record.payload).id;
      if (record.type === 'session_meta' && typeof id === 'string' && id.length > 0) return id;
    }
    return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
      .exec(basename(locator))?.[1];
  } finally {
    lines.close();
    input.destroy();
  }
}

async function codexSourceWorkspaceMatch(
  locator: string,
  workspacePath: string,
): Promise<WorkspaceMatchKind | null> {
  const input = createReadStream(locator, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 50) break;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = codexWorkspaceField(value);
      if (!cwd) continue;
      return await matchSessionWorkspace(cwd, workspacePath);
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

function codexWorkspaceField(value: unknown): string | null {
  const root = asObject(value);
  const payload = asObject(root.payload);
  const result = asObject(root.result);
  const resultThread = asObject(result.thread);
  const params = asObject(root.params);
  const paramsThread = asObject(params.thread);
  for (const candidate of [
    payload.cwd, result.cwd, resultThread.cwd, params.cwd, paramsThread.cwd,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function claudeSourceMatchesWorkspace(
  locator: string,
  workspacePath: string,
): Promise<boolean> {
  const input = createReadStream(locator, { encoding: 'utf8', end: 1024 * 1024 - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 50) break;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = asObject(value).cwd;
      if (typeof cwd !== 'string' || cwd.length === 0) continue;
      try {
        return await canonicalPath(cwd) === workspacePath;
      } catch {
        return resolve(cwd) === workspacePath;
      }
    }
    // Older transcripts without cwd still use the selected project folder.
    return true;
  } finally {
    lines.close();
    input.destroy();
  }
}

export function claudeProjectKey(path: string): string {
  // Claude Code 2.1.302 replaces each character, then caps keys at 200
  // characters with a base-36 suffix from the original path's 32-bit hash.
  const key = path.replace(/[^A-Za-z0-9-]/g, '-');
  if (key.length <= 200) return key;
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  }
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function workspaceKey(path: string, retainLeadingSeparator: boolean): string {
  const normalized = path.replace(/\\/g, '/');
  const input = retainLeadingSeparator ? normalized : normalized.replace(/^\/+/, '');
  return input.replace(/[/:]+/g, '-');
}

function providerHomeCandidates(
  explicit: string | undefined,
  operatorHome: string | undefined,
): string[] {
  if (explicit) return [resolve(explicit)];
  let accountHome = operatorHome;
  if (!accountHome) {
    try {
      accountHome = userInfo().homedir;
    } catch {
      accountHome = undefined;
    }
  }
  return [...new Set([homedir(), accountHome].filter(
    (candidate): candidate is string => Boolean(candidate),
  ).map((candidate) => resolve(candidate)))];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function compareSources(
  left: DiscoveryManifestSource,
  right: DiscoveryManifestSource,
): number {
  return left.provider.localeCompare(right.provider)
    || left.locator.localeCompare(right.locator)
    || basename(left.locator).localeCompare(basename(right.locator));
}
