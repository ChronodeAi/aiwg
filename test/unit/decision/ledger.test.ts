import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDecisionLedgerRecord,
  ATTRIBUTION_FIELD_PATTERN,
  buildDecisionLedgerRecord,
  DECISION_LEDGER_SCHEMA,
  DecisionLedgerSinceError,
  decisionLedgerHistory,
  decisionLedgerStats,
  MAX_LEDGER_RECORD_BYTES,
  MAX_RECORDED_CHOICE_IDS,
  parseDecisionLedgerSince,
  recordDecisionAsk,
  resolveDecisionSessionId,
  type DecisionLedgerBuildContext,
  type RecordDecisionAskOptions,
} from '../../../src/decision/ledger.js';
import type { DecisionAskInput, DecisionAskResult } from '../../../src/decision/ask.js';
import type { ProviderResolution } from '../../../src/cli/provider-resolution.js';
import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';

const FIXED_NOW = Date.UTC(2026, 9, 12, 0, 0, 0);
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Environment isolation (review r1 finding 10, review r2 item 14). The
// harness-marker list is derived from every provider definition's
// `detection.env`, so adding a new provider marker anywhere in
// src/providers/provider-definitions.ts automatically stays covered here —
// a hand-curated list previously missed WARP_SESSION_ID/WARP_TERMINAL and
// WINDSURF_VERSION.
// ---------------------------------------------------------------------------

function allHarnessMarkerEnvKeys(): string[] {
  return [...new Set(listProviderDefinitions().flatMap(definition => definition.detection.env))];
}

const ISOLATED_ENV_KEYS = [
  'HOME', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_SESSION_ID', 'CI', 'AIWG_ROOT',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROVIDER', 'CLAUDECODE_PROVIDER', 'AIWG_TEST_PROCESS_PROVIDER', 'AIWG_DISABLE_PROCESS_PROVIDER_DETECTION',
  'AIWG_DECISION_ENABLED', 'JEV_API_KEY', 'AIWG_DECISION_JEV_API_KEY', 'XDG_CONFIG_HOME',
  ...allHarnessMarkerEnvKeys(),
] as const;

