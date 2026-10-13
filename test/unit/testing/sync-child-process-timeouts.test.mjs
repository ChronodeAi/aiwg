import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ALLOWLIST_RELATIVE_PATH,
  findInteractiveMarkers,
  findUnboundedCalls,
  TEST_PROCESS_TIMEOUT_MS,
  toPosixPath,
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

describe('findUnboundedCalls — resolves bindings, not just spelling (#3062 finding 3)', () => {
  it('flags an aliased named import (the actual reported miss: execSync as nodeExecSync)', () => {
    const source = `
      import { execSync as nodeExecSync } from 'child_process';
      nodeExecSync('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('does not flag the aliased import once it has a provably positive timeout', () => {
    const source = `
      import { execSync as nodeExecSync } from 'child_process';
      nodeExecSync('git status', { timeout: 30_000 });
    `;
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('flags a default/namespace import used through a reassigned local', () => {
    const source = `
      import cp from 'node:child_process';
      const run = cp.execSync;
      run('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('flags require() destructuring with a rename', () => {
    const source = `
      const { spawnSync: sp } = require('child_process');
      sp('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['spawnSync']);
  });

  it('flags a simple same-file reassignment of the raw identifier', () => {
    const source = `
      import { execFileSync } from 'node:child_process';
      const run = execFileSync;
      run('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execFileSync']);
  });

  it('flags static computed property access (cp["spawnSync"])', () => {
    const source = `
      import cp from 'node:child_process';
      cp['spawnSync']('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['spawnSync']);
  });
});

describe('findUnboundedCalls — requires a provably positive timeout (#3062 finding 4)', () => {
  it('flags timeout: 0', () => {
    const source = "execSync('git status', { timeout: 0 });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags timeout: undefined', () => {
    const source = "execSync('git status', { timeout: undefined });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags a negative numeric literal timeout', () => {
    const source = "execSync('git status', { timeout: -1 });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a simple positive constant arithmetic expression', () => {
    const source = "execSync('git status', { timeout: 30 * 1000 });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('flags a positive timeout literal followed by a spread that could override it', () => {
    const source = "execSync('git status', { timeout: 1000, ...options });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a positive timeout literal that comes after a spread (spread cannot override it)', () => {
    const source = "execSync('git status', { ...options, timeout: 1000 });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('still flags a forwarded, unresolved options object (unchanged — not a regression)', () => {
    const source = "execSync('git status', options);";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('does not flag an identifier-valued timeout (not provably bad, even though not a literal)', () => {
    // Real call sites across the codebase legitimately pass a validated,
    // runtime-resolved timeout (e.g. `{ timeout: warmTimeoutMs }`); the
    // gate cannot prove it positive from syntax alone, but it must not
    // reject it either — only the specific named-bad cases (0, undefined,
    // an overriding spread) are rejected.
    const source = "execSync('git status', { timeout: warmTimeoutMs });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('does not flag a shorthand `{ timeout }` property referencing a non-provably-bad variable', () => {
    // Regression: object shorthand (`{ cwd, timeout }`) is a
    // ShorthandPropertyAssignment, not a PropertyAssignment: an earlier
    // version of this check treated every shorthand as unresolvable and
    // rejected it outright, which flagged real call sites across the
    // codebase that use shorthand with an already-validated timeout
    // variable (e.g. test/characterization/cli-router.test.ts).
    const source = 'execSync(cmd, { encoding: "utf-8", cwd, timeout });';
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('treats a bare shorthand `{ timeout }` the same as any other unresolvable identifier value', () => {
    const source = 'execSync(cmd, { timeout });';
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

  it('ignores marker-shaped text inside a string literal — only real comment tokens count (#3062 finding 16)', () => {
    const source = [
      'function f() {',
      '  const s = "// sync-spawn: interactive not-a-real-marker";',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });

  it('ignores marker-shaped text inside a template literal', () => {
    const source = [
      'function f() {',
      '  const s = `// sync-spawn: interactive not-a-real-marker`;',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });

  it('still finds a marker after an interpolated template literal earlier in the same file', () => {
    // Regression, reproduced against the real src/config/cli.ts: an
    // earlier implementation collected comments with a standalone
    // `ts.createScanner` pass, blind to syntax. A bare scanner has no
    // parser context, so it cannot re-scan a template literal's `${...}`
    // substitutions the way the parser does; mis-tokenizing one desyncs
    // every subsequent token position, silently dropping every later
    // comment — including that file's real `editor-launch` allow-list
    // marker, hundreds of lines after the template literal below (itself
    // adapted from the real source: a string built from two interpolated
    // templates, one nested inside a ternary).
    const source = [
      'process.stderr.write(',
      "  `Note: '${raw}' is a deprecated alias for '${aliased}'; writing '${aliased}'.\\n`",
      '  + (notes[key] ? `      ${notes[key]}\\n` : ""),',
      ');',
      'function f() {',
      '  // sync-spawn: interactive editor-launch',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', line: 6, anchor: 'editor-launch' },
    ]);
  });
});

describe('toPosixPath — Windows allow-list key normalization (#3062 finding 15)', () => {
  it('normalizes a Windows-style (backslash) relative path to POSIX separators', () => {
    // path.win32.relative() always returns backslash separators,
    // regardless of the OS this test actually runs on — exercising the
    // Windows case without requiring a Windows runner.
    const windowsStyle = path.win32.relative('C:\\repo', 'C:\\repo\\src\\cli\\handlers\\session.ts');
    expect(windowsStyle).toBe('src\\cli\\handlers\\session.ts');
    expect(toPosixPath(windowsStyle)).toBe('src/cli/handlers/session.ts');
  });

  it('leaves an already-POSIX relative path unchanged', () => {
    expect(toPosixPath('src/cli/handlers/session.ts')).toBe('src/cli/handlers/session.ts');
  });
});

describe('validateAllowList (#3062)', () => {
  it('passes when every entry has kind "interactive" and exactly one attached marker', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'interactive' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    expect(validateAllowList(allowList, attachedMarkerCountByKey)).toEqual([]);
  });

  it('fails a stale entry — listed but no marker attached to a call', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'gone', kind: 'interactive' }] };
    const problems = validateAllowList(allowList, new Map());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stale');
  });

  it('fails an entry whose kind is not "interactive"', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'long-running' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unsupported kind');
  });

  it('fails a duplicate allow-list entry for the same file+anchor (#3062 finding 16)', () => {
    const allowList = {
      entries: [
        { file: 'src/a.ts', anchor: 'foo', kind: 'interactive' },
        { file: 'src/a.ts', anchor: 'foo', kind: 'interactive' },
      ],
    };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate');
  });

  it('fails an ambiguous entry — the anchor is attached to more than one call (#3062 finding 16)', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'interactive' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 2]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ambiguous');
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

  it('fails (even in report mode) on a duplicate allow-list entry (#3062 finding 16)', () => {
    const root = writeFixture({
      allowListEntries: [
        { file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' },
        { file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'duplicate' },
      ],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate');
  });

  it('fails (even in report mode) on an ambiguous anchor attached to two different calls (#3062 finding 16)', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-sync-spawn-gate-'));
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'tools', 'testing'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });

    // Same anchor text reused on two distinct calls — the registry entry
    // cannot tell which one it is meant to exempt.
    writeFileSync(
      join(fixtureRoot, 'src', 'example.ts'),
      [
        'function first() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi config.yaml', { stdio: 'inherit' });",
        '}',
        'function second() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi other.yaml', { stdio: 'inherit' });",
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'tools', 'testing', 'sync-spawn-allowlist.json'),
      JSON.stringify({
        entries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
      }, null, 2),
    );

    const result = spawnSync(process.execPath, [gateScript, '--root', fixtureRoot], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ambiguous');
  });
});
