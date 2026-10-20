import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import base from '../../../config/vitest.config.js';
import deployment from '../../../config/vitest.deployment.config.js';
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
    expect(coreCommands).toContain('node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm run test:ci');

    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:deployment']).toBe(
      'node tools/testing/run-default-lane.mjs --config config/vitest.deployment.config.js',
    );
  });
});
