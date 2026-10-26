import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { buildParallelismSection } from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { workerTemplateProject } from '../../fixtures/worker-template-project.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(['codex', 'claude'])('T-OG-13 C01 generated %s guidance shows template origins, digest, ceilings and alias', async provider => {
  const f = await workerTemplateProject(); roots.push(f.root);
  vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
  f.fixture.snapshot.config.providers = [provider];
  const coding = f.fixture.projectPolicy.roleGuidance!.coding;
  f.fixture.projectPolicy.roleGuidance!.maintenance = { ...coding, baseRole: 'coding', effortLadder: ['medium'] };
  await f.write();
  const section = await buildParallelismSection(f.root, { readCatalog: async () => null });
  expect(section).toContain('members: 2');
  expect(section).toContain('maxParallel: 1');
  expect(section).toContain('efforts: medium');
  expect(section).toContain('dataPolicy:');
  expect(section).toContain(f.configFile + '#/parallelism/groupTemplates/bounded');
  expect(section).toContain(workerConfigDigest(f.parallelism.groupTemplates!.bounded));
  expect(section).toContain(f.configFile + '#/parallelism/groupTemplates/focused');
  expect(section).toContain('Project role maintenance aliases coding');
  expect(section).toContain('Resolver eligibility and base-role qualification remain required');
  expect(section).toContain('No Mission/MC session, scheduler, daemon, or activation marker is needed');
});
