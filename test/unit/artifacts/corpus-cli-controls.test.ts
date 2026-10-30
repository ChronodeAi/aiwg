// Audit public resolve/expand controls and all three filesystem roots with offline HTTP.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as yieldToIO } from 'node:timers/promises';
import { corpusHandler } from '../../../src/cli/handlers/subcommands.js';
import { fixtureFetch, httpFixture, type HttpFixture } from '../../fixtures/research/resolve-http.js';
import { expansionFetch, expansionHttp, recommended, type ExpansionHttp } from '../../fixtures/research/expand-http.js';

let temporary: string;
let repo: string;
let corpus: string;
let artifacts: string;
let output: string;
let resolver: HttpFixture;
let expansion: ExpansionHttp;
let fetchMock: ReturnType<typeof vi.fn>;
const title = 'Self-supervised representation learning';

function tree(directory: string): unknown[] {
  const entries: unknown[] = [];
  function visit(file: string) {
    const stat = lstatSync(file);
    entries.push([relative(directory, file), stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isFile() ? readFileSync(file).toString('base64') : stat.isSymbolicLink() ? readlinkSync(file) : null]);
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name));
  }
  visit(directory);
  return entries;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-corpus-controls-'));
  repo = join(temporary, 'repo'); corpus = join(temporary, 'corpus'); artifacts = join(temporary, 'artifacts');
  for (const directory of [repo, corpus, artifacts]) mkdirSync(directory);
  mkdirSync(join(corpus, 'documentation/references'), { recursive: true });
  writeFileSync(join(corpus, 'documentation/references/REF-0001-fixture.md'), `---\ntitle: ${title}\narxiv: 2401.12345\n---\n`);
  writeFileSync(join(repo, 'refs.txt'), `${title}\nself supervised representation\nunrelated tokens\n`);
  writeFileSync(join(repo, 'sentinel.txt'), 'Keep repository content');
  writeFileSync(join(artifacts, 'sentinel.txt'), 'Keep artifact content');
  mkdirSync(join(artifacts, 'research/discovery'), { recursive: true });
  for (const name of ['candidates.jsonl', 'expansion-state.jsonl', 'rejected-candidates.jsonl']) {
    writeFileSync(join(artifacts, 'research/discovery', name), '');
  }
  writeFileSync(join(artifacts, 'research/discovery/expansion-report.md'), 'Existing report');
  for (const key of ['S2_API_KEY', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_CORPUS_ROOT', corpus);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', artifacts);
  resolver = httpFixture(); expansion = expansionHttp();
  expansion.recommendations['arXiv:2401.12345'] = [recommended('candidate')];
  expansion.references.candidate = [];
  const resolveFetch = fixtureFetch(resolver); const expandFetch = expansionFetch(expansion);
  fetchMock = vi.fn(input => String(input).includes('/recommendations/') || String(input).includes('/paper/candidate')
    ? expandFetch(input) : resolveFetch(input));
  vi.stubGlobal('fetch', fetchMock);
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(temporary, { recursive: true, force: true });
});

async function cli(args: string[]) {
  output = '';
  const before = tree(temporary);
  let done = false;
  const pending = corpusHandler.execute({ args, rawArgs: ['corpus', ...args], cwd: repo, frameworkRoot: repo });
  void pending.then(() => { done = true; });
  for (let turn = 0; !done && turn < 10000; turn++) {
    await yieldToIO(1); await vi.advanceTimersByTimeAsync(1000);
  }
  expect(done).toBe(true);
  const result = await pending;
  expect(tree(temporary)).toEqual(before);
  return { ...result, output };
}

const resolveInvalid = [
  ['--year', '2024', '--year', '2024', title],
  ['--from-file', 'refs.txt', '--from-file', 'refs.txt'],
  ['--json', '--json', title],
  [title, 'second reference'],
  [title, '--unknown'],
  ...['0', '-1', '2024.5', '99999999999999999999'].map(year => [title, '--year', year]),
];
const expandInvalid = [
  ['--all', '--since', '2026-01-01'],
  ['--seeds', 'REF-0001', '--since', '2026-01-01'],
  ...['--all', '--write', '--overlap', '--json'].map(flag => ['--all', ...(flag === '--all' ? [] : [flag]), flag]),
  ...[['--seeds', 'REF-0001'], ['--since', '2026-01-01'], ['--per-seed', '2'], ['--max-seeds', '2'],
    ['--from', 'recent'], ['--min-year', '2024'], ['--reexplore-after', '1d']].map(([flag, value]) =>
    [...(['--seeds', '--since'].includes(flag) ? [] : ['--all']), flag, value, flag, value]),
  ...['--per-seed', '--max-seeds'].flatMap(flag => ['0', '-1', '1.5', '99999999999999999999'].map(value => ['--all', flag, value])),
  ...['bad', '2026-13-01', '2026-00-01', '2025-02-29', '2026-01-01T00:00:00Z'].map(date => ['--since', date]),
  ...['-1d', '1.5d', 'bad', '99999999999999999999d'].map(duration => ['--all', '--reexplore-after', duration]),
  ['--all', '--unknown'],
];

