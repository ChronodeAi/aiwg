/**
 * Direct-worker dispatch opt-in offer (#3050).
 *
 * `parallelism.worker_dispatch` is off by default (#1359) and nothing told a
 * user it exists, showed whether their machine could use it, or offered to
 * turn it on. This module is the single shared place that decides whether
 * any setup surface should offer it, and renders the matching prompt/hint
 * text — every surface (`aiwg init`, `aiwg setup project`, `aiwg regenerate`,
 * `aiwg refresh`, `aiwg doctor --probe-workers`) calls it instead of growing
 * its own copy.
 *
 * Detection is presence-only: each known worker-CLI executable (from the
 * shipped provider capability registry's `workerAdapter` /
 * `workerHealthAdapter` process invocations — the same provider ->
 * executable mapping `resolveDirectBinding()` in `worker-direct-readiness.ts`
 * resolves bindings from) is checked for a match on `PATH` only. No process
 * is spawned and no network call is made. This is deliberately narrower
 * than `worker-direct-readiness.ts`'s version probes
 * (`probeDirectWorkerVersion` / `boundedVersionProbe`), which spawn
 * `<executable> ...versionArgv` and are opt-in behind `--probe-workers`;
 * the offer only needs to know a CLI is present, so it never pays that cost
 * or crosses that trust boundary.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadProviderModelCapabilities } from './provider-policy.js';
import type { ProviderModelCapabilityRegistry } from './provider-policy.js';
import type { ParallelismConfig, SetupConfig } from '../config/aiwg-config.js';

/**
 * The one command every hint/prompt points at to flip the setting on — this
 * is also the real re-enable path after a decline: enabling dispatch
 * directly always clears the offer (see {@link evaluateWorkerDispatchOffer}),
 * so there is no separate "undo the decline" command to document.
 */
export const WORKER_DISPATCH_ENABLE_COMMAND = 'aiwg config set --project parallelism.worker_dispatch true';

/** Readiness check shared by setup hints and dispatch refusals. */
export const WORKER_DISPATCH_READINESS_COMMAND = 'aiwg doctor --probe-workers';

/**
 * Dotted config path a decline is recorded at. A setup/onboarding
 * preference, not worker policy — kept out of `parallelism`, which is a
 * frozen contract fragment (B-OG-29, #3050 review).
 */
export const WORKER_DISPATCH_DECLINE_FIELD = 'setup.worker_dispatch_offer' as const;

/** Minimum number of distinct detected worker CLIs before any surface offers. */
const MIN_DETECTED_FOR_OFFER = 2;

/**
 * Presence-only PATH check for one executable name: no spawn, no network.
 * Requires a regular file (symlinks are followed by `statSync`) before the
 * execute-permission check — an `X_OK` search-permission bit also succeeds
 * for a directory, so without this a directory on `PATH` that merely shares
 * a worker CLI's name would count as installed (#3050 review item 8).
 */
function executableOnPath(name: string, pathEnv: string | undefined): boolean {
  const dirs = (pathEnv ?? '').split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  return dirs.some(dir => candidates.some(candidate => {
    const target = join(dir, candidate);
    try {
      if (!statSync(target).isFile()) return false;
      accessSync(target, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

/**
 * Every known worker-CLI executable name declared by the shipped capability
 * registry, deduplicated and sorted. Mirrors the same provider -> executable
 * mapping `worker-direct-readiness.ts`'s `resolveDirectBinding()` resolves
 * at dispatch time (`workerAdapter` falling back to `workerHealthAdapter`),
 * so this list can never drift from what the resolver would actually bind.
 */
export function knownWorkerCliExecutables(
  registry: ProviderModelCapabilityRegistry = loadProviderModelCapabilities(),
): string[] {
  const names = new Set<string>();
  for (const provider of Object.values(registry.providers)) {
    const adapter = provider.workerAdapter ?? provider.workerHealthAdapter;
    if (adapter?.invocation.kind === 'process') names.add(adapter.invocation.executable);
  }
  return [...names].sort();
}

/**
 * Which known worker CLIs are present on `PATH` right now. Presence-only:
 * never spawns a process and never makes a network call. `registry` and
 * `pathEnv` are both injectable so callers (and tests) never depend on
 * whichever CLIs happen to be installed on the running host.
 */
export function detectInstalledWorkerClis(options: {
  registry?: ProviderModelCapabilityRegistry;
  pathEnv?: string;
} = {}): string[] {
  const executables = knownWorkerCliExecutables(options.registry);
  const pathEnv = options.pathEnv ?? process.env.PATH;
  return executables.filter(executable => executableOnPath(executable, pathEnv));
}

export interface WorkerDispatchOfferDecision {
  /** Whether a setup surface should offer/hint turning dispatch on. */
  shouldOffer: boolean;
  /** The detected worker CLIs that justify (or fail to justify) the offer. */
  detected: string[];
}

/**
 * Should any setup surface offer or hint turning `worker_dispatch` on?
 * `false` whenever it is already on, or the offer was previously declined
 * (`setup.worker_dispatch_offer === 'declined'`) — a user who said no is
 * not asked again on every run (#3050 item 3). Otherwise `true` once two or
 * more known worker CLIs are detected.
 *
 * `parallelism` and `setup` are deliberately separate parameters, not one
 * merged config object: `parallelism` is the frozen worker-policy contract
 * fragment (B-OG-29) and must never gain fields for setup preferences; the
 * decline itself lives in `setup`, a plain onboarding-preferences block.
 */
export function evaluateWorkerDispatchOffer(
  parallelism: ParallelismConfig | undefined,
  setup: SetupConfig | undefined,
  detected: string[],
): WorkerDispatchOfferDecision {
  if (parallelism?.worker_dispatch === true) return { shouldOffer: false, detected };
  if (setup?.worker_dispatch_offer === 'declined') return { shouldOffer: false, detected };
  return { shouldOffer: detected.length >= MIN_DETECTED_FOR_OFFER, detected };
}

/**
 * One-line interactive yes/no question naming the detected CLIs. Callers
 * MUST default the answer to `false` (no) — see #3050's "never enable
 * without an explicit yes" constraint.
 */
export function workerDispatchOfferQuestion(detected: string[]): string {
  return `  Detected worker CLIs (${detected.join(', ')}). Enable direct worker dispatch so AIWG `
    + `can dispatch tasks to them directly, using their own accounts' quota? [y/N]: `;
}

/**
 * One-line non-interactive / regenerate / refresh / doctor hint. Never
 * prompts and never changes anything by itself — it only names the enable
 * command and the readiness check that confirms the CLIs are actually
 * launchable.
 */
export function workerDispatchOfferHint(detected: string[]): string {
  return `Direct worker dispatch is off; detected worker CLIs: ${detected.join(', ')}. `
    + `Enable with \`${WORKER_DISPATCH_ENABLE_COMMAND}\` (then check readiness with \`${WORKER_DISPATCH_READINESS_COMMAND}\`).`;
}
