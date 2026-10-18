/**
 * Wiring contract for the direct-worker dispatch opt-in next-step line in
 * `aiwg doctor --probe-workers` (#3050 item 6).
 *
 * `tools/cli/doctor.mjs` has top-level await and calls `process.exit()`
 * directly, so (consistent with the rest of `doctor.test.ts`) this inspects
 * the script source for the wiring contract rather than importing it. The
 * actual decision/rendering logic (`evaluateWorkerDispatchOffer`,
 * `workerDispatchOfferHint`) is covered directly by
 * `test/unit/models/worker-dispatch-offer.test.ts`.
 *
 * @source @tools/cli/doctor.mjs
 * @implements #3050
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCTOR_SCRIPT = resolve(__dirname, '../../../tools/cli/doctor.mjs');
const content = readFileSync(DOCTOR_SCRIPT, 'utf-8');

describe('doctor: direct-worker dispatch opt-in next step (#3050)', () => {
  it('imports the shared offer helper', () => {
    expect(content).toContain("models/worker-dispatch-offer.js");
    expect(content).toContain('evaluateWorkerDispatchOffer');
    expect(content).toContain('workerDispatchOfferHint');
    expect(content).toContain('detectInstalledWorkerClis');
  });

  it('gates the offer check behind --probe-workers, never an implicit plain run', () => {
    const marker = content.indexOf('#3050: direct-worker dispatch opt-in next step');
    expect(marker).toBeGreaterThan(0);
    const nearby = content.slice(marker, marker + 800);
    expect(nearby).toMatch(/if \(probeWorkers\) \{/);
  });

  it('reuses the shared config read instead of reading aiwg.config again', () => {
    const marker = content.indexOf('#3050: direct-worker dispatch opt-in next step');
    const nearby = content.slice(marker, marker + 800);
    expect(nearby).toContain('workerSectionsConfig');
    expect(nearby).not.toContain('readAiwgConfig(');
  });

  it('is non-fatal: a failure in the offer check never throws past its own try/catch', () => {
    const marker = content.indexOf('#3050: direct-worker dispatch opt-in next step');
    const nearby = content.slice(marker, marker + 1200);
    expect(nearby).toContain('try {');
    expect(nearby).toContain('catch {');
    expect(nearby).toContain('informational nudge, never a diagnostic gate');
  });
});