describe('missing public corpus validation controls', () => {
  for (const [command, cases] of [['resolve', resolveInvalid], ['expand', expandInvalid]] as const) {
    it.each(cases.map(args => [args]))(`${command} rejects %j with exit 1 and no HTTP or tree changes`, async args => {
      const result = await cli([command, ...args, ...(args.includes('--json') ? [] : ['--json'])]);
      expect(result.exitCode).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.parse(result.output)).toMatchObject({ error: { message: expect.any(String) }, exitCode: 1 });
    });
  }
});

describe('JSON errors and whole-tree read-only contract', () => {
  it('resolve remains read-only on source failures and rejected write attempts', async () => {
    resolver.errors = { s2: 404, arxiv: 404, crossref: 404 };
    for (const json of [false, true]) {
      const result = await cli(['resolve', title, ...(json ? ['--json'] : [])]);
      expect(result.exitCode).toBe(3);
      fetchMock.mockClear();
      const rejected = await cli(['resolve', title, '--write', ...(json ? ['--json'] : [])]);
      expect(rejected.exitCode).toBe(1); expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('expand preview creates no state directories when none exist', async () => {
    rmSync(join(artifacts, 'research'), { recursive: true });
    const result = await cli(['expand', '--all', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ dry_run: true });
  });

  it.each([true, false])('resolve single, batch and semantic outcomes leave all roots untouched (json=%s)', async json => {
    for (const [args, code] of [[[title], 0], [['self supervised representation'], 2], [['unrelated tokens'], 3],
      [['--from-file', 'refs.txt'], 3]] as const) {
      const result = await cli(['resolve', ...args, ...(json ? ['--json'] : [])]);
      expect(result.exitCode).toBe(code);
      if (json) expect(JSON.parse(result.output)).toBeTruthy();
    }
  });

  it.each(['--all', '--seeds', '--since'])('expand %s previews and failures preserve populated trees', async selector => {
    const scope = selector === '--all' ? [selector] : selector === '--seeds' ? [selector, 'REF-0001'] : [selector, '2000-01-01'];
    for (const json of [false, true]) {
      let result = await cli(['expand', ...scope, '--overlap', ...(json ? ['--json'] : [])]);
      expect(result.exitCode).toBe(0);
      if (json) expect(JSON.parse(result.output)).toMatchObject({ dry_run: true });
      expansion.recommendations['arXiv:2401.12345'] = 404;
      result = await cli(['expand', ...scope, ...(json ? ['--json'] : [])]);
      expect(result.exitCode).toBe(3);
      if (json) expect(JSON.parse(result.output)).toMatchObject({ incomplete: true });
      expansion.recommendations['arXiv:2401.12345'] = [recommended('candidate')];
    }
  });

  it.each(['resolve', 'expand'])('%s emits JSON for input/storage errors before HTTP', async command => {
    if (command === 'expand') {
      mkdirSync(join(artifacts, 'research/discovery'), { recursive: true });
      writeFileSync(join(artifacts, 'research/discovery/candidates.jsonl'), 'broken JSON\n');
    }
    const result = await cli([command, ...(command === 'resolve' ? ['--from-file', 'missing.txt'] : ['--all']), '--json']);
    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ error: { message: expect.any(String) }, exitCode: 1 });
  });

  it('expand emits JSON for unavailable artifact storage, even with --write', async () => {
    vi.stubEnv('AIWG_ARTIFACTS_PATH', join(temporary, 'missing'));
    const result = await cli(['expand', '--all', '--write', '--json']);
    expect(result.exitCode).toBe(1); expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ exitCode: 1 });
  });

  it.each([['--help'], ['resolve', '--help'], ['resolve', '-h'], ['expand', '--help'], ['expand', '-h']])(
    'help %j exits 0 without HTTP or tree changes', async (...args) => {
      const result = await cli(args);
      expect(result.exitCode).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
      if (args.length === 1) {
        expect(result.output).toContain('aiwg corpus resolve'); expect(result.output).toContain('aiwg corpus expand');
      } else expect(result.output).toContain(`aiwg corpus ${args[0]}`);
    });

  it.each(['resolve', 'expand'])('%s help preserves JSON mode', async command => {
    const result = await cli([command, '--help', '--json']);
    expect(result.exitCode).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ usage: expect.stringContaining(`aiwg corpus ${command}`) });
  });
});
