/**
 * Direct-worker onboarding/readiness (issue #2894, S1 Tier 0 direct handoff).
 *
 * For each configured worker this reports two separate facts that must never
 * be merged:
 * - "installation readiness": is the CLI installed, and is the installed
 *   version in the registered range;
 * - "dispatch eligibility": what the resolver itself decides for this cli
 *   (worker_dispatch, per-cli enable, adapter binding), plus the plain
 *   statement that launch additionally requires current installation evidence
 *   and model observation under the dispatch resolver's gates.
 *
 * Probing is opt-in. `diagnoseDirectWorkerReadiness` starts no process unless
 * the caller supplies a `probe`; surfaces such as `aiwg doctor` report
 * configuration from config and the registry by default and only probe behind
 * an explicit flag. The single probe implementation lives in the shared
 * installation owner (`boundedVersionProbe` in worker-installation.mjs) with
 * its credential-free environment allowlist and bounds; this module only maps
 * its outcome onto readiness findings.
 *
 * The configured `adapter` binding is always honoured: the installation key
 * is never interpreted as a provider ID. Adapter IDs are normalized through
 * provider-definitions, so aliases (for example `providers:openai` for
 * `codex`) resolve to the same registry entry as the canonical reference.
 *
 * The shipped direct profiles are declarations, not live qualification: no
 * finding ever calls a profile "qualified". Profiles stay unqualified until
 * an authenticated smoke run (tracker #3005), and an installed, in-range CLI
 * can still be refused by the resolver — the dispatch finding says so
 * plainly with the resolver's own reason.
 *
 * Decision 17 (baseline simplification) dropped provider qualification
 * runners, attestations and prescribed evidence files; this module therefore
 * performs no live-qualification recording and requires no evidence files.
 */
import { tmpdir } from 'node:os';
import {
  boundedVersionProbe,
  normalizeWorkerVersionBanner,
  workerVersionProbeDefaults,
  workerVersionProbeEnvironment,
  workerVersionRangeMismatch,
} from './worker-installation.mjs';
import { resolveWorkerGroupInstallation } from '../config/aiwg-config.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';
import type {
  ProviderModelCapabilityRegistry,
  WorkerAdapterMetadata,
} from './provider-policy.js';

export type DirectWorkerProbeOutcome =
  | { ok: true; rawBanner: string }
  | { ok: false; reason: 'not-installed' | 'probe-failed' };

/** Spawn one bounded version probe. Read-only: only `versionArgv` is ever run. */
export type DirectWorkerProber = (
  executable: string,
  versionArgv: string[],
  options: { timeoutMs: number; cwd: string },
) => Promise<DirectWorkerProbeOutcome>;

export type DirectWorkerInstallReadiness = 'ready' | 'not-ready' | 'skipped' | 'unprobed';
export type DirectWorkerDispatchEligibility = 'eligible' | 'blocked' | 'skipped';

export interface DirectWorkerReadinessFinding {
  cli: string;
  /** 'install' speaks to installation readiness; 'dispatch' to resolver eligibility. */
  kind: 'install' | 'dispatch';
  profile: string | null;
  executable: string | null;
  installedVersion: string | null;
  status: 'ok' | 'info' | 'warn' | 'error';
  code: string;
  message: string;
  nextAction: string;
  /** Config pointer: project config file plus the exact key, for findings. */
  configFile: string;
  configKey: string;
  /** Set on kind 'install'; the other kind carries null. Never merged. */
  readiness: DirectWorkerInstallReadiness | null;
  /** Set on kind 'dispatch'; the other kind carries null. From the resolver. */
  eligibility: DirectWorkerDispatchEligibility | null;
  /** Resolver verdict in plain words (kind 'dispatch' only). */
  eligibilityDetail: string | null;
  /** Group members referencing this cli (`group/member`), for member context. */
  members: string[];
}

export interface DirectWorkerReadinessReport {
  enabled: boolean;
  workersConfigured: boolean;
  ready: boolean;
  findings: DirectWorkerReadinessFinding[];
}

const SMOKE_NOTE = 'Profiles are unqualified until an authenticated smoke run (see #3005).';

function truncateBanner(banner: string, limit = 200): string {
  const singleLine = banner.replace(/[\r\n]+/g, '\\n');
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine;
}

