import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../../helpers/temp-dir.js';
import type { ReaderLimits } from '../../../src/sessions/readers.js';
import { grokbotTranscriptReplicaFilename } from '../../../src/sessions/adapters/grokbot-locator.js';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  CopilotSessionAdapter,
  CursorSessionAdapter,
  DevinDesktopSessionAdapter,
  FactorySessionAdapter,
  GenericSessionInterchangeAdapter,
  GrokBuildSessionAdapter,
  GrokbotSessionAdapter,
  HermesSessionAdapter,
  DeepSeekHarnessSessionAdapter,
  MuseSessionAdapter,
  OpenClawSessionAdapter,
  OpenCodeSessionAdapter,
  OpenHumanSessionAdapter,
  PiSessionAdapter,
  OmpSessionAdapter,
  SESSION_PROVIDER_IDS,
  SessionContractError,
  WarpSessionAdapter,
  type SelectedSource,
  type SessionSourceAdapter,
} from '../../../src/sessions/index.js';

type ErrorCode = 'MALFORMED_SOURCE' | 'UNKNOWN_SCHEMA_MAJOR' | 'SCHEMA_DRIFT';

interface MatrixEntry {
  provider: string;
  issue: number;
  status: 'implemented' | 'manual-only' | 'degraded' | 'unsupported';
  operations: string[];
  fixtures: string;
  tests: string;
  documentation: string;
  conformance: {
    locatorClass: string;
    malformed: [string, ErrorCode];
    schemaEvolution: [string, ErrorCode];
    exceptions?: Record<string, string>;
  };
}

interface Matrix {
  contractVersion: string;
  canonicalProviderCount: number;
  providers: MatrixEntry[];
}

