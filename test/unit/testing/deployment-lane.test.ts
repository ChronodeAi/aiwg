import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import base from '../../../config/vitest.config.js';
import deployment from '../../../config/vitest.deployment.config.js';
import uatConfig from '../../../config/vitest.uat.config.js';
import { deploymentFiles } from '../../../config/test-lanes.mjs';

const root = path.resolve(import.meta.dirname, '../../..');

describe('required provider deployment lane', () => {
  it('owns exactly the two full-corpus files and runs them serially', () => {
    expect(deploymentFiles).toEqual([
      'test/integration/use-all-deployment.test.ts',
      'test/integration/hermes-deployment.test.ts',
    ]);
    expect(deployment.test.include).toEqual(deploymentFiles);
    expect(deployment.test).toMatchObject({
      pool: 'forks', maxWorkers: 1, minWorkers: 1,
      fileParallelism: false, isolate: true,
    });
    for (const file of deploymentFiles) expect(base.test.exclude).toContain(file);
    expect(deployment.test.globalSetup).toEqual([
      './test/helpers/prebuilt-relations-setup.mjs',
      './test/helpers/deployment-cache-setup.mjs',
    ]);
  });

  it('is a required canonical build prerequisite while the core watchdog stays bounded', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.deployment;
    expect(job.name).toBe('Provider deployment integration');
    expect(job['timeout-minutes']).toBe(25);
    const commands = job.steps.map((step: { run?: string }) => step.run ?? '');
    expect(commands).toContain('npm run build:cli');
    expect(commands).toContain('node tools/ci/run-with-hang-report.mjs --timeout 18m -- npm run test:deployment');
    expect(workflow.jobs.build.needs).toContain('deployment');
    const coreCommands = workflow.jobs.test.steps.map((step: { run?: string }) => step.run ?? '');
    expect(coreCommands).toContain('node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test');

    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:deployment']).toBe(
      'node tools/testing/run-default-lane.mjs --config config/vitest.deployment.config.js',
    );
  });

  it('leaves setup and post-test headroom around the core test watchdog', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.test;
    const steps = job.steps as Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }>;
    const core = steps.findIndex(step => step.name === 'Run tests');
    const uat = steps.findIndex(step => step.name === 'Run UAT');
    const serve = steps.findIndex(step => step.run === 'npm run test:integration:serve');
    expect(core).toBeGreaterThan(0);
    expect(steps[core].run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test');
    expect(uat).toBeGreaterThan(core);
    expect(steps[uat].run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat');
    expect(serve).toBeGreaterThan(uat);
    for (const step of [steps[core], steps[uat], steps[serve]]) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
    // CI 87132 spent 5m14s before tests; retain six minutes for setup and
    // three for UAT and five for the required serve integration and cleanup.
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(6 + 20 + 3 + 5);
    expect(base.test.exclude).toContain('test/uat/**');
    expect(uatConfig.test.include.length).toBeGreaterThan(0);
    expect(uatConfig.test.include.every((file: string) => file.startsWith('test/uat/'))).toBe(true);
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.uat).toBe('vitest run --config config/vitest.uat.config.js');
    expect(scripts['test:ci']).toBe('npm test && vitest run --config config/vitest.uat.config.js');
  });
});