/**
 * Default live prober: the shared bounded probe with a credential-free
 * environment and explicit cwd. ENOENT means not installed; every other
 * spawn, timeout or output failure is a failed probe. Never launches a
 * worker. Callers opt in by passing this (or their own prober); without a
 * prober no process is started.
 */
export async function probeDirectWorkerVersion(
  executable: string,
  versionArgv: string[],
  options: { timeoutMs?: number; maxBytes?: number; cwd?: string } = {},
): Promise<DirectWorkerProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? workerVersionProbeDefaults.timeoutMs;
  const maxBytes = options.maxBytes ?? workerVersionProbeDefaults.maxBytes;
  const cwd = options.cwd ?? tmpdir();
  try {
    const { rawBanner } = await boundedVersionProbe(
      executable, versionArgv, workerVersionProbeEnvironment(), cwd, timeoutMs, maxBytes, undefined);
    return { ok: true, rawBanner };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-installed' : 'probe-failed' };
  }
}

interface ResolvedDirectEntry {
  adapter: WorkerAdapterMetadata;
  adapterRef: string;
  canonicalId: string;
}

const ADAPTER_REFERENCE = /^(providers|workerAdapters):(.+)$/;

/**
 * Follow the configured adapter binding to its registry entry. The
 * installation key is never treated as a provider ID; the id segment of the
 * binding is normalized so aliases resolve to the canonical entry.
 */
function resolveDirectRegistryEntry(
  registry: ProviderModelCapabilityRegistry,
  configuredAdapter: string | undefined,
  cli: string,
): ResolvedDirectEntry | { error: string } {
  let namespace: string;
  let rawId: string;
  if (configuredAdapter !== undefined) {
    const match = ADAPTER_REFERENCE.exec(configuredAdapter.trim());
    if (!match) return { error: `Invalid worker adapter reference '${configuredAdapter}'` };
    [, namespace, rawId] = match;
  } else {
    namespace = 'providers';
    rawId = cli;
  }
  const canonicalId = normalizeProviderDefinitionId(rawId);
  if (!canonicalId) return { error: `Unknown provider binding '${rawId}'` };
  if (namespace === 'providers') {
    const entry = registry.providers[canonicalId as keyof typeof registry.providers];
    // Install/version metadata comes from the shipped direct profile when no
    // recorded workerAdapter is pinned; dispatch eligibility is decided by
    // the resolver separately and never inferred from this fallback.
    const adapter = entry?.workerAdapter ?? entry?.workerHealthAdapter;
    if (!adapter) return { error: `No direct worker profile is registered for binding 'providers:${canonicalId}'` };
    return { adapter, adapterRef: `providers:${canonicalId}`, canonicalId };
  }
  const adapter = registry.workerAdapters?.[canonicalId];
  if (!adapter) return { error: `Unknown worker adapter reference 'workerAdapters:${canonicalId}'` };
  return { adapter, adapterRef: `workerAdapters:${canonicalId}`, canonicalId };
}

function memberContext(parallelism: ParallelismConfig, cli: string): string[] {
  const members: string[] = [];
  for (const [groupId, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group?.members ?? []) {
      if (member.cli === cli) members.push(`${groupId}/${member.id}${member.enabled === false ? ' (disabled)' : ''}`);
    }
  }
  return members.sort();
}

function describeConfigContext(members: string[]): string {
  return members.length ? `members: ${members.join(', ')}` : 'members: no group member references this cli';
}

export interface DirectWorkerEligibility {
  eligibility: DirectWorkerDispatchEligibility;
  detail: string;
}

/**
 * Dispatch eligibility from the resolver itself: the group-installation
 * resolver decides binding/enablement; nothing here is re-derived. A
 * resolvable binding is still not a launch authorization — the detail says
 * what remains under the dispatch resolver's gates.
 */
