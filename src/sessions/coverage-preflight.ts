import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../cli/find-package-root.js';
import { inspectInstallation } from '../installation/manager.mjs';
import {
  ExpectedSessionProviderSchema, SESSION_PROVIDER_ALIASES, SESSION_PROVIDER_IDS,
  SessionContractError, SessionCoveragePreflightSchema, SessionRuntimeIdentitySchema,
  type SessionCoveragePreflight, type SessionRuntimeIdentity,
} from './contracts.js';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import type { SessionSourceAdapterRegistry } from './discovery.js';
import type { DiscoveryProviderReport } from './workspace-discovery.js';
import type { BatchSourceDisposition } from './batch-contracts.js';

export function expectedSessionProviders(values: readonly string[]): string[] {
  const providers = values.map((value) => {
    const canonical = SESSION_PROVIDER_ALIASES[value.trim() as keyof typeof SESSION_PROVIDER_ALIASES]
      ?? value.trim();
    if (!ExpectedSessionProviderSchema.safeParse(canonical).success) {
      throw new SessionContractError('INVALID_ARGUMENT', `invalid expected provider: ${value}`);
    }
    return canonical;
  });
  if (providers.length === 0) {
    throw new SessionContractError('INVALID_ARGUMENT', 'expected providers must not be empty');
  }
  return [...new Set(providers)].sort();
}

/** Resolve the code actually loaded, independently of cwd, AIWG_ROOT and corpus redirects. */
export function sessionRuntimeIdentity(): SessionRuntimeIdentity {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) throw new SessionContractError('INVALID_ARGUMENT', 'cannot locate the running AIWG package');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const executable = process.argv[1] ?? process.execPath;
  const base = {
    packageName: pkg.name, version: pkg.version, packageRoot: realpathSync(packageRoot),
    executable, nodeVersion: process.version,
  };
  try {
    const installation = inspectInstallation({ actualRoot: packageRoot, createIfMissing: false });
    return SessionRuntimeIdentitySchema.parse({
      ...base,
      installationMethod: installation.actualMethod,
      installationState: installation.state,
      canonicalRoot: installation.identity?.root ?? null,
      diagnostics: [
        ...installation.drift,
        ...(['mismatch', 'stale'].includes(installation.state)
          ? ['Deliberately select a compatible runtime, inspect `aiwg installation show`, and rediscover. No automatic upgrade or installation switch is performed.'] : []),
      ],
    });
  } catch (error) {
    return SessionRuntimeIdentitySchema.parse({
      ...base, installationMethod: 'unknown', installationState: 'unknown', canonicalRoot: null,
      diagnostics: [
        error instanceof Error ? error.message : String(error),
        'Inspect `aiwg installation show` and deliberately select a compatible runtime before claiming complete coverage.',
      ],
    });
  }
}

