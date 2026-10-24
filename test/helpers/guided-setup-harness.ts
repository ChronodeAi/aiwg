import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { HandlerContext } from '../../src/cli/handlers/types.js';
import type { SetupPlan } from '../../src/discovery/plan-types.js';
import { INTERVIEW_TIME } from './guided-setup-fixture.js';

export function guidedHarness(prefix: string) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  const project = join(scratch, 'project');
  const artifacts = join(scratch, 'artifacts');
  mkdirSync(project); mkdirSync(artifacts);
  vi.stubEnv('HOME', join(scratch, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'config'));
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', join(scratch, 'memory'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', artifacts);
  vi.stubEnv('AIWG_PROJECT_ARTIFACTS_PATH', '');
  vi.stubEnv('AIWG_PROJECT_AIWG_DIR', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(INTERVIEW_TIME));
  return { scratch, project, artifacts,
    ctx: (args: string[]): HandlerContext => ({ cwd: project, args, rawArgs: args, frameworkRoot: process.cwd() }),
    cleanup: () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); },
  };
}
export function withoutAnswerMetadata(plan: SetupPlan): string {
  const copy = structuredClone(plan);
  for (const answer of Object.values(copy.answers)) {
    delete (answer as Partial<typeof answer>).source;
    delete (answer as Partial<typeof answer>).answeredAt;
  }
  return JSON.stringify(copy);
}