describe('decision ledger', () => {
  let savedEnv: Record<string, string | undefined> = {};
  const directories: string[] = [];

  beforeEach(() => {
    savedEnv = {};
    for (const key of ISOLATED_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    directories.length = 0;
  });

  async function tempRoot(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-ledger-'));
    directories.push(directory);
    return directory;
  }

  const yesNoInput: DecisionAskInput = { question: 'Proceed?', mode: { kind: 'yes-no' } };

  const answeredResult: DecisionAskResult = {
    schema: 'aiwg-decision-ask/v1',
    status: 'answered',
    answer: true,
    confidence: 0.93,
    probability: 0.93,
    fallback: null,
    reason: 'none',
    model: 'jev-1.13.0',
    usage: { inputTokens: 12, outputTokens: 3 },
    latencyMs: 42,
  };

  const fallbackResult: DecisionAskResult = {
    schema: 'aiwg-decision-ask/v1',
    status: 'fallback',
    answer: null,
    confidence: null,
    fallback: 'llm',
    reason: 'low-confidence',
    model: 'jev-1.13.0',
    usage: { inputTokens: 20, outputTokens: 5 },
    latencyMs: 30,
  };

  const notConfiguredResult: DecisionAskResult = {
    schema: 'aiwg-decision-ask/v1',
    status: 'fallback',
    answer: null,
    confidence: null,
    fallback: 'llm',
    reason: 'not-configured',
    model: null,
    usage: null,
    latencyMs: 0,
  };

  function buildContext(overrides: Partial<DecisionLedgerBuildContext> = {}): DecisionLedgerBuildContext {
    return {
      transport: 'cli', provider: 'claude', sessionId: 'sess-1', projectRoot: '/tmp/project-placeholder',
      now: () => FIXED_NOW, id: () => 'fixed-id', ...overrides,
    };
  }

  function stubResolveProvider(provider: string): () => Promise<ProviderResolution> {
    return async () => ({ provider, source: 'explicit', candidates: [provider], reason: 'test stub' });
  }

  function askOptions(projectRoot: string, overrides: Partial<RecordDecisionAskOptions> = {}): RecordDecisionAskOptions {
    return {
      transport: 'cli', projectRoot, env: {}, resolveProvider: stubResolveProvider('claude'),
      explicitSessionId: 'sess-1', now: () => FIXED_NOW, id: () => 'fixed-id', ...overrides,
    };
  }

  async function ledgerFileContent(projectRoot: string): Promise<string> {
    return readFile(path.join(projectRoot, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
  }

  function ledgerFilePath(projectRoot: string): string {
    return path.join(projectRoot, '.aiwg', 'decision', 'ledger.jsonl');
  }

  // ---------------------------------------------------------------------
  // Baseline acceptance criteria (#2946)
  // ---------------------------------------------------------------------

  it('appends exactly one ledger record per call, including fallback and not-configured outcomes', async () => {
    const projectRoot = await tempRoot();
    await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot));
    await recordDecisionAsk({ ...yesNoInput, question: 'Pick?' }, fallbackResult, askOptions(projectRoot));
    await recordDecisionAsk({ ...yesNoInput, question: 'Enabled?' }, notConfiguredResult, askOptions(projectRoot));

    const content = await ledgerFileContent(projectRoot);
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const records = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records.every(record => record.schema === DECISION_LEDGER_SCHEMA)).toBe(true);
    expect(records.map(record => record.status)).toEqual(['answered', 'fallback', 'fallback']);
    expect(records.map(record => record.fallbackReason)).toEqual([null, 'low-confidence', 'not-configured']);
  });

  it('carries provider, session id, digests, outcome, model, usage, latency and a savings estimate with its method', () => {
    const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext());
    expect(record).toMatchObject({
      schema: DECISION_LEDGER_SCHEMA, id: 'fixed-id', timestamp: new Date(FIXED_NOW).toISOString(),
      transport: 'cli', provider: 'claude', sessionId: 'sess-1', projectRoot: '/tmp/project-placeholder',
      decisionKind: 'yes-no', choiceIds: null, status: 'answered', answer: true, confidence: 0.93,
      threshold: 0.8, fallbackReason: null, model: 'jev-1.13.0', usage: { inputTokens: 12, outputTokens: 3 },
      latencyMs: 42, caller: null,
    });
    expect(record.questionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.contextDigest).toBeNull();
    expect(record.estimatedLlmTokensAvoided).toBeGreaterThan(0);
    expect(record.estimationMethod.length).toBeGreaterThan(0);
    expect(record).not.toHaveProperty('questionText');
    expect(record).not.toHaveProperty('contextText');
  });

  it('records choice ids for choices and scale decision kinds, and none for yes-no', () => {
    const choicesInput: DecisionAskInput = { question: 'Pick', mode: { kind: 'choices', choices: ['a=Alpha', 'b=Beta'] } };
    expect(buildDecisionLedgerRecord(choicesInput, { ...answeredResult, answer: 'b' }, buildContext()).choiceIds).toEqual(['a', 'b']);
    const scaleInput: DecisionAskInput = { question: 'Severity', mode: { kind: 'scale', low: 1, high: 5 } };
    expect(buildDecisionLedgerRecord(scaleInput, { ...answeredResult, answer: 3 }, buildContext()).choiceIds).toEqual(['1', '2', '3', '4', '5']);
    expect(buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext()).choiceIds).toBeNull();
  });

  it('estimates savings as negative Jev usage for a real fallback call, and zero when Jev was never called', () => {
    expect(buildDecisionLedgerRecord(yesNoInput, fallbackResult, buildContext()).estimatedLlmTokensAvoided).toBe(-(20 + 5));
    expect(buildDecisionLedgerRecord(yesNoInput, notConfiguredResult, buildContext()).estimatedLlmTokensAvoided).toBe(0);
  });

  it('never writes question/context text by default, and a secret-shaped context never reaches disk', async () => {
    const projectRoot = await tempRoot();
    const secretContext = 'password=hunter2VerySecretDoNotPersist';
    const input: DecisionAskInput = { question: 'Proceed with deploy?', mode: { kind: 'yes-no' }, context: secretContext };
    await recordDecisionAsk(input, answeredResult, askOptions(projectRoot));
    const content = await ledgerFileContent(projectRoot);
    expect(content).not.toContain(secretContext);
    expect(content).not.toContain('hunter2VerySecretDoNotPersist');
    const record = JSON.parse(content.trim()) as Record<string, unknown>;
    expect(record.questionText).toBeUndefined();
    expect(record.contextText).toBeUndefined();
  });

  it('records redacted text only when --record-text is passed, never the raw secret', async () => {
    const projectRoot = await tempRoot();
    const secretContext = 'Authorization: Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const input: DecisionAskInput = { question: 'Proceed?', mode: { kind: 'yes-no' }, context: secretContext };
    await recordDecisionAsk(input, answeredResult, askOptions(projectRoot, { recordText: true }));
    const content = await ledgerFileContent(projectRoot);
    expect(content).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    const record = JSON.parse(content.trim()) as Record<string, unknown>;
    expect(record.questionText).toBe('Proceed?');
    expect(record.contextText as string).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('history filters by since, provider, session, kind and status; stats groups offline', async () => {
    const projectRoot = await tempRoot();
    await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, { resolveProvider: stubResolveProvider('claude'), explicitSessionId: 'sess-a', caller: 'worker-a', now: () => Date.UTC(2026, 9, 1) }));
    await recordDecisionAsk({ ...yesNoInput, question: 'Pick?' }, fallbackResult, askOptions(projectRoot, { transport: 'mcp', resolveProvider: stubResolveProvider('codex'), explicitSessionId: 'sess-b', caller: 'worker-b', now: () => Date.UTC(2026, 9, 5) }));
    await recordDecisionAsk({ ...yesNoInput, question: 'Enabled?' }, notConfiguredResult, askOptions(projectRoot, { resolveProvider: stubResolveProvider('claude'), explicitSessionId: 'sess-a', caller: 'worker-a', now: () => Date.UTC(2026, 9, 8) }));

    expect((await decisionLedgerHistory(projectRoot, { provider: 'codex' })).count).toBe(1);
    expect((await decisionLedgerHistory(projectRoot, { sessionId: 'sess-a' })).count).toBe(2);
    expect((await decisionLedgerHistory(projectRoot, { kind: 'yes-no' })).count).toBe(3);
    expect((await decisionLedgerHistory(projectRoot, { status: 'fallback' })).count).toBe(2);
    expect((await decisionLedgerHistory(projectRoot, { since: new Date(Date.UTC(2026, 9, 6)) })).count).toBe(1);

    const statsByProvider = await decisionLedgerStats(projectRoot, { groupBy: 'provider' });
    const claudeGroup = statsByProvider.groups.find(group => group.key === 'claude')!;
    expect(claudeGroup.totalCalls).toBe(2);
    expect(claudeGroup.answered).toBe(1);
    expect(claudeGroup.fallback).toBe(1);
  });

  it('tolerates a missing ledger file entirely (no built-in retention; the file may be deleted at any time)', async () => {
    const projectRoot = await tempRoot();
    expect(await decisionLedgerHistory(projectRoot)).toEqual({ schema: 'aiwg-decision-ledger-history/v1', count: 0, skipped: 0, records: [] });
    const stats = await decisionLedgerStats(projectRoot);
    expect(stats.groups).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Review r2 item 1 / item 9 — secrets in metadata, including `model`.
  // ---------------------------------------------------------------------

  describe('review r2 item 1/9 — secrets in metadata', () => {
    const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    it('redacts a secret-shaped value in session, projectRoot, choice ids, answer, model and caller, not just opt-in text', () => {
      const choicesInput: DecisionAskInput = { question: 'Pick', mode: { kind: 'choices', choices: [SECRET, 'beta'] } };
      const result: DecisionAskResult = { ...answeredResult, answer: SECRET, model: SECRET };
      const record = buildDecisionLedgerRecord(choicesInput, result, buildContext({
        sessionId: SECRET, projectRoot: `/tmp/${SECRET}`, caller: 'worker-pick',
      }));
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(SECRET);
      expect(record.sessionId).not.toBe(SECRET);
      expect(record.projectRoot).not.toContain(SECRET);
      expect(record.answer).not.toBe(SECRET);
      expect(record.model).not.toBe(SECRET);
      expect(record.choiceIds?.[0]).not.toBe(SECRET);
    });

    it('caps the number of recorded choice ids regardless of how many the ask call itself allowed, and marks truncation', () => {
      const manyChoices = Array.from({ length: 200 }, (_, index) => `choice-${index}`);
      const record = buildDecisionLedgerRecord({ question: 'Pick', mode: { kind: 'choices', choices: manyChoices } }, { ...answeredResult, answer: 'choice-0' }, buildContext());
      expect(record.choiceIds).toHaveLength(MAX_RECORDED_CHOICE_IDS);
      expect(record.choiceCount).toBe(200);
      expect(record.choiceIdsTruncated).toBe(true);
    });

    it('exhaustively sweeps every string field of a record built from secret-shaped inputs (review r2 item 9)', () => {
      const SWEEP_SECRET = 'sk-SWEEPSECRET1234567890ABCDEFGHIJ';
      const input: DecisionAskInput = {
        question: SWEEP_SECRET,
        mode: { kind: 'choices', choices: [SWEEP_SECRET, `b=${SWEEP_SECRET}`] },
        context: SWEEP_SECRET,
      };
      const result: DecisionAskResult = { ...answeredResult, answer: SWEEP_SECRET, model: SWEEP_SECRET };
      const record = buildDecisionLedgerRecord(input, result, buildContext({
        provider: SWEEP_SECRET, sessionId: SWEEP_SECRET, projectRoot: `/tmp/${SWEEP_SECRET}`,
        caller: 'worker-pick', recordText: true,
      }));
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string') expect(value, `field "${key}" leaked the secret`).not.toContain(SWEEP_SECRET);
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (typeof entry === 'string') expect(entry, `array field "${key}" entry leaked the secret`).not.toContain(SWEEP_SECRET);
          }
        }
      }
    });
  });

  // ---------------------------------------------------------------------
  // Review r2 item 10 — decision identity (answerIndex/choiceCount).
  // ---------------------------------------------------------------------

  describe('review r2 item 10 — decision identity', () => {
    it('records answerIndex/choiceCount for a choices answer, surviving redaction of the id itself', () => {
      const SECRET_A = 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const SECRET_B = 'sk-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      const input: DecisionAskInput = { question: 'Pick', mode: { kind: 'choices', choices: [SECRET_A, SECRET_B] } };
      const record = buildDecisionLedgerRecord(input, { ...answeredResult, answer: SECRET_B }, buildContext());
      // Both redacted display ids collapse to the same marker shape, but answerIndex still
      // unambiguously names which option (index 1) was selected.
      expect(record.answerIndex).toBe(1);
      expect(record.choiceCount).toBe(2);
      expect(record.choiceIdsTruncated).toBe(false);
    });

    it('records answerIndex for a scale answer relative to low', () => {
      const input: DecisionAskInput = { question: 'Severity', mode: { kind: 'scale', low: 1, high: 5 } };
      const record = buildDecisionLedgerRecord(input, { ...answeredResult, answer: 4 }, buildContext());
      expect(record.answerIndex).toBe(3);
      expect(record.choiceCount).toBe(5);
    });

    it('records null answerIndex/choiceCount for yes-no', () => {
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext());
      expect(record.answerIndex).toBeNull();
      expect(record.choiceCount).toBeNull();
      expect(record.choiceIdsTruncated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // Review r2 item 11 — wider attribution charset covering documented forms.
  // ---------------------------------------------------------------------

  it('review r2 item 11 — the documented "address-issues:worker-pick" caller form is accepted', () => {
    expect(ATTRIBUTION_FIELD_PATTERN.test('address-issues:worker-pick')).toBe(true);
    expect(ATTRIBUTION_FIELD_PATTERN.test('flow/step@host')).toBe(true);
    expect(ATTRIBUTION_FIELD_PATTERN.test('has spaces')).toBe(false);
    expect(ATTRIBUTION_FIELD_PATTERN.test('')).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Review r2 item 2/4/5/7/8 — file safety, portable writer, no self-heal.
  // ---------------------------------------------------------------------

  describe('review r2 — portable file safety (no chmod self-heal, no /proc anchoring)', () => {
    it('creates a missing ledger file at mode 0600 (POSIX) and a private directory', async () => {
      const projectRoot = await tempRoot();
      await appendDecisionLedgerRecord(buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot })), { projectRoot });
      if (!IS_WINDOWS) {
        expect((await stat(path.join(projectRoot, '.aiwg', 'decision'))).mode & 0o777).toBe(0o700);
        expect((await stat(ledgerFilePath(projectRoot))).mode & 0o777).toBe(0o600);
      } else {
        await expect(stat(ledgerFilePath(projectRoot))).resolves.toBeDefined();
      }
    });

    it('skips (never follows) a symlinked ledger file, and never creates the symlink target', async () => {
      const projectRoot = await tempRoot();
      const outside = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      const victim = path.join(outside, 'victim.jsonl');
      await symlink(victim, ledgerFilePath(projectRoot));
      const warnings: string[] = [];
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const appended = await appendDecisionLedgerRecord(record, { projectRoot, warn: message => warnings.push(message) });
      expect(appended).toBe(false);
      expect(warnings).toHaveLength(1);
      await expect(readFile(victim, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('skips (never follows) a symlinked decision directory, and writes nothing through it', async () => {
      const projectRoot = await tempRoot();
      const outside = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg'), { recursive: true });
      await symlink(outside, path.join(projectRoot, '.aiwg', 'decision'));
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const appended = await appendDecisionLedgerRecord(record, { projectRoot });
      expect(appended).toBe(false);
      expect(await readdir(outside)).toHaveLength(0);
    });

    it('review r2 item 2 — skips a hard-linked ledger file and leaves it (and its link) completely untouched', async () => {
      const projectRoot = await tempRoot();
      const outsideFile = path.join(await tempRoot(), 'other-owned-file.txt');
      const originalContent = 'do not touch: this is a different file sharing an inode\n';
      await writeFile(outsideFile, originalContent, { mode: 0o664 });
      // The creation mode is filtered by the process umask, so compare against what was actually set.
      const originalMode = (await stat(outsideFile)).mode & 0o777;
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      // Hard-link an unrelated, loosely-permissioned file onto the ledger path — nlink becomes 2.
      await link(outsideFile, ledgerFilePath(projectRoot));
      const warnings: string[] = [];
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const appended = await appendDecisionLedgerRecord(record, { projectRoot, warn: message => warnings.push(message) });
      expect(appended).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/hard link/i);
      // Neither the content nor the mode of the shared inode changed — no chmod, no write.
      expect(await readFile(outsideFile, 'utf8')).toBe(originalContent);
      if (!IS_WINDOWS) expect((await stat(outsideFile)).mode & 0o777).toBe(originalMode);
    });

    it('review r2 item 2/4 — skips an existing loose-mode ledger file and leaves its mode unchanged (no self-heal)', async () => {
      if (IS_WINDOWS) return; // POSIX mode bits only
      const projectRoot = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      await writeFile(ledgerFilePath(projectRoot), '', { mode: 0o644 });
      await chmod(ledgerFilePath(projectRoot), 0o644); // explicit: creation modes are filtered by the umask
      const warnings: string[] = [];
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const appended = await appendDecisionLedgerRecord(record, { projectRoot, warn: message => warnings.push(message) });
      expect(appended).toBe(false);
      expect(warnings).toHaveLength(1);
      expect((await stat(ledgerFilePath(projectRoot))).mode & 0o777).toBe(0o644); // unchanged, not chmod'd to 0600
      expect(await readFile(ledgerFilePath(projectRoot), 'utf8')).toBe(''); // untouched
    });

    it('review r2 item 7 — a write loop handles a short write across multiple calls', async () => {
      const projectRoot = await tempRoot();
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const chunks: number[] = [];
      // Simulate the underlying write() delivering only a few bytes per call — the loop
      // must keep calling it (with the real handle) until the whole buffer lands.
      const partialWriteChunk = async (handle: FileHandle, buffer: Buffer): Promise<number> => {
        const size = Math.min(3, buffer.length);
        chunks.push(size);
        const { bytesWritten } = await handle.write(buffer.subarray(0, size));
        return bytesWritten;
      };
      const appended = await appendDecisionLedgerRecord(record, { projectRoot, writeChunk: partialWriteChunk });
      expect(appended).toBe(true);
      expect(chunks.length).toBeGreaterThan(1); // the loop really issued multiple small writes
      const content = await ledgerFileContent(projectRoot);
      expect(JSON.parse(content.trim())).toMatchObject({ id: record.id });
    });

    it('review r2 item 7 — a write that makes no progress is treated as a failure, not silent success', async () => {
      const projectRoot = await tempRoot();
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const warnings: string[] = [];
      const stuckWriteChunk = async () => 0;
      const appended = await appendDecisionLedgerRecord(record, { projectRoot, warn: message => warnings.push(message), writeChunk: stuckWriteChunk as never });
      expect(appended).toBe(false);
      expect(warnings).toHaveLength(1);
    });

    it('prepends a newline before appending when the ledger does not already end in one (read through a separate handle)', async () => {
      const projectRoot = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      await writeFile(ledgerFilePath(projectRoot), '{"partial": "a crash truncated the previous write before its trailing newline"', { mode: 0o600 });
      const record = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      expect(await appendDecisionLedgerRecord(record, { projectRoot })).toBe(true);
      const content = await readFile(ledgerFilePath(projectRoot), 'utf8');
      const lines = content.split('\n');
      expect(lines[0]).toContain('partial');
      const ourLine = lines.find(line => line.includes(DECISION_LEDGER_SCHEMA));
      expect(ourLine).toBeDefined();
      expect(JSON.parse(ourLine as string)).toMatchObject({ id: record.id });
    });
  });

  // ---------------------------------------------------------------------
  // Review r1 finding 3 — attribution resolution inside the boundary.
  // ---------------------------------------------------------------------

  it('review r1 finding 3 — resolves provider to "unknown" when detection throws, without affecting the call', async () => {
    const projectRoot = await tempRoot();
    const throwingResolver = async (): Promise<ProviderResolution> => { throw new Error('capability-matrix.yaml unavailable'); };
    const record = await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, { resolveProvider: throwingResolver }));
    expect(record).not.toBeNull();
    expect(record?.provider).toBe('unknown');
  });

  // ---------------------------------------------------------------------
  // Review r1/r2 — deadline, cancellation and warn safety.
  // ---------------------------------------------------------------------

  describe('deadline and warn safety', () => {
    it('bounds recording to timeoutMs, reports completion as unknown, and warns once', async () => {
      const projectRoot = await tempRoot();
      const warnings: string[] = [];
      const started = Date.now();
      const record = await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, {
        resolveProvider: () => new Promise<ProviderResolution>(() => {}),
        timeoutMs: 50,
        warn: message => warnings.push(message),
      }));
      expect(Date.now() - started).toBeLessThan(1000);
      expect(record).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/completion unknown/);
    });

    it('a throwing warn callback never escapes recordDecisionAsk and fires at most once', async () => {
      const projectRoot = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg'), { recursive: true });
      await writeFile(path.join(projectRoot, '.aiwg', 'decision'), 'not a directory');
      let calls = 0;
      const throwingWarn = (message: string) => { calls += 1; throw new Error(`warn callback itself is broken: ${message}`); };
      await expect(recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, { warn: throwingWarn }))).resolves.toBeNull();
      expect(calls).toBe(1);
    });

    it('review r2 item 8 — a stage still in flight when the deadline fires does not start the next stage', async () => {
      const projectRoot = await tempRoot();
      let resolverSettled = false;
      const slowResolver = async (): Promise<ProviderResolution> => {
        await new Promise(resolve => setTimeout(resolve, 80));
        resolverSettled = true;
        return { provider: 'claude', source: 'explicit', candidates: ['claude'], reason: 'slow' };
      };
      const warnings: string[] = [];
      const record = await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, {
        resolveProvider: slowResolver, timeoutMs: 20, warn: message => warnings.push(message),
      }));
      expect(record).toBeNull();
      expect(warnings[0]).toMatch(/completion unknown/);
      // Let the slow resolver actually settle in the background, well past the deadline.
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(resolverSettled).toBe(true);
      // Even though attribution eventually resolved, the next stage (building/appending the
      // record) never started once cancelled — no ledger file was ever created.
      await expect(readFile(ledgerFilePath(projectRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  // ---------------------------------------------------------------------
  // Review r1 finding 5 — record size cap / truncation.
  // ---------------------------------------------------------------------

  it('caps a full-size --record-text payload under the size ceiling and marks textTruncated', () => {
    const bigContext = 'x'.repeat(32 * 1024);
    const manyChoices = Array.from({ length: 255 }, (_, index) => `choice-id-${index}=${'z'.repeat(60)}`);
    const input: DecisionAskInput = { question: 'y'.repeat(200), mode: { kind: 'choices', choices: manyChoices }, context: bigContext };
    const record = buildDecisionLedgerRecord(input, { ...answeredResult, answer: 'choice-id-0' }, buildContext({ recordText: true }));
    expect(Buffer.byteLength(JSON.stringify(record), 'utf8')).toBeLessThanOrEqual(MAX_LEDGER_RECORD_BYTES);
    expect(record.textTruncated).toBe(true);
    expect(record.choiceIds).toHaveLength(MAX_RECORDED_CHOICE_IDS);
  });

  // ---------------------------------------------------------------------
  // Review r1 finding 6 — incremental aggregation at scale.
  // ---------------------------------------------------------------------

  it('aggregates confidence min/max incrementally without a RangeError on a large record set', async () => {
    const projectRoot = await tempRoot();
    const n = 20_000;
    const lines: string[] = [];
    for (let index = 0; index < n; index += 1) {
      lines.push(JSON.stringify(buildDecisionLedgerRecord(
        yesNoInput,
        { ...answeredResult, confidence: 0.5 + (index % 50) / 100 },
        buildContext({ id: () => `id-${index}`, now: () => FIXED_NOW + index }),
      )));
    }
    await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
    await writeFile(ledgerFilePath(projectRoot), `${lines.join('\n')}\n`, { mode: 0o600 });
    const stats = await decisionLedgerStats(projectRoot);
    expect(stats.groups[0].confidence.count).toBe(n);
    expect(stats.groups[0].confidence.max).toBeCloseTo(0.99, 5);
    expect(stats.groups[0].confidence.min).toBeCloseTo(0.5, 5);
  });

  // ---------------------------------------------------------------------
  // Review r1/r2 finding 7/10 — strict validation on read.
  // ---------------------------------------------------------------------

  describe('review r2 item 12 — strict read validation', () => {
    it('rejects a schema-only record, counts it skipped, and keeps aggregation finite', async () => {
      const projectRoot = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      const goodRecord = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const body = `${[JSON.stringify({ schema: DECISION_LEDGER_SCHEMA }), JSON.stringify(goodRecord)].join('\n')}\n`;
      await writeFile(ledgerFilePath(projectRoot), body, { mode: 0o600 });

      const history = await decisionLedgerHistory(projectRoot);
      expect(history.count).toBe(1);
      expect(history.skipped).toBe(1);
      expect(history.records[0].id).toBe(goodRecord.id);

      const stats = await decisionLedgerStats(projectRoot);
      expect(stats.skipped).toBe(1);
      expect(stats.groups[0].totalCalls).toBe(1);
      expect(Number.isFinite(stats.groups[0].estimatedLlmTokensAvoidedTotal)).toBe(true);
    });

    it('rejects a rolled-over calendar timestamp, out-of-range confidence/threshold and negative usage', async () => {
      const projectRoot = await tempRoot();
      await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
      const good = buildDecisionLedgerRecord(yesNoInput, answeredResult, buildContext({ projectRoot }));
      const badTimestamp = { ...good, id: 'bad-timestamp', timestamp: '2026-02-30T00:00:00.000Z' };
      const badConfidence = { ...good, id: 'bad-confidence', confidence: 3 };
      const badThreshold = { ...good, id: 'bad-threshold', threshold: -1 };
      const badUsage = { ...good, id: 'bad-usage', usage: { inputTokens: -100, outputTokens: 5 } };
      const body = `${[good, badTimestamp, badConfidence, badThreshold, badUsage].map(record => JSON.stringify(record)).join('\n')}\n`;
      await writeFile(ledgerFilePath(projectRoot), body, { mode: 0o600 });

      const history = await decisionLedgerHistory(projectRoot);
      expect(history.count).toBe(1);
      expect(history.records[0].id).toBe(good.id);
      expect(history.skipped).toBe(4);
    });
  });

  // ---------------------------------------------------------------------
  // Review r1 finding 8 — savings math and documented fallback rate.
  // ---------------------------------------------------------------------

  it('subtracts Jev usage exactly once and reports fallback rate as a documented fraction', async () => {
    const projectRoot = await tempRoot();
    const fallbackWithUsage: DecisionAskResult = { ...fallbackResult, usage: { inputTokens: 30, outputTokens: 20 } };
    await recordDecisionAsk(yesNoInput, fallbackWithUsage, askOptions(projectRoot, { now: () => FIXED_NOW }));
    await recordDecisionAsk({ ...yesNoInput, question: 'two' }, fallbackWithUsage, askOptions(projectRoot, { now: () => FIXED_NOW + 1 }));

    const group = (await decisionLedgerStats(projectRoot)).groups[0];
    expect(group.estimatedLlmTokensAvoidedTotal).toBe(-100);
    expect(group.netSavingsTokens).toBe(-100); // not -200: each fallback's own estimate already subtracted its usage once
    expect(group.fallbackRate).toBe(1);
    expect(group.fallbackCountByReason['low-confidence']).toBe(2);
    expect(group.fallbackRateByReason['low-confidence']).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Review r1/r2 finding 11 — strict ISO-8601 --since parsing.
  // ---------------------------------------------------------------------

  describe('parseDecisionLedgerSince', () => {
    it('rejects an invalid calendar date instead of rolling over', () => {
      expect(() => parseDecisionLedgerSince('2026-02-30')).toThrow(DecisionLedgerSinceError);
    });

    it('rejects a non-ISO date format', () => {
      expect(() => parseDecisionLedgerSince('10/01/2026')).toThrow(DecisionLedgerSinceError);
    });

    it('interprets a bare date as UTC midnight', () => {
      expect(parseDecisionLedgerSince('2026-10-01').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    });

    it('interprets an offsetless timestamp as UTC, independent of the process TZ', () => {
      const previousTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        expect(parseDecisionLedgerSince('2026-10-01T00:00:00').toISOString()).toBe('2026-10-01T00:00:00.000Z');
      } finally {
        if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
      }
    });

    it('honors an explicit offset when present', () => {
      expect(parseDecisionLedgerSince('2026-10-01T00:00:00-04:00').toISOString()).toBe('2026-10-01T04:00:00.000Z');
    });

    it('review r2 item 12 — rejects an invalid calendar date even with an explicit offset', () => {
      expect(() => parseDecisionLedgerSince('2026-02-30T00:00:00+01:00')).toThrow(DecisionLedgerSinceError);
    });
  });

  // ---------------------------------------------------------------------
  // Review r1 finding 12 — caller grouping: null distinct from "unattributed".
  // ---------------------------------------------------------------------

  it('keeps an absent caller distinct from a caller literally named "unattributed"', async () => {
    const projectRoot = await tempRoot();
    await recordDecisionAsk(yesNoInput, answeredResult, askOptions(projectRoot, { caller: null, now: () => FIXED_NOW }));
    await recordDecisionAsk({ ...yesNoInput, question: 'two' }, answeredResult, askOptions(projectRoot, { caller: 'unattributed', now: () => FIXED_NOW + 1 }));

    const stats = await decisionLedgerStats(projectRoot, { groupBy: 'caller' });
    expect(stats.groups).toHaveLength(2);
    const nullGroup = stats.groups.find(group => group.key === null);
    const namedGroup = stats.groups.find(group => group.key === 'unattributed');
    expect(nullGroup?.totalCalls).toBe(1);
    expect(namedGroup?.totalCalls).toBe(1);
    expect(JSON.stringify(stats)).toContain('"key":null');
  });

  it('resolves session id from --session, then AIWG_SESSION_ID, else the literal "unknown", rejecting a malformed value', () => {
    expect(resolveDecisionSessionId('explicit-session', { AIWG_SESSION_ID: 'env-session' })).toBe('explicit-session');
    expect(resolveDecisionSessionId(undefined, { AIWG_SESSION_ID: 'env-session' })).toBe('env-session');
    expect(resolveDecisionSessionId(undefined, {})).toBe('unknown');
    expect(resolveDecisionSessionId('has spaces', { AIWG_SESSION_ID: 'env-session' })).toBe('env-session');
    expect(resolveDecisionSessionId('has spaces', {})).toBe('unknown');
  });
});