const root = resolve('.');
const matrixPath = resolve(root,
  'docs/planning/session-intelligence/provider-conformance-matrix.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as Matrix;

describe('eighteen-provider session release conformance', () => {
  it.each(matrix.providers)('$provider matrix claims match the executable adapter contract', (entry) => {
    const adapter = adapterFor(entry.provider);
    expect(adapter.provider).toBe(entry.provider);
    expect(adapter.disposition).toBe(entry.status);
    expect([...adapter.supportedOperations].sort()).toEqual([...entry.operations].sort());
    expect(adapter.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(adapter.acquisitionModes.length).toBeGreaterThan(0);
    expect(typeof adapter.inspect).toBe('function');
    expect(typeof adapter.stream).toBe('function');
    expect(typeof adapter.discover).toBe('function');
    const adapterTests = readFileSync(resolve(root, entry.tests), 'utf8');
    const providerDocs = readFileSync(resolve(root, entry.documentation), 'utf8').toLowerCase();
    expect(adapterTests, `${entry.provider}: adapter implementation is not exercised`)
      .toContain(adapter.constructor.name);
    expect(providerDocs, `${entry.provider}: docs omit acquisition/import behavior`)
      .toMatch(/acquisition|ingestion|import/);
    expect(providerDocs, `${entry.provider}: docs omit tested behavior`)
      .toMatch(/test|verif|evidence/);
    for (const unsupported of ['discover', 'inspect', 'stream']
      .filter((operation) => !entry.operations.includes(operation))) {
      const exception = unsupported === 'discover' ? 'discovery' : unsupported;
      expect(entry.conformance.exceptions?.[exception],
        `${entry.provider}: undocumented ${unsupported} exception`).toBeTruthy();
    }
  });

  it.each(matrix.providers)(
    '$provider passes the shared malformed, schema-evolution, and authorization contract',
    async (entry) => {
      const adapter = adapterFor(entry.provider);
      for (const [caseName, fixture] of [
        ['malformed', entry.conformance.malformed],
        ['schemaEvolution', entry.conformance.schemaEvolution],
      ] as const) {
        const [name, code] = fixture;
        const selected = selectedFixture(entry, name);
        await expect(collect(adapter.stream(selected)),
          `${entry.provider}: ${caseName}`).rejects.toMatchObject({ code });
      }

      const unauthorized = selectedFixture(entry, entry.conformance.malformed[0]);
      unauthorized.authorizedScope.allowedRoots = [
        resolve(root, 'test/fixtures/sessions/outside-authorized-scope'),
      ];
      await expect(adapter.inspect(unauthorized), `${entry.provider}: traversal boundary`)
        .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    },
  );

  it.each(['claude', 'codex', 'cursor', 'factory', 'grokbot', 'muse', 'pi', 'omp', 'deepseek-harness'])(
    '%s identifies discovery file limits without source content', async (provider) => {
      const directory = await mkdtemp(resolve(tmpdir(), 'session-file-limit-'));
      await writeFile(resolve(directory, 'session.jsonl'), '{}\n');
      const replica = grokbotTranscriptReplicaFilename('synthetic', '00000000-0000-4000-8000-000000000001');
      await writeFile(resolve(directory, replica), '{}\n');
      const nativeDirectory = resolve(directory, '2026', '10', '18', 'synthetic');
      await mkdir(nativeDirectory, { recursive: true });
      await writeFile(resolve(nativeDirectory, 'session.jsonl'), '{}\n');
      await expect(collect(adapterFor(provider, undefined, 0).discover({
        workspaceId: 'workspace-fixture', allowedRoots: [directory],
      }))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', detail: {
        limit: 'maxFiles', configured: 0, observed: 1,
      } });
    },
  );

  it.each(matrix.providers)('$provider reports content-free schema rejection details', async (entry) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'session-rejection-'));
    const locator = resolve(directory, basename(entry.conformance.malformed[0]));
    const marker = 'synthetic-transcript-marker';
    const expectedPaths: Record<string, string> = {
      claude: 'type', codex: 'method', copilot: 'version', cursor: 'type', factory: 'type',
      hermes: 'id', opencode: 'info', openclaw: 'schemaVersion', openhuman: 'recordType',
      grokbot: 'type', 'grok-build': 'headings', pi: 'type', omp: 'type',
      'deepseek-harness': 'type', warp: 'headings', 'devin-desktop': 'type',
      muse: 'export_schema_version', generic: 'type',
    };
    await writeFile(locator, entry.provider === 'warp' || entry.provider === 'grok-build'
      ? marker : JSON.stringify({ text: marker }) + '\n');
    const selected = { ...selectedFixture(entry, entry.conformance.malformed[0]), locator,
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [directory] } };
    for (const operation of [
      () => adapterFor(entry.provider).inspect(selected),
      () => collect(adapterFor(entry.provider).stream(selected)),
    ]) {
      await expect(operation()).rejects.toSatisfy((error: SessionContractError) => {
        expect(error.code).toMatch(/^(MALFORMED_SOURCE|SCHEMA_DRIFT)$/);
        expect(error.detail).toMatchObject({ issues: expect.arrayContaining([
          { path: expectedPaths[entry.provider], code: expect.any(String) },
        ]) });
        expect(JSON.stringify(error.detail)).not.toContain(marker);
        return true;
      });
    }
  });

  it.each(matrix.providers)('$provider reports configured and observed byte limits', async (entry) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'session-byte-limit-'));
    const locator = resolve(directory, basename(entry.conformance.malformed[0]));
    const content = JSON.stringify({ text: 'synthetic-transcript-marker' }) + '\n';
    await writeFile(locator, content);
    const selected = { ...selectedFixture(entry, entry.conformance.malformed[0]), locator,
      authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [directory] } };
    await expect(adapterFor(entry.provider, { maxRecordBytes: 1 }).inspect(selected))
      .rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        detail: { limit: 'maxRecordBytes', configured: 1, observed: Buffer.byteLength(content) },
      });
  });

  it.each(matrix.providers.filter((entry) => !entry.operations.includes('discover')))(
    '$provider discovery exception is executable and performs no source selection',
    async (entry) => {
      const discovery = collect(adapterFor(entry.provider).discover({
        workspaceId: 'workspace-fixture',
        allowedRoots: [resolve(root, entry.fixtures)],
      }));
      try {
        expect(await discovery).toEqual([]);
      } catch (error) {
        expect(error).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      }
      expect(entry.conformance.exceptions?.discovery).toBeTruthy();
    },
  );

  it('maps every canonical provider exactly once to issue, status, operations, fixtures, tests, and docs', () => {
    expect(matrix.contractVersion).toBe('1.0.0');
    expect(matrix.canonicalProviderCount).toBe(18);
    expect(matrix.providers.map((entry) => entry.provider)).toEqual(SESSION_PROVIDER_IDS);
    expect(new Set(matrix.providers.map((entry) => entry.provider)).size).toBe(18);
    expect(new Set(matrix.providers.map((entry) => entry.issue)).size).toBe(18);

    for (const entry of matrix.providers) {
      expect(entry.issue === 215 || entry.issue === 232 || entry.issue >= 1910).toBe(true);
      expect(entry.issue <= 1921 || [215, 232, 2152, 2165, 2253, 2578].includes(entry.issue)).toBe(true);
      expect(entry.operations).toContain('inspect');
      expect(entry.operations).toContain('stream');
      for (const path of [entry.fixtures, entry.tests, entry.documentation]) {
        expect(existsSync(resolve(root, path)), `${entry.provider}: missing ${path}`).toBe(true);
      }
      expect(statSync(resolve(root, entry.fixtures)).isDirectory()).toBe(true);
      expect(readdirSync(resolve(root, entry.fixtures)).length).toBeGreaterThan(0);
      const tests = readFileSync(resolve(root, entry.tests), 'utf8');
      expect(tests, `${entry.provider}: malformed-input gate`).toMatch(/MALFORMED_SOURCE|malformed/i);
      expect(tests, `${entry.provider}: schema-drift gate`)
        .toMatch(/UNKNOWN_SCHEMA_MAJOR|SCHEMA_DRIFT|unknown-major|drift/i);
    }
  });

  it('keeps provider fixture packs synthetic and free of live credential shapes', () => {
    for (const entry of matrix.providers) {
      for (const name of readdirSync(resolve(root, entry.fixtures))) {
        const path = resolve(root, entry.fixtures, name);
        if (!statSync(path).isFile()) continue;
        const content = readFileSync(path, 'utf8');
        expect(content, `${entry.provider}/${name}: private key`).not.toMatch(
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
        );
        expect(content, `${entry.provider}/${name}: AWS access key`).not.toMatch(
          /\bAKIA[0-9A-Z]{16}\b/,
        );
        expect(content, `${entry.provider}/${name}: GitHub token`).not.toMatch(
          /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
        );
        const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
        expect(emails.every((email) => email.endsWith('@example.test')),
          `${entry.provider}/${name}: non-reserved email fixture`).toBe(true);
      }
    }
  });

  it('keeps the provider matrix and session gates in required CI', () => {
    const workflow = parseYaml(readFileSync(resolve(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const testJob = workflow.jobs.test;
    expect(testJob.name).toBe('Test');
    const steps = testJob.steps as Array<{ run?: string; if?: string; 'continue-on-error'?: boolean }>;
    const required = [
      'npm run test:sessions:sqlite',
      'node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat',
      'npm run test:integration:serve',
    ];
    const positions = required.map(command => steps.findIndex(step => step.run === command));
    for (let i = 0; i < positions.length; i++) {
      expect(positions[i], required[i]).toBeGreaterThan(-1);
      if (i > 0) expect(positions[i], required[i]).toBeGreaterThan(positions[i - 1]);
      expect(steps[positions[i]].if, required[i]).toBeUndefined();
      expect(steps[positions[i]]['continue-on-error'], required[i]).toBeUndefined();
    }
    const shardJob = workflow.jobs['test-shards'];
    expect(shardJob.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } });
    const shard = shardJob.steps.find((step: { name?: string }) => step.name === 'Run default test shard');
    expect(shard).toMatchObject({
      run: 'node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test -- --shard=${{ matrix.shard }}/2 --maxWorkers=6',
    });
    expect(shard.if).toBeUndefined();
    expect(shard['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.build.name).toBe('Build');
    expect(workflow.jobs.build.needs).toEqual(expect.arrayContaining(['test', 'test-shards']));
  });
});

function adapterFor(provider: string, limits?: Partial<ReaderLimits>, maxFiles = 10_000): SessionSourceAdapter {
  const adapters: Record<string, () => SessionSourceAdapter> = {
    claude: () => new ClaudeSessionAdapter(limits, { maxDepth: 8, maxFiles }),
    codex: () => new CodexSessionAdapter(limits, { maxDepth: 8, maxFiles }),
    copilot: () => new CopilotSessionAdapter(limits),
    cursor: () => new CursorSessionAdapter(limits, { maxDepth: 8, maxFiles }),
    'deepseek-harness': () => new DeepSeekHarnessSessionAdapter(limits, maxFiles),
    factory: () => new FactorySessionAdapter(limits, [], { maxDepth: 8, maxFiles }),
    generic: () => new GenericSessionInterchangeAdapter(limits),
    grokbot: () => new GrokbotSessionAdapter(limits, maxFiles),
    'grok-build': () => new GrokBuildSessionAdapter(limits),
    hermes: () => new HermesSessionAdapter(limits),
    muse: () => new MuseSessionAdapter(limits, maxFiles),
    openclaw: () => new OpenClawSessionAdapter(limits),
    opencode: () => new OpenCodeSessionAdapter(limits),
    openhuman: () => new OpenHumanSessionAdapter(limits),
    pi: () => new PiSessionAdapter(limits, maxFiles),
    omp: () => new OmpSessionAdapter(limits, maxFiles),
    warp: () => new WarpSessionAdapter(limits),
    'devin-desktop': () => new DevinDesktopSessionAdapter(limits),
  };
  const create = adapters[provider];
  if (!create) throw new Error(`provider matrix has no executable adapter: ${provider}`);
  return create();
}

function selectedFixture(entry: MatrixEntry, name: string): SelectedSource {
  return {
    provider: entry.provider,
    locator: resolve(root, entry.fixtures, name),
    locatorClass: entry.conformance.locatorClass,
    sourceId: `conformance-${entry.provider}-${name}`,
    authorizedScope: {
      workspaceId: 'workspace-fixture',
      allowedRoots: [resolve(root, entry.fixtures)],
    },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}
