import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScriptRunner, DefaultScriptRunner } from '../../../../src/cli/handlers/script-runner.js';

describe('DefaultScriptRunner', () => {
  let root: string;
  let runner: DefaultScriptRunner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-script-runner-'));
    runner = new DefaultScriptRunner(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function script(source: string): string {
    writeFileSync(join(root, 'child.cjs'), source);
    return 'child.cjs';
  }

  // Pin the child to the same local Node version as the test process.
  function childEnv(): Record<string, string> {
    return { PATH: dirname(process.execPath) };
  }

  it('drains more than 1 MiB from both pipes and preserves the success contract', async () => {
    const file = script(`
      process.stdout.write('o'.repeat(2 * 1024 * 1024));
      process.stderr.write('e'.repeat(2 * 1024 * 1024));
    `);
    expect(await runner.run(file, [], { capture: true, timeout: 10_000, env: childEnv() }))
      .toEqual({ exitCode: 0 });
  });

  it('bounds failure diagnostics while continuing to drain both pipes', async () => {
    const file = script(`
      process.stdout.write('o'.repeat(2 * 1024 * 1024));
      process.stderr.write('e'.repeat(2 * 1024 * 1024) + 'discarded-tail');
      process.exitCode = 7;
    `);
    const result = await runner.run(file, [], { capture: true, timeout: 10_000, env: childEnv() });
    expect(result).toEqual({ exitCode: 7, message: 'e'.repeat(1024 * 1024) });
  });

  it('preserves ordinary stderr messages and exit codes', async () => {
    const file = script(String.raw`process.stderr.write('  failure: café  \n'); process.exitCode = 3;`);
    expect(await runner.run(file, [], { capture: true, env: childEnv() }))
      .toEqual({ exitCode: 3, message: 'failure: café' });
  });

  it('preserves the inherited-stdio return contract', async () => {
    expect(await createScriptRunner(root).run(script('process.exitCode = 5;'), [], { env: childEnv() }))
      .toEqual({ exitCode: 5 });
  });

  it('preserves timeout status and diagnostics', async () => {
    const file = script('setInterval(() => {}, 1000);');
    const result = await runner.run(file, [], { capture: true, timeout: 250, env: childEnv() });
    expect(result.exitCode).toBe(124);
    expect(result.message).toBe('Script timed out after 250ms');
    expect(result.error?.message).toMatch(/^Timeout after 250ms \(child sent SIGTERM, SIGKILL after \d+ms\)$/);
  });

  it('preserves spawn error status and diagnostics', async () => {
    const result = await runner.run(script(''), [], { capture: true, env: { PATH: root } });
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe(`Script error: ${result.error?.message}`);
    expect(result.error).toMatchObject({ code: 'ENOENT' });
  });
});