function checkDispatchEligibility(
  parallelism: ParallelismConfig,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  installReady: boolean,
): DirectWorkerEligibility {
  try {
    const resolved = resolveWorkerGroupInstallation(parallelism, cli, registry);
    const ref = (resolved.installation as { adapter?: string }).adapter ?? '(implicit binding)';
    return { eligibility: 'eligible',
      detail: `Resolver accepts cli '${cli}' (binding '${ref}'). Dispatch eligibility: eligible at binding level. `
        + `Launch additionally requires current installation evidence and model observation under the dispatch resolver's gates. `
        + `${SMOKE_NOTE}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const readyNote = installReady
      ? ' The CLI is installed with an in-range version, but dispatch stays refused for the reason above; '
        + 'an authenticated smoke run (see #3005) alone does not satisfy the resolver gates.'
      : ` ${SMOKE_NOTE}`;
    return { eligibility: 'blocked',
      detail: `Resolver refuses cli '${cli}': ${reason}. Dispatch eligibility: blocked.${readyNote}` };
  }
}

/**
 * Read-only readiness for every configured worker. Starts no process unless
 * `probe` is supplied; without a prober each cli gets a config-only install
 * finding plus its resolver eligibility. Never claims a profile is
 * "qualified".
 */
export async function diagnoseDirectWorkerReadiness(input: {
  parallelism: ParallelismConfig;
  registry: ProviderModelCapabilityRegistry;
  probe?: DirectWorkerProber;
  timeoutMs?: number;
  probeCwd?: string;
  configFile?: string;
}): Promise<DirectWorkerReadinessReport> {
  const { parallelism, registry, probe, timeoutMs = workerVersionProbeDefaults.timeoutMs,
    probeCwd = tmpdir(), configFile = '.aiwg/aiwg.config' } = input;
  const report: DirectWorkerReadinessReport = {
    enabled: parallelism.worker_dispatch === true,
    workersConfigured: Object.keys(parallelism.clis ?? {}).length > 0,
    ready: true,
    findings: [],
  };
  if (!report.enabled) {
    report.findings.push({ cli: '*', kind: 'dispatch', profile: null, executable: null, installedVersion: null,
      status: 'info', code: 'WORKER_DIRECT_DISABLED',
      message: `Group dispatch is disabled (config ${configFile} key /parallelism/worker_dispatch); install/version checks do not apply and onboarding cannot proceed.`,
      nextAction: 'enable-worker-dispatch-to-onboard',
      configFile, configKey: '/parallelism/worker_dispatch',
      readiness: null, eligibility: 'blocked',
      eligibilityDetail: 'Dispatch eligibility: blocked — group dispatch is disabled.',
      members: [] });
    return report;
  }
  const cliIds = Object.keys(parallelism.clis ?? {}).sort();
  if (!cliIds.length) {
    // No workers configured: no findings at all so doctor stays silent.
    return report;
  }
  const pushInstall = (finding: Omit<DirectWorkerReadinessFinding, 'kind' | 'eligibility' | 'eligibilityDetail'>): void => {
    report.findings.push({ ...finding, kind: 'install', eligibility: null, eligibilityDetail: null });
    if (finding.status === 'error' || finding.status === 'warn') report.ready = false;
  };
  const pushDispatch = (cli: string, profile: string | null, status: 'ok' | 'info' | 'warn',
    code: string, eligibility: DirectWorkerDispatchEligibility, detail: string, configKey: string,
    members: string[], nextAction: string): void => {
    report.findings.push({ cli, kind: 'dispatch', profile, executable: null, installedVersion: null,
      status, code, message: `${detail} (config ${configFile} key ${configKey}; ${describeConfigContext(members)})`,
      nextAction, configFile, configKey,
      readiness: null, eligibility, eligibilityDetail: detail, members });
  };
  await Promise.all(cliIds.map(async cli => {
    const configured = parallelism.clis?.[cli];
    const members = memberContext(parallelism, cli);
    const configKey = `/parallelism/clis/${cli}`;
    if (configured?.enabled === false) {
      pushInstall({ cli, profile: configured.invocationProfile ?? null,
        executable: configured.executable ?? null, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_CLI_DISABLED',
        message: `Dispatch is disabled for cli '${cli}' (config ${configFile} key ${configKey}/enabled); the version probe was skipped. Installation readiness: skipped. (${describeConfigContext(members)})`,
        nextAction: 'enable-cli-to-onboard',
        configFile, configKey, readiness: 'skipped', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, configured.invocationProfile ?? null, 'info', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'enable-cli-to-onboard');
      return;
    }
    const resolved = resolveDirectRegistryEntry(registry, configured?.adapter, cli);
    if ('error' in resolved) {
      pushInstall({ cli, profile: configured?.invocationProfile ?? null, executable: null, installedVersion: null,
        status: probe ? 'error' : 'warn', code: 'WORKER_DIRECT_NO_PROFILE',
        message: `${resolved.error} (config ${configFile} key ${configKey}/adapter); the profile cannot be onboarded. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'review-worker-configuration',
        configFile, configKey: `${configKey}/adapter`, readiness: 'not-ready', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, configured?.invocationProfile ?? null, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'review-worker-configuration');
      return;
    }
    const { adapter, adapterRef } = resolved;
    if (adapter.invocation.kind !== 'process') {
      pushInstall({ cli, profile: null, executable: null, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_HTTP',
        message: `Cli '${cli}' binds '${adapterRef}' (config ${configFile} key ${configKey}/adapter), which uses an HTTP adapter; there is no CLI version probe — check endpoint health instead. Installation readiness: skipped. (${describeConfigContext(members)})`,
        nextAction: 'check-endpoint-health',
        configFile, configKey, readiness: 'skipped', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, null, eligibility === 'eligible' ? 'ok' : 'warn',
        eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members,
        eligibility === 'eligible' ? 'check-endpoint-health' : 'review-worker-configuration');
      return;
    }
    const profileIds = Object.keys(adapter.invocationProfiles ?? {});
    const profileRef = configured?.invocationProfile
      ?? (profileIds.length === 1 ? profileIds[0] : undefined);
    if (!profileRef || !adapter.invocationProfiles?.[profileRef]) {
      pushInstall({ cli, profile: configured?.invocationProfile ?? null,
        executable: null, installedVersion: null,
        status: 'error', code: 'WORKER_DIRECT_PROFILE_UNKNOWN',
        message: configured?.invocationProfile
          ? `Configured invocation profile '${configured.invocationProfile}' is not registered for binding '${adapterRef}' (config ${configFile} key ${configKey}/invocationProfile). Installation readiness: not-ready. (${describeConfigContext(members)})`
          : `Cli '${cli}' binding '${adapterRef}' has no single direct profile to check (config ${configFile} key ${configKey}); configure invocationProfile explicitly. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'review-worker-configuration',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, configured?.invocationProfile ?? null, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'review-worker-configuration');
      return;
    }
    const profile = adapter.invocationProfiles[profileRef];
    const executable = configured?.executable ?? adapter.invocation.executable;
    if (!probe) {
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_UNPROBED',
        message: `Cli '${cli}' binds '${adapterRef}' profile '${profileRef}' (config ${configFile} key ${configKey}); version probe not run — no subprocess was started. Installation readiness: unprobed. Rerun with probes to check install/version. (${describeConfigContext(members)})`,
        nextAction: 'rerun-with-probe-workers',
        configFile, configKey, readiness: 'unprobed', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, profileRef, eligibility === 'eligible' ? 'ok' : 'warn',
        eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members,
        eligibility === 'eligible' ? 'rerun-with-probe-workers' : 'review-worker-configuration');
      return;
    }
    let outcome: DirectWorkerProbeOutcome;
    try {
      outcome = await probe(executable, adapter.invocation.versionArgv, { timeoutMs, cwd: probeCwd });
    } catch {
      outcome = { ok: false, reason: 'probe-failed' };
    }
    if (!outcome.ok) {
      const notInstalled = outcome.reason === 'not-installed';
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: notInstalled ? 'error' : 'warn',
        code: notInstalled ? 'WORKER_DIRECT_NOT_INSTALLED' : 'WORKER_DIRECT_PROBE_FAILED',
        message: notInstalled
          ? `CLI '${executable}' is not installed (version probe failed to start; config ${configFile} key ${configKey}/executable); install it before onboarding cli '${cli}'. Installation readiness: not-ready. (${describeConfigContext(members)})`
          : `Version probe for cli '${cli}' ('${executable}', config ${configFile} key ${configKey}) failed; retry once, then check PATH and execute permission. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: notInstalled ? 'install-cli' : 'retry-version-probe',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, notInstalled ? 'install-cli' : 'retry-version-probe');
      return;
    }
    const rawBanner = outcome.rawBanner.trim();
    let installedVersion: string;
    try {
      installedVersion = normalizeWorkerVersionBanner(rawBanner, adapter.invocation.versionPattern);
    } catch {
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: 'error', code: 'WORKER_DIRECT_BANNER_UNMATCHED',
        message: `CLI '${executable}' banner ${JSON.stringify(truncateBanner(rawBanner))} does not match the registered version pattern (config ${configFile} key ${configKey}); the install is unexpected — reinstall a supported release. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'reinstall-supported-cli',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'reinstall-supported-cli');
      return;
    }
    const mismatch = workerVersionRangeMismatch(installedVersion, [profile.supportedVersions, adapter.supportedVersions]);
    if (mismatch) {
      pushInstall({ cli, profile: profileRef, executable, installedVersion,
        status: 'warn', code: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE',
        message: `CLI '${executable}' version ${installedVersion} is outside supported range '${mismatch}' for cli '${cli}' (profile '${profileRef}', config ${configFile} key ${configKey}); upgrade or pin a supported release. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'upgrade-or-pin-cli',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, false);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'upgrade-or-pin-cli');
      return;
    }
    pushInstall({ cli, profile: profileRef, executable, installedVersion,
      status: 'ok', code: 'WORKER_DIRECT_READY',
      message: `CLI '${executable}' version ${installedVersion} matches profile '${profileRef}' for cli '${cli}' (config ${configFile} key ${configKey}). Installation readiness: ready. ${SMOKE_NOTE} See the dispatch finding for whether the resolver would dispatch. (${describeConfigContext(members)})`,
      nextAction: 'run-authenticated-smoke-run',
      configFile, configKey, readiness: 'ready', members });
    const { eligibility, detail } = checkDispatchEligibility(parallelism, registry, cli, true);
    pushDispatch(cli, profileRef, eligibility === 'eligible' ? 'ok' : 'warn',
      eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
      eligibility, detail, configKey, members, 'run-authenticated-smoke-run');
  }));
  report.findings.sort((a, b) => a.cli.localeCompare(b.cli) || a.kind.localeCompare(b.kind));
  return report;
}

