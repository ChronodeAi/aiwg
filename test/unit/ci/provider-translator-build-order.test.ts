// Provider translators load compiled model-wrapper modules, so CI must build first (#2649).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

describe('provider translator steps run after the CLI build', () => {
  it('lints deployed agent sizes only after the test job builds the CLI', () => {
    const workflow = read('.gitea/workflows/ci.yml');
    const build = workflow.indexOf('run: npm run build:cli');
    const lint = workflow.indexOf('run: npm run lint:agent-sizes');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(lint).toBeGreaterThan(build);
  });

  it('builds the CLI before the OMP precedence probe deploys agents', () => {
    const workflow = read('.gitea/workflows/omp-conformance.yml');
    const build = workflow.indexOf('run: npm run build:cli');
    const probe = workflow.indexOf('tools/providers/omp-precedence-conformance.mjs');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(build);
  });
});
