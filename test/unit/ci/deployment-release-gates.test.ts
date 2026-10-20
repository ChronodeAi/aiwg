import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const load = (file: string) => parse(readFileSync(resolve(root, file), 'utf8'));
const command = 'node tools/ci/run-with-hang-report.mjs --timeout 18m -- npm run test:deployment';

describe('required provider deployment release gates', () => {
  it('blocks retained RC creation and therefore stable publication when deployment validation fails', () => {
    const job = load('.github/workflows/release-candidate.yml').jobs.validate;
    const steps = job.steps;
    const idx = (name: string) => steps.findIndex((step: { name: string }) => step.name === name);
    const lane = idx('Run release validation profile');
    expect(lane).toBeGreaterThan(idx('Install mandatory SQLite session test backend'));
    expect(lane).toBeLessThan(idx('Pack and smoke-test exact npm surfaces'));
    expect(steps[lane].run).toContain('release-candidate.mjs validate');
    expect(steps[lane].run).toContain('--profile');
    const profile = steps[idx('Resolve validation profile')];
    expect(profile.run).toContain("PROFILE='routine-release-v1'");
    expect(profile.run).toContain('quarterly-full-v1');
    expect(steps[lane]['continue-on-error']).toBeUndefined();
    expect(steps[lane].if).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(18);
  });
  it('retains the same required lane in plugin tag validation', () => {
    const job = load('.gitea/workflows/build-plugins.yml').jobs.validate;
    const steps = job.steps, tests = steps.findIndex((step: { name: string }) => step.name === 'Run tests');
    const lane = steps.findIndex((step: { name: string }) => step.name === 'Run provider deployment integration lane');
    expect(lane).toBeGreaterThan(tests);
    expect(steps[lane]).toMatchObject({ run: command });
    expect(steps[lane]['continue-on-error']).toBeUndefined();
    expect(steps[lane].if).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThan(28);
  });
});
