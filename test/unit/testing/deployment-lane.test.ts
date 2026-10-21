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

  it('is a required canonical build prerequisite', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.deployment;
    expect(job.name).toBe('Provider deployment integration');
    expect(job['timeout-minutes']).toBe(25);
    const commands = job.steps.map((step: { run?: string }) => step.run ?? '');
    expect(commands).toContain('npm run build:cli');
    expect(commands).toContain('node tools/ci/run-with-hang-report.mjs --timeout 18m -- npm run test:deployment');
    expect(workflow.jobs.build.needs).toContain('deployment');

    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:deployment']).toBe(
      'node tools/testing/run-default-lane.mjs --config config/vitest.deployment.config.js',
    );
  });

  it('runs default tests in two required native Vitest shards', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs['test-shards'];
    expect(job.name).toBe('Default tests (shard ${{ matrix.shard }}/2)');
    expect(job.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2] },
    });
    expect(job['timeout-minutes']).toBe(30);

    const steps = job.steps as Array<{
      name?: string;
      run?: string;
      if?: string;
      env?: Record<string, string>;
      'continue-on-error'?: boolean;
    }>;
    const command = 'node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test -- --shard=${{ matrix.shard }}/2 --maxWorkers=6';
    const shard = steps.find(step => step.name === 'Run default test shard');
    expect(shard).toMatchObject({
      run: command,
      env: {
        AIWG_PERF_BUDGET_VERSION_MS: '300',
        AIWG_PERF_BUDGET_HELP_MS: '750',
        AIWG_PERF_SAMPLE_COUNT: '7',
      },
    });
    expect(shard?.if).toBeUndefined();
    expect(shard?.['continue-on-error']).toBeUndefined();
    expect(steps.map(step => step.run ?? '')).toEqual(expect.arrayContaining([
      'npm ci',
      'npm run typecheck',
      'npm run build:cli',
      'npm run features:sqlite',
      'node tools/ci/runner-headroom.mjs .',
      command,
    ]));

    const preflightSandbox = workflow.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Require bundle provider sandbox suite where bwrap is available (#2846)',
    );
    const shardSandbox = steps.find(step => step.name === preflightSandbox.name);
    expect(shardSandbox?.if).toBe(preflightSandbox.if);
    expect(shardSandbox?.run).toBe(preflightSandbox.run);
    expect(workflow.jobs.build.needs).toEqual(expect.arrayContaining(['test', 'test-shards']));
  });

  it('keeps preflight, UAT and serve single and mandatory', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.test;
    const steps = job.steps as Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }>;
    const uat = steps.findIndex(step => step.name === 'Run UAT');
    const serve = steps.findIndex(step => step.run === 'npm run test:integration:serve');
    expect(steps.some(step => step.name === 'Run tests')).toBe(false);
    expect(uat).toBeGreaterThan(0);
    expect(steps[uat].run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat');
    expect(serve).toBeGreaterThan(uat);
    for (const step of [steps[uat], steps[serve]]) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
    expect(job['timeout-minutes']).toBe(35);
    const allSteps = Object.values(workflow.jobs)
      .flatMap((candidate: any) => candidate.steps ?? []) as Array<{ run?: string }>;
    expect(allSteps.filter(step => step.run === 'node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat')).toHaveLength(1);
    expect(allSteps.filter(step => step.run === 'npm run test:integration:serve')).toHaveLength(1);
    expect(base.test.exclude).toContain('test/uat/**');
    expect(uatConfig.test.include.length).toBeGreaterThan(0);
    expect(uatConfig.test.include.every((file: string) => file.startsWith('test/uat/'))).toBe(true);
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.uat).toBe('vitest run --config config/vitest.uat.config.js');
    expect(scripts['test:ci']).toBe('npm test && vitest run --config config/vitest.uat.config.js');
  });
});
