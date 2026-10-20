import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const load = (file: string) => parse(readFileSync(resolve(root, file), 'utf8'));
const command = 'node tools/ci/run-with-hang-report.mjs --timeout 18m -- npm run test:deployment';

describe('required provider deployment release gates', () => {
  it('blocks Gitea package publication when deployment validation fails', () => {
    const job = load('.gitea/workflows/npm-publish.yml').jobs['build-and-publish'];
    const steps = job.steps;
    const idx = (name: string) => steps.findIndex((step: { name: string }) => step.name === name);
    const lane = idx('Run provider deployment integration lane');
    expect(lane).toBeGreaterThan(idx('Run tests'));
    expect(lane).toBeLessThan(idx('Publish to Gitea npm registry'));
    expect(steps[lane]).toMatchObject({ run: command });
    expect(steps[lane]['continue-on-error']).toBeUndefined();
    expect(steps[lane].if).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(30 + 18);
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
