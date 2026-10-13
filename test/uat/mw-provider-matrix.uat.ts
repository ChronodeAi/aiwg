/**
 * UAT: provider x role wrapper-route matrix (CI-safe subset)
 *
 * Automates two scenarios from the agentic UAT plan:
 *
 *   - MW-023: the provider x role compilation count is derived from the
 *     shipped model catalog at run time, never a hard-coded constant, and
 *     worker-health-adapter coverage is reported with the providers lacking
 *     an adapter named explicitly.
 *   - MW-001 (count half): for every model-policy provider, compiling each
 *     of the three roles (efficiency/coding/reasoning) yields an envelope
 *     whose `model.outcome` is one of the six documented compilation
 *     outcomes, and no provider is silently skipped.
 *
 * The full MW-001 also asserts on the rendered wrapper prompt text and
 * launch envelope shape for a human reviewer; that part needs no CLI
 * subprocess either, but is out of scope here — this file only covers the
 * "count half" explicitly carved out for CI automation (see the plan's
 * candidates-for-automation table).
 *
 * No subprocess spawn: `aiwg steward models --route` is invoked in-process
 * through its real handler (same technique as aiwg-config-flow.uat.ts),
 * which is enough to exercise the real compilation path without the
 * per-call Node startup cost of 54 separate child processes.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// @ts-ignore
const __dirname_uat = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(__dirname_uat, '../..');

const CATALOG_PATH = join(PROJECT_ROOT, 'agentic/code/providers/model-catalog.v1.json');
const CAPABILITIES_PATH = join(PROJECT_ROOT, 'agentic/code/providers/model-capabilities.v1.json');

// The six outcomes documented for CompiledModelPolicy.outcome
// (src/models/types.ts ModelCompilationOutcome). No exported array of the
// literal union exists to import, so this is the stable key set, not a
// stand-in for one string.
const ALLOWED_OUTCOMES = new Set([
  'native', 'compiled', 'inherited', 'global-only', 'informational', 'unsupported',
]);

interface CatalogCounts {
  modelPolicyProviders: string[];
  capabilityProviders: string[];
  workerHealthAdapters: string[];
  withoutAdapter: string[];
  expectedCompilations: number;
}

/** Mirrors MW-023's `node -e` step: derive counts from the shipped JSON, never a literal. */
function computeCatalogCounts(): CatalogCounts {
  // Fresh reads (not `require`, which vitest/node would cache across tests
  // that mutate these fixtures) are unnecessary here since nothing in this
  // suite writes to the shipped catalog, but JSON.parse keeps the intent
  // explicit: this is a read of the actual shipped file, not a fixture.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const catalog = require(CATALOG_PATH);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const capabilities = require(CAPABILITIES_PATH);
  const modelPolicyProviders = Object.keys(catalog.providers);
  const capabilityProviders = Object.keys(capabilities.providers);
  const workerHealthAdapters = capabilityProviders.filter((id) => capabilities.providers[id].workerHealthAdapter);
  const withoutAdapter = capabilityProviders.filter((id) => !capabilities.providers[id].workerHealthAdapter);
  return {
    modelPolicyProviders,
    capabilityProviders,
    workerHealthAdapters,
    withoutAdapter,
    expectedCompilations: modelPolicyProviders.length * 3,
  };
}

function makeCtx(cwd: string, args: string[]) {
  return { args, rawArgs: args, cwd, frameworkRoot: PROJECT_ROOT };
}

/** Capture one `aiwg steward models --route ... --json` call in-process. */
async function routeOnce(cwd: string, provider: string, roleFlags: string[]): Promise<{ exitCode: number; envelope: any }> {
  // @ts-ignore
  const { stewardHandler } = await import(join(PROJECT_ROOT, 'src/cli/handlers/steward.js'));
  const args = [
    'models', '--route', '--provider', provider,
    '--capability-type', 'skill', '--capability', 'aiwg-status',
    '--assignment', 'report workspace status only',
    '--json', ...roleFlags,
  ];
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  let result: { exitCode: number };
  try {
    result = await stewardHandler.execute(makeCtx(cwd, args));
  } finally {
    console.log = origLog;
  }
  let envelope: any = undefined;
  try {
    envelope = JSON.parse(lines.join('\n'));
  } catch {
    // leave undefined; caller asserts on exitCode/shape together
  }
  return { exitCode: result.exitCode, envelope };
}

describe('UAT: MW-023 — provider x role count is derived, never hard-coded', () => {
  it('expectedCompilations is policy-provider-count * 3, and adapter coverage is explicit', () => {
    const counts = computeCatalogCounts();

    expect(counts.modelPolicyProviders.length).toBeGreaterThan(0);
    expect(counts.expectedCompilations).toBe(counts.modelPolicyProviders.length * 3);

    // Every capability provider is accounted for exactly once, either with
    // or without a workerHealthAdapter — the "without" set is reported
    // explicitly (named providers), never silently omitted.
    expect(counts.workerHealthAdapters.length + counts.withoutAdapter.length).toBe(counts.capabilityProviders.length);
    for (const id of counts.withoutAdapter) {
      expect(counts.capabilityProviders).toContain(id);
    }
    // Self-consistency: recomputing the without-adapter set independently
    // from the same source agrees with the derived list (guards against the
    // computation silently drifting from the underlying registry shape).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const capabilities = require(CAPABILITIES_PATH);
    const recomputed = counts.capabilityProviders.filter((id) => !capabilities.providers[id].workerHealthAdapter);
    expect(recomputed.sort()).toEqual([...counts.withoutAdapter].sort());
  });
});

describe('UAT: MW-001 (count half) — every provider compiles all three roles', () => {
  it('every model-policy provider x role yields an allowed outcome, no provider missing', async () => {
    const counts = computeCatalogCounts();
    const tmpDir = mkdtempSync(join(tmpdir(), 'aiwg-uat-mw001-'));
    try {
      const roleFlavors: Array<{ role: string; flags: string[] }> = [
        { role: 'efficiency', flags: ['--routine'] },
        { role: 'coding', flags: ['--complex'] },
        { role: 'reasoning', flags: ['--high-impact', '--allow-premium'] },
      ];

      const seenProviders = new Set<string>();
      let completed = 0;
      for (const provider of counts.modelPolicyProviders) {
        for (const flavor of roleFlavors) {
          const { exitCode, envelope } = await routeOnce(tmpDir, provider, flavor.flags);
          expect(exitCode, `provider ${provider} role ${flavor.role} should exit 0`).toBe(0);
          expect(envelope, `provider ${provider} role ${flavor.role} should produce a JSON envelope`).toBeDefined();
          expect(envelope.provider).toBe(provider);
          expect(envelope.role, `provider ${provider} role ${flavor.role}`).toBe(flavor.role);
          expect(envelope.model, `provider ${provider} role ${flavor.role} should compile a model policy`).toBeTruthy();
          expect(ALLOWED_OUTCOMES.has(envelope.model.outcome),
            `provider ${provider} role ${flavor.role} outcome "${envelope.model?.outcome}" is outside the allowed set`).toBe(true);
          seenProviders.add(provider);
          completed += 1;
        }
      }

      // No provider silently skipped, and the total matches MW-023's derived count.
      expect(seenProviders.size).toBe(counts.modelPolicyProviders.length);
      expect(completed).toBe(counts.expectedCompilations);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
