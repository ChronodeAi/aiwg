import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigPath, readAiwgConfigCandidate } from '../config/aiwg-config.js';
import { inspectUserRegistry } from '../config/user-registry.js';
import { resolveDecisionEnablement } from '../config/decision-config.js';
import { projectAiwgPath } from '../config/project-artifacts.js';
import * as credentials from './jev-credentials.js';

export const DECISION_COMPACT_ANCHOR = 'Decision offload: before the first eligible bounded choice, including ordinary triage or worker routing, read `aiwg show rule decision-offload` and use the CLI or MCP ask capability. On fallback decide normally. Answers are advisory and do not authorize actions.';

function isInstalledEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as { version?: unknown; source?: unknown; installedAt?: unknown; deployedTo?: unknown };
  return typeof entry.version === 'string' && entry.version.trim().length > 0
    && typeof entry.source === 'string' && entry.source.trim().length > 0
    // Older registry/config entries can predate installedAt, so its absence is
    // compatible; a present non-string timestamp is corrupt evidence.
    && (entry.installedAt === undefined || typeof entry.installedAt === 'string')
    && Boolean(entry.deployedTo) && typeof entry.deployedTo === 'object' && !Array.isArray(entry.deployedTo);
}

async function inspectProjectInstall(cwd: string): Promise<boolean | null> {
  // A positive marker is sufficient installation evidence even when an
  // unrelated user-scope registry or config section is unreadable. Negative
  // evidence still goes through the full candidate validator below.
  const local = getConfigPath(cwd);
  const candidates = [local];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const installed = (parsed as { installed?: unknown }).installed;
        if (installed && typeof installed === 'object' && !Array.isArray(installed)
          && Object.hasOwn(installed, 'decision-engine')) {
          return isInstalledEntry((installed as Record<string, unknown>)['decision-engine']) ? true : null;
        }
      }
      // A valid local config wins over compatibility/artifact copies.
      if (file === local) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (file === local) {
          try {
            const artifact = projectAiwgPath(cwd, 'aiwg.config');
            if (!candidates.includes(artifact)) candidates.push(artifact);
          }
          catch { return null; }
        }
        continue;
      }
      return null;
    }
  }
  try {
    // Installation metadata is independent of worker-model defaults. Reading
    // the validated candidate avoids turning an unrelated missing defaults
    // bundle into unknown addon-installation evidence.
    const config = await readAiwgConfigCandidate(cwd);
    const installed = config?.installed ?? {};
    return Object.hasOwn(installed, 'decision-engine')
      ? isInstalledEntry(installed['decision-engine']) ? true : null
      : false;
  } catch {
    return null;
  }
}

async function inspectUserInstall(): Promise<boolean | null> {
  const inspected = await inspectUserRegistry();
  if (Object.hasOwn(inspected.registry.installed, 'decision-engine')) {
    return isInstalledEntry(inspected.registry.installed['decision-engine']) ? true : null;
  }
  return inspected.status === 'unreadable' ? null : false;
}

function combineInstallEvidence(project: boolean | null, user: boolean | null): boolean | null {
  if (project === true || user === true) return true;
  if (project === null || user === null) return null;
  return false;
}

async function inspectReadableFile(file: string): Promise<boolean | null> {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}

async function inspectAnchor(file: string): Promise<boolean | null> {
  try {
    return (await readFile(file, 'utf8')).includes(DECISION_COMPACT_ANCHOR);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}

/** Read configuration evidence only; native session loading is not observable here. */
export async function inspectDecisionOffloadActivation(options: { cwd: string; frameworkRoot?: string; env?: NodeJS.ProcessEnv }) {
  const [projectInstalled, userInstalled] = await Promise.all([
    inspectProjectInstall(options.cwd),
    inspectUserInstall(),
  ]);
  const installed = combineInstallEvidence(projectInstalled, userInstalled);
  let evaluateEnabled: boolean | null = null;
  try { evaluateEnabled = resolveDecisionEnablement({ cwd: options.cwd, env: options.env }).enabled; } catch { /* invalid settings are unknown */ }
  // The inspector is supplied by the shared decision runtime. The compatibility
  // branch preserves older installed runtimes and discards credential material.
  const runtime = credentials as typeof credentials & { inspectJevCredential?: (options: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{ configured: boolean | null; enabled: boolean | null }> };
  let askEnabled: boolean | null = installed === null ? null : false;
  if (installed === true) {
    try {
      const ask = runtime.inspectJevCredential
        ? await runtime.inspectJevCredential({ cwd: options.cwd, env: options.env })
        : await credentials.lookupJevCredential({ cwd: options.cwd, env: options.env }).then(value => ({ configured: Boolean(value), enabled: value?.enabled ?? false }));
      askEnabled = ask.configured === null || ask.enabled === null ? null : ask.configured && ask.enabled;
    } catch { askEnabled = null; }
  }
  const rulePath = options.frameworkRoot && path.join(options.frameworkRoot, 'agentic/code/addons/decision-engine/rules/decision-offload.md');
  const ruleSourcePresent = rulePath ? await inspectReadableFile(rulePath) : null;
  const startupFile = path.join(options.cwd, 'AIWG.md');
  const startupAnchorPresent = await inspectAnchor(startupFile);
  return { installed, askEnabled, evaluateEnabled,
    shouldAnchor: installed === true && askEnabled === true, ruleSourcePresent, ruleDelivery: 'unknown' as const,
    startupAnchorPresent, nativeActivation: 'not-claimed' as const };
}
