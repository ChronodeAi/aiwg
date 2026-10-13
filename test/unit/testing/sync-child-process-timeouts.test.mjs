import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ALLOWLIST_RELATIVE_PATH,
  findInteractiveMarkers,
  findUnboundedCalls,
  TEST_PROCESS_TIMEOUT_MS,
  validateAllowList,
} from '../../../tools/testing/check-sync-child-process-timeouts.mjs';

const gateScript = fileURLToPath(new URL('../../../tools/testing/check-sync-child-process-timeouts.mjs', import.meta.url));

describe('synchronous child-process timeout gate', () => {
  it('flags each synchronous API when its options omit a timeout', () => {
    const source = `
      execSync('git status', { encoding: 'utf8' });
      execFileSync('git', ['status']);
      spawnSync('git', ['status'], { stdio: 'pipe' });
    `;

    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual([
      'execSync',
      'execFileSync',
      'spawnSync',
    ]);
  });

  it('accepts explicit timeouts on all synchronous APIs', () => {
    const source = `
      execSync('git status', { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      execFileSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      spawnSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
    `;

    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('does not flag calls that go through the bounded helper (#3062)', () => {
    const source = `
      boundedExecSync('git status', 'quick', { encoding: 'utf8' });
      boundedExecFileSync('git', ['status'], 'quick');
      boundedSpawnSync('git', ['status'], 'network', { stdio: 'pipe' });
    `;

    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });
});

describe('findInteractiveMarkers (#3062)', () => {
  it('finds a `// sync-spawn: interactive <anchor>` marker and lower-cases the anchor', () => {
    const source = [
      'function f() {',
      '  // sync-spawn: interactive Editor-Launch — opens $EDITOR',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', line: 2, anchor: 'editor-launch' },
    ]);
  });

  it('ignores lines that are not sync-spawn markers', () => {
    const source = '// a normal comment\nexecSync(cmd);\n';
    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });
});

describe('validateAllowList (#3062)', () => {
  it('passes when every entry has kind "interactive" and a matching marker', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'interactive' }] };
    const markersByKey = new Map([['src/a.ts::foo', { file: 'src/a.ts', line: 3, anchor: 'foo' }]]);
    expect(validateAllowList(allowList, markersByKey)).toEqual([]);
  });

  it('fails a stale entry — listed but no marker found', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'gone', kind: 'interactive' }] };
    const problems = validateAllowList(allowList, new Map());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stale');
  });

  it('fails an entry whose kind is not "interactive"', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'long-running' }] };
    const markersByKey = new Map([['src/a.ts::foo', { file: 'src/a.ts', line: 3, anchor: 'foo' }]]);
    const problems = validateAllowList(allowList, markersByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unsupported kind');
  });
});

describe('CLI — product-code report vs enforce mode (#3062)', () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  function writeFixture({ allowListEntries = [] } = {}) {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-sync-spawn-gate-'));
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'tools', 'testing'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });

    // One bounded (helper) call, one allow-listed interactive call, one plain violation.
    writeFileSync(
      join(fixtureRoot, 'src', 'example.ts'),
      [
        "import { boundedSpawnSync } from '../process/bounded-child-process.mjs';",
        'function ok() {',
        "  boundedSpawnSync('git', ['status'], 'quick');",
        '}',
        'function interactive() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi config.yaml', { stdio: 'inherit' });",
        '}',
        'function violation() {',
        "  spawnSync('git', ['status']);",
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'tools', 'testing', 'sync-spawn-allowlist.json'),
      JSON.stringify({ entries: allowListEntries }, null, 2),
    );
    return fixtureRoot;
  }

  it('report mode (default) never fails, even with product-code violations present', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('src: 1 unbounded (1 allow-listed interactive)');
  });

  it('--enforce-product fails when a non-allow-listed violation is present', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root, '--enforce-product'], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("spawnSync has no explicit timeout, does not go through the bounded helper, and is not on the allow-list");
  });

  it('fails (even in report mode) on a stale allow-list entry', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }, { file: 'src/example.ts', anchor: 'nonexistent', kind: 'interactive', reason: 'stale' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ALLOWLIST_RELATIVE_PATH);
    expect(result.stderr).toContain('stale');
  });

  it('fails (even in report mode) on an allow-list entry with an unsupported kind', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'destructive', reason: 'bad kind' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported kind');
  });
});