export interface DirectWorkerDoctorLine {
  name: string;
  status: 'ok' | 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Doctor wiring for the direct-worker section. With `probeWorkers` false this
 * is config-only and starts no process; with true it runs the shared bounded
 * probes (announced in the first line). No workers configured yields no
 * lines at all, so doctor output and exit code are unchanged there.
 */
export async function buildDirectWorkerDoctorSection(input: {
  parallelism: ParallelismConfig | undefined | null;
  registry: ProviderModelCapabilityRegistry;
  probeWorkers: boolean;
  probe?: DirectWorkerProber;
  configFile?: string;
}): Promise<{ lines: DirectWorkerDoctorLine[]; probed: boolean; workersConfigured: boolean }> {
  const { parallelism, registry, probeWorkers, configFile } = input;
  const cliIds = Object.keys(parallelism?.clis ?? {});
  if (!cliIds.length) return { lines: [], probed: false, workersConfigured: false };
  const lines: DirectWorkerDoctorLine[] = [];
  if (probeWorkers) {
    lines.push({ name: 'Direct Worker Probes', status: 'info',
      message: 'probe execution is opt-in (--probe-workers): running bounded `<executable> ...versionArgv` probes with a cleared environment (no worker launch, no model call, no mutation)' });
  } else {
    lines.push({ name: 'Direct Worker', status: 'info',
      message: 'direct-worker configuration only: no subprocess was started. Rerun with --probe-workers to run the bounded version probes' });
  }
  const report = await diagnoseDirectWorkerReadiness({
    parallelism: parallelism as ParallelismConfig,
    registry,
    ...(probeWorkers ? { probe: input.probe ?? probeDirectWorkerVersion } : {}),
    ...(configFile ? { configFile } : {}),
  });
  for (const finding of report.findings.slice(0, 15)) {
    const name = finding.cli === '*' ? 'Direct Worker'
      : finding.kind === 'dispatch' ? `Direct Worker Dispatch (${finding.cli})` : `Direct Worker (${finding.cli})`;
    lines.push({ name, status: finding.status, message: `${finding.code}: ${finding.message} [next: ${finding.nextAction}]` });
  }
  if (report.findings.length > 15) {
    lines.push({ name: 'Direct Worker', status: 'warn',
      message: `${report.findings.length - 15} additional findings; narrow the cli set in parallelism.clis` });
  }
  if (probeWorkers && !report.findings.some(finding => finding.code === 'WORKER_DIRECT_READY')) {
    lines.push({ name: 'Direct Worker', status: 'info',
      message: 'no profile is onboarded; profiles are unqualified until an authenticated smoke run (see #3005)' });
  }
  return { lines, probed: probeWorkers, workersConfigured: true };
}
