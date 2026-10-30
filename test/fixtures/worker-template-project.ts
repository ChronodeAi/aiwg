// Creates an entirely temporary direct-dispatch project with synthetic model defaults.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerResolutionFixture } from './worker-resolution.js';

export async function workerTemplateProject() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-2925-'));
  const user = join(root, 'user');
  const builtin = join(root, 'builtin');
  await mkdir(user);
  await mkdir(join(root, '.aiwg'));
  const defaults = join(builtin, 'agentic/code/frameworks/sdlc-complete/config');
  await mkdir(defaults, { recursive: true });
  await writeFile(join(defaults, 'models-v2.json'), JSON.stringify({
    version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, providers: {}, tiers: {},
  }));
  const fixture = workerResolutionFixture();
  const parallelism = fixture.snapshot.config.parallelism!;
  parallelism.groupTemplates = {
    bounded: { ...structuredClone(parallelism.groups!.workers), efforts: ['medium', 'high'],
      dataPolicy: { allowedProcessing: ['local', 'remote'], allowUnknown: false } },
    focused: { template: 'bounded', maxParallel: 1, efforts: ['medium'] },
  };
  parallelism.groups = { workers: { template: 'focused' } };
  const configFile = join(root, '.aiwg/aiwg.config');
  const modelsFile = join(root, 'models.json');
  const write = async () => {
    await writeFile(configFile, JSON.stringify(fixture.snapshot.config));
    await writeFile(modelsFile, JSON.stringify({ defaults: { workerSelection: fixture.projectPolicy } }));
  };
  await write();
  return { root, user, builtin, fixture, parallelism, configFile, modelsFile, write };
}
