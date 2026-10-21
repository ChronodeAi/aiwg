import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { readUserRegistry } from '../config/user-registry.js';
import { resolveDecisionEnablement } from '../config/decision-config.js';
import * as credentials from './jev-credentials.js';

export const DECISION_COMPACT_ANCHOR = 'Decision offload: read `aiwg show rule decision-offload`; at eligible bounded checkpoints use the CLI or MCP ask capability. Answers are advisory; follow the rule’s fallback and authorization boundaries.';

/** Read configuration evidence only; native session loading is not observable here. */
export async function inspectDecisionOffloadActivation(options: { cwd: string; frameworkRoot?: string; env?: NodeJS.ProcessEnv }) {
  let config;
  try { config = await readAiwgConfig(options.cwd); } catch { config = null; }
  const userRegistry = await readUserRegistry();
  const installed = Object.hasOwn(config?.installed ?? {}, 'decision-engine') || Object.hasOwn(userRegistry.installed, 'decision-engine');
  let evaluateEnabled: boolean | null = null;
  try { evaluateEnabled = resolveDecisionEnablement({ cwd: options.cwd, env: options.env }).enabled; } catch { /* invalid settings are unknown */ }
  // The inspector is supplied by the shared decision runtime. The compatibility
  // branch preserves older installed runtimes and discards credential material.
  const runtime = credentials as typeof credentials & { inspectJevCredential?: (options: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{ configured: boolean | null; enabled: boolean | null }> };
  let askEnabled: boolean | null = false;
  if (installed) {
    try {
      const ask = runtime.inspectJevCredential
        ? await runtime.inspectJevCredential({ cwd: options.cwd, env: options.env })
        : await credentials.lookupJevCredential({ cwd: options.cwd, env: options.env }).then(value => ({ configured: Boolean(value), enabled: value?.enabled ?? false }));
      askEnabled = ask.configured === null || ask.enabled === null ? null : ask.configured && ask.enabled;
    } catch { askEnabled = null; }
  }
  const rulePath = options.frameworkRoot && path.join(options.frameworkRoot, 'agentic/code/addons/decision-engine/rules/decision-offload.md');
  const ruleSourcePresent = rulePath ? await access(rulePath).then(() => true, () => false) : null;
  const startupFile = path.join(options.cwd, 'AIWG.md');
  const startupAnchorPresent = await readFile(startupFile, 'utf8').then(content => content.includes(DECISION_COMPACT_ANCHOR), () => false);
  return { installed, askEnabled, evaluateEnabled,
    shouldAnchor: installed && askEnabled === true, ruleSourcePresent, ruleDelivery: 'unknown' as const,
    startupAnchorPresent, nativeActivation: 'not-claimed' as const };
}