export function coveragePreflight(options: {
  expectedProviders?: readonly string[];
  expectedProviderBasis?: SessionCoveragePreflight['expectedProviderBasis'];
  registry?: SessionSourceAdapterRegistry;
  runtime?: SessionRuntimeIdentity;
  reports?: DiscoveryProviderReport[];
} = {}): SessionCoveragePreflight {
  const expectedProviders = expectedSessionProviders(options.expectedProviders ?? SESSION_PROVIDER_IDS);
  const adapters = (options.registry ?? createSessionAdapterRegistry()).list();
  const runtime = options.runtime ?? sessionRuntimeIdentity();
  const ledger = expectedProviders.map((provider): SessionCoveragePreflight['ledger'][number] => {
    const adapter = adapters.find((item) => item.provider === provider);
    const report = options.reports?.find((item) => item.provider === provider);
    const entry: SessionCoveragePreflight['ledger'][number] = {
      provider, disposition: 'not-checked', adapterVersion: adapter?.adapterVersion ?? null,
      supportedOperations: [...(adapter?.supportedOperations ?? [])],
      acquisitionModes: [...(adapter?.acquisitionModes ?? [])],
      sourceCount: report?.sourceCount ?? 0, boundaries: [],
      remediation: report?.remediation ?? 'Run authorized workspace discovery or select a supported export.',
    };
    if (!adapter) {
      entry.disposition = 'missing-adapter';
      entry.remediation = `Running ${runtime.packageName} ${runtime.version} at ${runtime.packageRoot} has no ${provider} adapter. Deliberately select a compatible runtime or use an explicitly authorized supported export; no installation is switched automatically.`;
    } else if (adapter.disposition === 'unsupported' || !adapter.supportedOperations.includes('stream')) {
      entry.disposition = 'unsupported';
    } else if (report?.reasonCode === 'SHARED_ROOT_AUTHORIZATION_REQUIRED') {
      entry.disposition = 'authorization-required';
    } else if (report?.status === 'export-required' || !adapter.supportedOperations.includes('discover')) {
      entry.disposition = 'export-required';
    } else if (report?.status === 'unavailable') {
      entry.disposition = 'unavailable';
    } else if (report?.reasonCode === 'MUSE_SOURCE_INSPECTION_INCOMPLETE') {
      entry.disposition = report.sourceCount > 0 ? 'pending-import' : 'not-checked';
      entry.boundaries.push('Some Muse sources could not be fully inspected; see museSourceInspections in the discovery manifest.');
      entry.remediation = report.remediation;
    } else if (report?.status === 'checked') {
      entry.disposition = report.sourceCount > 0 ? 'pending-import' : 'no-sources';
      entry.remediation = report.sourceCount > 0
        ? 'Import the exact authorized manifest and inspect source dispositions.'
        : 'Zero matching sources does not establish no activity; verify scope, authorization and export availability.';
    }
    if (provider === 'muse') {
      entry.boundaries.push('Native discovery includes parent session.jsonl logs only; nested subagent logs and approval-review scope are not established.');
    }
    return entry;
  });
  return SessionCoveragePreflightSchema.parse({
    expectedProviders,
    expectedProviderBasis: options.expectedProviderBasis ?? (options.expectedProviders ? 'explicit' : 'declared-default'),
    supportedProviders: adapters.map((adapter) => adapter.provider), runtime,
    status: 'partial', unresolvedProviders: expectedProviders, ledger,
  });
}

export function reconcileCoveragePreflight(
  preflight: SessionCoveragePreflight,
  sources: BatchSourceDisposition[],
): SessionCoveragePreflight {
  const accepted = new Set(['committed', 'duplicate', 'previously-committed']);
  const ledger = preflight.ledger.map((entry) => {
    if (!['pending-import', 'import-incomplete', 'scope-incomplete', 'acquired'].includes(entry.disposition)) return entry;
    const selected = sources.filter((source) => source.provider === entry.provider);
    const imported = selected.length === entry.sourceCount && selected.length > 0
      && selected.every((source) => accepted.has(source.status) && source.eventsAccepted > 0);
    return {
      ...entry,
      disposition: !imported ? 'import-incomplete' as const
        : entry.boundaries.length > 0 ? 'scope-incomplete' as const : 'acquired' as const,
      remediation: !imported ? 'Resolve pending, rejected, skipped or empty imports before claiming acquisition coverage.'
        : entry.boundaries.length > 0 ? 'Declare the parent-only boundary and separately authorize supported exports for omitted scope.' : null,
    };
  });
  const unresolvedProviders = ledger.filter((entry) => entry.disposition !== 'acquired').map((entry) => entry.provider);
  const runtimeGap = ['mismatch', 'stale', 'unknown'].includes(preflight.runtime.installationState);
  return {
    ...preflight, ledger, unresolvedProviders,
    status: unresolvedProviders.length > 0 || runtimeGap || preflight.expectedProviderBasis !== 'explicit'
      ? 'partial' : 'complete',
  };
}
