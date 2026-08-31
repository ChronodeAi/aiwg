/**
 * Enrichment API contract test (ADR-007, remediation G4).
 *
 * Pins the real method inventory of the three optional-enrichment modules and
 * the orchestrator's call sites, so the FC5 phantom-API class (crash of
 * succeeding loops on `learningExtractor.extract`, `gainScheduler.adjustGains`,
 * `pidController.compute/updateGains`) fails THIS test by name instead of
 * failing production missions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// loose typing: these are ESM .mjs modules with no type declarations
/* eslint-disable @typescript-eslint/no-explicit-any */

describe('ADR-007 enrichment API contract (FC5 regression pin)', () => {
  it('LearningExtractor exposes extractFromLoop and no phantom extract()', async () => {
    const { LearningExtractor } = await import(
      join(REPO_ROOT, 'tools', 'ralph-external', 'lib', 'learning-extractor.mjs')
    );
    const inst: any = new (LearningExtractor as any)();
    expect(typeof inst.extractFromLoop).toBe('function');
    expect(typeof (inst as any).extract).toBe('undefined');
  });

  it('GainScheduler exposes update(state) and no phantom adjustGains()', async () => {
    const { GainScheduler } = await import(join(REPO_ROOT, 'tools', 'ralph-external', 'gain-scheduler.mjs'));
    const inst: any = new (GainScheduler as any)();
    expect(typeof inst.update).toBe('function');
    expect(typeof (inst as any).adjustGains).toBe('undefined');
  });

  it('PIDController exposes process(iteration, state) and no phantom compute()/updateGains()', async () => {
    const { PIDController } = await import(join(REPO_ROOT, 'tools', 'ralph-external', 'pid-controller.mjs'));
    const inst: any = new (PIDController as any)();
    expect(typeof inst.process).toBe('function');
    expect(typeof (inst as any).compute).toBe('undefined');
    expect(typeof (inst as any).updateGains).toBe('undefined');
  });

  it('orchestrator calls the real APIs at the remediated call sites', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'ralph-external', 'orchestrator.mjs'), 'utf-8');
    expect(src).toContain('this.gainScheduler.update(');
    expect(src).toContain('this.pidController.process(');
    expect(src).toMatch(/this\.learningExtractor\.extractFromLoop\(/);
  });

  it('orchestrator no longer calls any phantom enrichment API (FC5)', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'ralph-external', 'orchestrator.mjs'), 'utf-8');
    expect(src).not.toContain('this.learningExtractor.extract(');
    expect(src).not.toContain('.adjustGains(');
    expect(src).not.toContain('this.pidController.updateGains(');
    expect(src).not.toContain('this.pidController.compute(');
  });

  it('enrichment blocks are non-fatal by construction (guarded call sites)', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'ralph-external', 'orchestrator.mjs'), 'utf-8');
    // the remediated blocks carry the non-fatal markers from ADR-007
    expect(src).toContain('enrichment only: a failure here');
    expect(src).toContain('non-fatal');
  });
});
