import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHandlerMap } from '../../../../src/cli/handlers/index.js';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';
import { acquireImportLease, GrokbotSessionAdapter, IncrementalSessionImporter, SessionRepository } from '../../../../src/sessions/index.js';
import {
  encodeGrokbotKey, grokbotTranscriptReplicaFilename,
} from '../../../../src/sessions/adapters/grokbot-locator.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { describeWithSqlite } from '../../../helpers/sqlite.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const grokbotNativeRoot = resolve('test/fixtures/sessions/grokbot/native');
const grokbotFixtureIds = JSON.parse(readFileSync(resolve(grokbotNativeRoot, 'fixture-ids.json'), 'utf8')) as {
  account: string;
  conversations: { complete: string };
  decoys: { composerDraftsKey: string };
};
const grokbotCompleteReplica = resolve(grokbotNativeRoot, grokbotTranscriptReplicaFilename(
  grokbotFixtureIds.account, grokbotFixtureIds.conversations.complete,
));

function context(args: string[], cwd = process.cwd()): HandlerContext {
  return { args, rawArgs: ['sessions', ...args], cwd, frameworkRoot: process.cwd() };
}

function jsonOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, any> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
}

describe('sessions CLI contracts', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers plural management without changing singular launcher routing', () => {
    const handlers = buildHandlerMap();
    expect(handlers.get('session')?.description).toContain('Start an agentic session');
    expect(handlers.get('sessions')).toBe(sessionsHandler);
  });

  it.each([
    { args: ['sources', '--json'], exitCode: 0 },
    { args: ['discover', '--json'], exitCode: 2 },
    { args: ['sources', '--limit', '--json'], exitCode: 2 },
    { args: ['--json'], exitCode: 2 },
    { args: ['--help', '--json'], exitCode: 0 },
  ])('waits for stdout before returning JSON for $args', async ({ args, exitCode }) => {
    let flush: (() => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((_chunk, callback: any) => {
      flush = callback;
      return false;
    });
    let completed = false;
    const pending = sessionsHandler.execute(context(args)).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(flush).toBeTypeOf('function'));
    expect(completed).toBe(false);
    flush!();
    expect((await pending).exitCode).toBe(exitCode);
    expect(completed).toBe(true);
    expect(jsonOutput(log).contractVersion).toBe('1.0.0');
  });

  it('waits for stdout when JSON help is called directly', async () => {
    let flush: (() => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((_chunk, callback: any) => {
      flush = callback;
      return false;
    });
    let completed = false;
    const pending = sessionsHandler.help!(context(['--help', '--json'])).then((result) => {
      completed = true;
      return result;
    });
    expect(completed).toBe(false);
    expect(flush).toBeTypeOf('function');
    flush!();
    expect((await pending).exitCode).toBe(0);
    expect(jsonOutput(log).command).toBe('sessions.help');
  });

  it('documents workspace selection, catalog overrides and native IDs in help', async () => {
    expect((await sessionsHandler.execute(context(['--help', '--json']))).exitCode).toBe(0);
    const usage = jsonOutput(log).data.usage;
    for (const command of ['list', 'show', 'timeline', 'search']) {
      expect(usage.split('\n').find((line: string) => line.trimStart().startsWith(`${command} `)))
        .toContain('--workspace <path-or-id>');
    }
    expect(usage).toContain('--db <path>');
    expect(usage).toContain('--max-record-bytes <n>');
    expect(usage).toContain('--max-source-bytes <n>');
    expect(usage).toContain('default 67108864');
    expect(usage).toContain('default 1073741824, 1 GiB; 0 unlimited');
    expect(usage).toContain('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES');
    expect(usage).toContain('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES');
    expect(usage).toContain('CLI flag > env var > workspace config > default');
    expect(usage).toContain('relative paths resolve from cwd');
    expect(usage).toContain('provider-native IDs');
    expect(usage).toContain('Imports for other workspaces stay in the selected catalog');
    expect(usage).toContain('reindex --workspace <path-or-id> | --all-workspaces');
    expect(usage).toContain('Reindex every workspace in the selected catalog');
  });

  it.each([
    ['--max-record-bytes', '0'], ['--max-record-bytes', '-1'],
    ['--max-source-bytes', '-1'], ['--max-source-bytes', '1.5'],
  ])('rejects invalid import byte limit %s %s before inspection', async (flag, value) => {
    const result = await sessionsHandler.execute(context([
      'import', '/missing/source.jsonl', '--source-id', 'synthetic', flag, value, '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(2);
    expect(jsonOutput(log).error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(jsonOutput(log).error.message).toContain('sessions.import.');
  });

  it('returns one explicit deterministic disposition for every canonical provider', async () => {
    const result = await sessionsHandler.execute(context(['sources', '--json']));
    const output = jsonOutput(log);
    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      contractVersion: '1.0.0',
      command: 'sessions.sources',
      status: 'ok',
      error: null,
      data: { count: 18 },
    });
    expect(output.data.providers.map((item: any) => item.provider))
      .toEqual([...output.data.providers.map((item: any) => item.provider)].sort());
    expect(output.data.providers.find((item: any) => item.provider === 'generic'))
      .toMatchObject({ disposition: 'manual-only', reasonCode: 'MANUAL_SOURCE_SELECTION_REQUIRED' });
    expect(output.data.providers.find((item: any) => item.provider === 'claude'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['jsonl', 'hook', 'manual-export'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'codex'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['api', 'jsonl'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'copilot'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['manual-export'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'grok-build'))
      .toMatchObject({
        disposition: 'implemented',
        reasonCode: 'CLI_EXPORT_REQUIRED',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['manual-export'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'cursor'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['api', 'jsonl', 'manual-export'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'factory'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['jsonl', 'api'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'hermes'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['jsonl', 'api', 'sqlite-snapshot'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'opencode'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['manual-export', 'api', 'jsonl'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'openclaw'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['api', 'sqlite-snapshot', 'jsonl'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'openhuman'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['jsonl'],
      });
    expect(output.data.providers.find((item: any) => item.provider === 'grokbot'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['manual-export', 'jsonl'],
        reasonCode: null,
      });
    expect(output.data.providers.find((item: any) => item.provider === 'muse'))
      .toMatchObject({
        disposition: 'implemented',
        supportedOperations: ['discover', 'inspect', 'stream'],
        acquisitionModes: ['manual-export', 'jsonl'],
        reasonCode: null,
      });
    expect(output.data.providers.find((item: any) => item.provider === 'pi'))
      .toMatchObject({ disposition: 'implemented', supportedOperations: ['discover', 'inspect', 'stream'], acquisitionModes: ['jsonl'] });
    expect(output.data.providers.find((item: any) => item.provider === 'warp'))
      .toMatchObject({
        disposition: 'manual-only',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['manual-export'],
        reasonCode: 'LOSSY_MARKDOWN_ONLY',
      });
    expect(output.data.providers.find((item: any) => item.provider === 'devin-desktop'))
      .toMatchObject({
        product: 'Devin Desktop',
        compatibilityAliases: ['windsurf'],
        disposition: 'implemented',
        supportedOperations: ['inspect', 'stream'],
        acquisitionModes: ['hook', 'jsonl'],
        evidence: {
          documentation: 'https://docs.devin.ai/desktop/cascade/hooks',
        },
      });
    expect(output.data.providers.filter((item: any) => item.disposition === 'unsupported'))
      .toHaveLength(0);
  });

  it('previews a current Devin Desktop transcript through the windsurf compatibility ID', async () => {
    const fixture = resolve('test/fixtures/sessions/windsurf/current.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'windsurf', '--source-id', 'source',
      '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      contractVersion: '1.0.0',
      command: 'sessions.import',
      status: 'preview',
      data: {
        source: {
          provider: 'devin-desktop',
          providerProfile: 'opt-in-cascade-transcript-hook',
          disposition: 'implemented',
          consistency: 'provisional',
          extensions: {
            'native.devin-desktop': {
              product: 'Devin Desktop',
              compatibilityProviderId: 'windsurf',
            },
          },
        },
      },
    });
  });

  it('previews a documented Claude transcript import without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/claude/active-session.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'claude', '--source-id', 'claude-active',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'claude',
          providerProfile: 'documented-local-jsonl',
          locatorClass: 'claude-transcript-jsonl',
          disposition: 'implemented',
          consistency: 'provisional',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a Codex App Server export without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/codex/threads.app-server.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'codex', '--source-id', 'codex-app',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'codex',
          providerProfile: 'app-server-v2-rollout-fallback',
          locatorClass: 'codex-app-server-jsonl',
          disposition: 'implemented',
          consistency: 'provisional',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a supported Copilot chat JSON export without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/copilot/complete.chat.json');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'copilot', '--source-id', 'copilot-export',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'copilot',
          providerProfile: 'vscode-chat-json-export',
          locatorClass: 'copilot-chat-json-export',
          disposition: 'implemented',
          consistency: 'provisional',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews each supported Cursor surface without persisting it', async () => {
    const cases = [
      ['cli-complete.jsonl', 'cli-stream-json', 'cursor-cli-stream-json', 'complete'],
      ['cloud-lifecycle.cloud.jsonl', 'cloud-agents-api-v1', 'cursor-cloud-events-jsonl', 'complete'],
      ['editor-export.md', 'editor-markdown-lossy', 'cursor-editor-markdown', 'complete'],
      [
        'agent-transcripts/agent-session/agent-session.jsonl',
        'agent-transcript-jsonl',
        'cursor-agent-transcript-jsonl',
        'provisional',
      ],
    ];
    for (const [name, providerProfile, locatorClass, consistency] of cases) {
      const fixture = resolve(`test/fixtures/sessions/cursor/${name}`);
      const result = await sessionsHandler.execute(context([
        'import', fixture, '--provider', 'cursor', '--source-id', `cursor-${name}`,
        '--workspace', 'workspace-fixture', '--dry-run', '--json',
      ]));
      expect(result.exitCode).toBe(0);
      expect(jsonOutput(log)).toMatchObject({
        status: 'preview',
        data: {
          source: {
            provider: 'cursor',
            providerProfile,
            locatorClass,
            disposition: 'implemented',
            consistency,
          },
          wouldInspect: true,
          wouldPersist: false,
        },
      });
    }
  });

  it('previews a documented Factory Droid transcript without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/factory/complete.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'factory', '--source-id', 'factory-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'factory',
          providerProfile: 'documented-project-jsonl',
          locatorClass: 'factory-droid-jsonl',
          disposition: 'implemented',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a native Hermes schema-23 export without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/hermes/complete.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'hermes', '--source-id', 'hermes-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'hermes',
          providerProfile: 'native-schema-23-export',
          locatorClass: 'hermes-export-jsonl',
          sourceSchemaVersion: '1.0.0',
          disposition: 'implemented',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews the current Hermes CLI JSONL representation without transformation', async () => {
    const fixture = resolve('test/fixtures/sessions/hermes/current-native.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'hermes', '--source-id', 'hermes-current-native',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'hermes',
          providerProfile: 'native-schema-23-export',
          locatorClass: 'hermes-export-jsonl',
          sourceSchemaVersion: '1.0.0',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a sanitized OpenCode JSON export without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/opencode/complete.json');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'opencode', '--source-id', 'opencode-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'opencode',
          providerProfile: 'sanitized-json-export',
          locatorClass: 'opencode-export-json',
          sourceSchemaVersion: '1.0.0',
          disposition: 'implemented',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews an OpenClaw schema-16/event-v3 consistent snapshot without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/openclaw/complete.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'openclaw', '--source-id', 'openclaw-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'openclaw',
          providerProfile: 'schema-16-event-v3-consistent-snapshot',
          locatorClass: 'openclaw-consistent-snapshot-jsonl',
          sourceSchemaVersion: '1.0.0',
          disposition: 'implemented',
          consistency: 'consistent-snapshot',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews an enriched OpenHuman schema-1 raw transcript without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/openhuman/complete.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'openhuman', '--source-id', 'openhuman-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'openhuman',
          providerProfile: 'schema-1-session-raw-enriched',
          locatorClass: 'openhuman-enriched-jsonl',
          sourceSchemaVersion: '1.0.0',
          disposition: 'implemented',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a manual lossy Warp Markdown export without persisting it', async () => {
    const fixture = resolve('test/fixtures/sessions/warp/complete.md');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'warp', '--source-id', 'warp-complete',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'warp',
          providerProfile: 'manual-lossy-markdown-export',
          locatorClass: 'warp-markdown-export',
          sourceSchemaVersion: '1.0.0',
          disposition: 'manual-only',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a Grok Bot manual-export interchange import without UNSUPPORTED_OPERATION', async () => {
    const fixture = resolve('test/fixtures/sessions/grokbot/valid-v1.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'grokbot', '--source-id', 'grokbot-fixture-v1',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'grokbot',
          providerProfile: 'manual-interchange',
          locatorClass: 'manual-export',
          adapterVersion: '1.0.0',
          sourceSchemaVersion: '1.0.0',
          disposition: 'manual-only',
          consistency: 'complete',
          extensions: { 'native.grokbot': {} },
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('previews a Grok Bot native transcript replica import', async () => {
    const result = await sessionsHandler.execute(context([
      'import', grokbotCompleteReplica, '--provider', 'grokbot', '--source-id', 'x',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'grokbot',
          providerProfile: 'grokbot-native-transcript-replica-v1',
          locatorClass: 'grokbot-native-transcript-replica',
          disposition: 'implemented',
          consistency: 'complete',
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });

  it('keeps a Grok Bot decoy blob on the manual-export path and rejects it', async () => {
    const inspect = vi.spyOn(GrokbotSessionAdapter.prototype, 'inspect');
    const fixture = resolve(grokbotNativeRoot, `${encodeGrokbotKey(grokbotFixtureIds.decoys.composerDraftsKey)}.blob`);
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'grokbot', '--source-id', 'decoy',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).not.toBe(0);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ locatorClass: 'manual-export' }));
    expect(jsonOutput(log)).toMatchObject({
      status: 'error',
      error: { code: 'MALFORMED_SOURCE' },
    });
  });

  it('reports the default workspace and warns when it differs from the declared one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = resolve('test/fixtures/sessions/grokbot/valid-v1.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'grokbot', '--source-id', 'grokbot-fixture-v1',
      '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    const output = jsonOutput(log);
    expect(output.data).toMatchObject({
      workspaceId: 'default',
      workspaceSource: 'default',
      declaredWorkspaceId: 'workspace-fixture',
    });
    expect(output.data.warnings).toEqual([
      expect.stringContaining('source declares workspace "workspace-fixture" but sessions are imported into "default" (no --workspace given)'),
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports an explicit workspace without a warning when it matches the declared one', async () => {
    const fixture = resolve('test/fixtures/sessions/generic/valid-v1.jsonl');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--source-id', 'generic-fixture-v1', '--workspace', 'workspace-fixture',
      '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      workspaceSource: 'argument',
      declaredWorkspaceId: 'workspace-fixture',
      warnings: [],
    });
  });

  it('previews a Muse Code export trajectory import without UNSUPPORTED_OPERATION', async () => {
    const fixture = resolve('test/fixtures/sessions/muse/valid-v1.json');
    const result = await sessionsHandler.execute(context([
      'import', fixture, '--provider', 'muse', '--source-id', 'muse-fixture-v1',
      '--workspace', 'workspace-fixture', '--dry-run', '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        source: {
          provider: 'muse',
          providerProfile: 'muse-export-trajectory-v1',
          locatorClass: 'manual-export',
          adapterVersion: '1.0.0',
          sourceSchemaVersion: '1.0.0',
          disposition: 'manual-only',
          consistency: 'complete',
          extensions: { 'native.muse': {} },
        },
        wouldInspect: true,
        wouldPersist: false,
      },
    });
  });
});

describeWithSqlite('sessions CLI catalog lifecycle', () => {
  let root: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-cli-'));
    // Project inference must not adopt real or sandbox-supplied ancestor
    // markers outside this test's temporary filesystem.
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const ancestorMarkers = new Set<string>();
    for (let ancestor = dirname(root);; ancestor = dirname(ancestor)) {
      ancestorMarkers.add(resolve(ancestor, '.git'));
      ancestorMarkers.add(resolve(ancestor, '.aiwg/aiwg.config'));
      if (dirname(ancestor) === ancestor) break;
    }
    vi.mocked(existsSync).mockImplementation((path) =>
      !ancestorMarkers.has(String(path)) && actual.existsSync(path));
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([
    ['max_record_bytes', '--max-record-bytes', '4096'],
    ['max_source_bytes', '--max-source-bytes', '0'],
  ])('applies workspace %s config to import inspection and lets its flag override it', async (setting, flag, value) => {
    const importer = vi.spyOn(IncrementalSessionImporter.prototype, 'import');
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { import: { [setting]: 1 } } }));
    const transcript = resolve(root, 'synthetic.jsonl');
    writeFileSync(transcript, JSON.stringify({
      type: 'user', uuid: 'event', sessionId: 'synthetic', cwd: root,
      message: { role: 'user', content: 'hello' },
    }) + '\n');
    const args = ['import', transcript, '--provider', 'claude', '--source-id', 'synthetic',
      '--workspace', root, '--db', resolve(root, 'catalog.sqlite'), '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).not.toBe(0);
    expect(jsonOutput(log).error).toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED', details: { setting: `sessions.import.${setting}`, configured: 1, origin: 'config' },
    });
    expect((await sessionsHandler.execute(context([...args, flag, value], root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.totals.eventsInserted).toBe(1);
    expect(importer).toHaveBeenCalledWith(expect.objectContaining({ limits: expect.objectContaining({
      [setting === 'max_record_bytes' ? 'maxRecordBytes' : 'maxTotalBytes']: Number(value),
    }) }));
  });

  it.each(['claude', 'codex'])('passes env limits to %s CLI readers and importer ahead of config', async provider => {
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { import: { max_record_bytes: 2, max_source_bytes: 1 } },
    }));
    const transcript = resolve(root, 'synthetic.jsonl');
    writeFileSync(transcript, JSON.stringify(provider === 'claude' ? {
      type: 'user', uuid: 'event', sessionId: 'synthetic', cwd: root,
      message: { role: 'user', content: 'hello' },
    } : { type: 'session_meta', payload: { id: 'synthetic', cwd: root } }) + '\n');
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', '1');
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '0');
    const args = ['import', transcript, '--provider', provider, '--source-id', 'synthetic',
      '--workspace', root, '--db', resolve(root, 'catalog.sqlite'), '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).not.toBe(0);
    expect(jsonOutput(log).error).toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', details: {
      setting: 'sessions.import.max_record_bytes', configured: 1, origin: 'env',
    } });
    const importer = vi.spyOn(IncrementalSessionImporter.prototype, 'import');
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES', 'invalid');
    expect((await sessionsHandler.execute(context([...args, '--max-record-bytes', '4096'], root))).exitCode).toBe(0);
    expect(importer).toHaveBeenCalledWith(expect.objectContaining({ limits: {
      maxRecordBytes: 4096, maxTotalBytes: 0,
      limitOrigins: { maxRecordBytes: 'flag', maxTotalBytes: 'env' },
    } }));
  });

  it('passes workspace config limits to the single CLI importer', async () => {
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({
      sessions: { import: { max_record_bytes: 4096, max_source_bytes: 8192 } },
    }));
    const transcript = resolve(root, 'synthetic.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic', cwd: root } }) + '\n');
    const importer = vi.spyOn(IncrementalSessionImporter.prototype, 'import');
    const args = ['import', transcript, '--provider', 'codex', '--source-id', 'synthetic',
      '--workspace', root, '--db', resolve(root, 'catalog.sqlite'), '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    expect(importer).toHaveBeenCalledWith(expect.objectContaining({ limits: {
      maxRecordBytes: 4096, maxTotalBytes: 8192,
      limitOrigins: { maxRecordBytes: 'config', maxTotalBytes: 'config' },
    } }));
  });

  it('adds config, env and repeated exclusion flags to discovered import and preview', async () => {
    const providerRoot = resolve(root, 'authorized');
    mkdirSync(providerRoot);
    const ids = ['config-id', 'env-id', 'flag-one', 'flag-two'];
    for (const id of ids) writeFileSync(resolve(providerRoot, `${id}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: { id, cwd: root },
    }) + '\n');
    const { discoverWorkspaceHistories, writeDiscoveryManifest } = await import('../../../../src/sessions/workspace-discovery.js');
    const manifest = await discoverWorkspaceHistories({
      workspace: root, expectedProviders: ['codex'], codexRoot: providerRoot,
    });
    const manifestPath = resolve(root, 'manifest.json');
    await writeDiscoveryManifest(manifestPath, manifest);
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { import: { exclude: ['config-id'] } } }));
    vi.stubEnv('AIWG_SESSIONS_IMPORT_EXCLUDE', 'env-id');
    for (const id of ids) rmSync(resolve(providerRoot, `${id}.jsonl`));
    const args = ['import-discovered', '--workspace', root, '--manifest', manifestPath,
      '--db', resolve(root, 'catalog.sqlite'), '--json', '--exclude', 'flag-one', '--exclude', 'flag-two'];
    expect((await sessionsHandler.execute(context([...args, '--dry-run'], root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.receipt.totals).toMatchObject({ excluded: 4, rejected: 0, pending: 0 });
    expect((await sessionsHandler.execute(context([...args, '--confirm'], root))).exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({ resumable: false,
      receipt: { run: { status: 'complete' }, totals: { excluded: 4, rejected: 0, pending: 0 } } });
    expect(jsonOutput(log).data.receipt.run.sources.map((source: any) => source.exclusion.entry).sort()).toEqual(ids.sort());
  });

  it('applies config and env exclusions to CLI discovery before reading sources', async () => {
    const providerRoot = resolve(root, 'authorized');
    mkdirSync(providerRoot);
    writeFileSync(resolve(providerRoot, 'config-id.jsonl'), 'invalid synthetic data');
    writeFileSync(resolve(providerRoot, 'env-id.jsonl'), 'invalid synthetic data');
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { import: { exclude: ['config-id'] } } }));
    vi.stubEnv('AIWG_SESSIONS_IMPORT_EXCLUDE', 'env-id');
    const args = ['discover', '--workspace', root, '--expected-providers', 'codex',
      '--codex-root', providerRoot, '--manifest', resolve(root, 'manifest.json'), '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.manifest.totals).toMatchObject({ sources: 2, excluded: 2 });
    expect(jsonOutput(log).data.manifest.sources.every((source: any) => source.status === 'excluded')).toBe(true);
  });

  it('uses a saved session_meta ID to exclude a renamed rollout before rediscovery reads', async () => {
    const providerRoot = resolve(root, 'authorized');
    mkdirSync(providerRoot);
    const locator = resolve(providerRoot, 'renamed.jsonl');
    writeFileSync(locator, JSON.stringify({ type: 'session_meta', payload: { id: 'metadata-id', cwd: root } }) + '\n');
    const args = ['discover', '--workspace', root, '--expected-providers', 'codex',
      '--codex-root', providerRoot, '--manifest', resolve(root, 'manifest.json'), '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { import: { exclude: ['metadata-id'] } } }));
    writeFileSync(locator, 'invalid synthetic data');
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.manifest).toMatchObject({ totals: { excluded: 1 }, sources: [{
      status: 'excluded', nativeSessionId: 'metadata-id', exclusion: { entry: 'metadata-id', kind: 'session-id' },
    }] });
  });

  it('threads config and flag source limits through discovered batch import', async () => {
    mkdirSync(resolve(root, '.aiwg'));
    writeFileSync(resolve(root, '.aiwg/aiwg.config'), JSON.stringify({ sessions: { import: { max_source_bytes: 1 } } }));
    const providerRoot = resolve(root, 'authorized');
    mkdirSync(providerRoot);
    writeFileSync(resolve(providerRoot, 'synthetic.jsonl'), JSON.stringify({
      type: 'user', uuid: 'event', sessionId: 'synthetic', cwd: root,
      message: { role: 'user', content: 'hello' },
    }) + '\n');
    const { discoverWorkspaceHistories, writeDiscoveryManifest } = await import('../../../../src/sessions/workspace-discovery.js');
    const manifest = await discoverWorkspaceHistories({
      workspace: root, expectedProviders: ['claude'], authorizedRoots: { claude: [providerRoot] },
    });
    const manifestPath = resolve(root, 'manifest.json');
    await writeDiscoveryManifest(manifestPath, manifest);
    const args = ['import-discovered', '--workspace', root, '--manifest', manifestPath,
      '--db', resolve(root, 'catalog.sqlite'), '--confirm', '--json'];
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.receipt.totals.rejected).toBe(1);
    expect(jsonOutput(log).data.receipt.run.sources[0].detail).toMatchObject({
      setting: 'sessions.import.max_source_bytes', configured: 1, origin: 'config',
    });
    vi.stubEnv('AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES', '2');
    expect((await sessionsHandler.execute(context(args, root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.receipt.run.sources[0].detail).toMatchObject({
      setting: 'sessions.import.max_source_bytes', configured: 2, origin: 'env',
    });
    expect((await sessionsHandler.execute(context([...args, '--max-source-bytes', '0'], root))).exitCode).toBe(0);
    expect(jsonOutput(log).data.receipt.totals.rejected).toBe(0);
    expect(jsonOutput(log).data.receipt.totals.accepted).toBe(1);
  });

  it('lists an imported provisional session as inactive after 24 hours without re-import', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-18T12:00:00.000Z');
    vi.setSystemTime(now);
    try {
      const transcript = resolve(root, 'active.jsonl');
      writeFileSync(transcript, JSON.stringify({
        type: 'user', uuid: 'event-active', sessionId: 'session-active', cwd: root,
        timestamp: now.toISOString(),
        message: { role: 'user', content: 'Synthetic request.' },
      }) + '\n');
      const scope = ['--workspace', root, '--db', resolve(root, 'catalog.sqlite'), '--json'];
      expect((await sessionsHandler.execute(context([
        'import', transcript, '--provider', 'claude', '--source-id', 'active-source', ...scope,
      ], root))).exitCode).toBe(0);
      expect((await sessionsHandler.execute(context(['list', ...scope], root))).exitCode).toBe(0);
      expect(jsonOutput(log).data.items).toMatchObject([{
        nativeSessionId: 'session-active', lifecycle: 'active',
      }]);

      vi.setSystemTime(now.getTime() + 24 * 60 * 60 * 1_000 + 1);
      expect((await sessionsHandler.execute(context(['list', ...scope], root))).exitCode).toBe(0);
      expect(jsonOutput(log).data.items).toMatchObject([{
        nativeSessionId: 'session-active', lifecycle: 'inactive',
        extensions: {
          'native.claude': {
            lifecycleEvidence: { basis: 'inactivity-threshold', state: 'inactive' },
          },
        },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  async function importOtherWorkspace(nativeId = '00000000-0000-4000-8000-000000002820') {
    const project = resolve(root, 'project');
    const other = resolve(root, 'other');
    const home = resolve(root, 'provider-home');
    const manifest = resolve(root, 'discovery.json');
    const database = resolve(project, '.aiwg/sessions/catalog.sqlite');
    mkdirSync(resolve(project, '.aiwg'), { recursive: true });
    writeFileSync(resolve(project, '.aiwg/aiwg.config'), '{}\n');
    mkdirSync(other);
    const providerDirectory = resolve(home, '.claude/projects', other.replace(/[/:]+/g, '-'));
    mkdirSync(providerDirectory, { recursive: true });
    for (const id of [nativeId, `${nativeId}-child`]) {
      writeFileSync(resolve(providerDirectory, `${id}.jsonl`), JSON.stringify({
        type: 'user', uuid: `event-${id}`, sessionId: id, cwd: other,
        timestamp: '2026-10-01T10:00:00.000Z',
        message: { role: 'user', content: 'Synthetic recovery transcript.' },
      }) + '\n');
    }
    expect((await sessionsHandler.execute(context([
      'import', resolve('test/fixtures/sessions/generic/valid-v1.jsonl'),
      '--source-id', 'generic-fixture-v1', '--workspace', project, '--json',
    ], project))).exitCode).toBe(0);
    expect((await sessionsHandler.execute(context([
      'discover', '--workspace', other, '--provider-home', home,
      '--expected-providers', 'claude', '--manifest', manifest, '--json',
    ], project))).exitCode).toBe(0);
    expect((await sessionsHandler.execute(context([
      'import-discovered', '--workspace', other, '--manifest', manifest, '--confirm', '--json',
    ], project))).exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      receipt: { totals: { accepted: 2, sessionsAccepted: 2 } },
      catalog: { database, workspaceId: other, hint: expect.stringContaining('--db') },
    });
    return { project, other, database, nativeId };
  }

  it.each([false, true])('reindexes the selected catalog with allWorkspaces=%s and reports its scopes', async (allWorkspaces) => {
    const { project, other, database } = await importOtherWorkspace();
    const reindex = vi.spyOn(SessionRepository.prototype, 'reindex');
    const scope = allWorkspaces ? ['--all-workspaces'] : ['--workspace', project];
    // A host maintenance invocation can select a catalog from an unrelated cwd.
    expect((await sessionsHandler.execute(context([
      'reindex', ...scope, '--db', database, '--json',
    ], root))).exitCode).toBe(0);
    expect(reindex).toHaveBeenCalledExactlyOnceWith(allWorkspaces ? undefined : project);
    expect(jsonOutput(log)).toMatchObject({
      command: 'sessions.reindex', status: 'ok', error: null,
      data: {
        operation: 'reindex', allWorkspaces,
        workspaceIds: allWorkspaces ? [other, project].sort() : [project],
      },
    });
  });

  it.each([false, true])('previews reindex scopes without rebuilding with allWorkspaces=%s', async (allWorkspaces) => {
    const { project, other, database } = await importOtherWorkspace();
    const reindex = vi.spyOn(SessionRepository.prototype, 'reindex');
    const scope = allWorkspaces ? ['--all-workspaces'] : ['--workspace', project];
    expect((await sessionsHandler.execute(context([
      'reindex', ...scope, '--db', database, '--dry-run', '--json',
    ], root))).exitCode).toBe(0);
    expect(reindex).not.toHaveBeenCalled();
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        operation: 'reindex', allWorkspaces,
        workspaceIds: allWorkspaces ? [other, project].sort() : [project],
      },
    });
  });

  it('rejects conflicting reindex scopes without rebuilding', async () => {
    const { project, database } = await importOtherWorkspace();
    const reindex = vi.spyOn(SessionRepository.prototype, 'reindex');
    expect((await sessionsHandler.execute(context([
      'reindex', '--all-workspaces', '--workspace', project, '--db', database, '--json',
    ], root))).exitCode).toBe(2);
    expect(jsonOutput(log).error).toMatchObject({
      code: 'INVALID_ARGUMENT', message: '--all-workspaces cannot be combined with --workspace',
    });
    expect(reindex).not.toHaveBeenCalled();
  });

  it('reports no workspace scopes when reindexing an empty catalog', async () => {
    const reindex = vi.spyOn(SessionRepository.prototype, 'reindex');
    expect((await sessionsHandler.execute(context([
      'reindex', '--all-workspaces', '--db', resolve(root, 'empty.sqlite'), '--json',
    ], root))).exitCode).toBe(0);
    expect(reindex).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok', data: { operation: 'reindex', allWorkspaces: true, workspaceIds: [] },
    });
  });

  it('finds outside-workspace discovered imports from both cwds and reports scoped-out counts', async () => {
    const { project, other, database, nativeId } = await importOtherWorkspace();
    expect((await sessionsHandler.execute(context(['list', '--limit', '1', '--json'], project))).exitCode).toBe(0);
    const defaultList = jsonOutput(log).data;
    expect(defaultList.page.total).toBe(1);
    expect(defaultList.coverage.catalogScope).toMatchObject({
      database, workspaceId: project, total: 3,
      otherWorkspaces: [{ workspaceId: other, count: 2 }],
      hint: expect.stringContaining('--workspace'),
    });
    await sessionsHandler.execute(context(['list'], project));
    const textList = String(log.mock.calls.at(-1)?.[0]);
    expect(textList).toContain(other);
    expect(textList).toContain('2 sessions');
    expect(textList).toContain('--workspace');
    expect((await sessionsHandler.execute(context(['show', nativeId, '--json'], project))).exitCode).toBe(0);
    expect(jsonOutput(log).data.session.workspaceId).toBe(other);
    await sessionsHandler.execute(context(['show', 'missing-native-id', '--json'], project));
    expect(jsonOutput(log).error).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { catalogScope: { otherWorkspaces: [{ workspaceId: other, count: 2 }] } },
    });
    expect(jsonOutput(log).error.message).toContain('--workspace');

    let internalId = '';
    for (const cwd of [project, other]) {
      // --db from the non-project cwd must read the importing project's catalog.
      const scope = cwd === project ? ['--workspace', other] : ['--db', database];
      expect((await sessionsHandler.execute(context(['list', '--limit', '1', ...scope, '--json'], cwd))).exitCode).toBe(0);
      const listed = jsonOutput(log).data;
      expect(listed.page.total).toBe(2);
      expect(listed.items).toHaveLength(1);
      expect(listed.coverage.catalogScope.otherWorkspaces).toEqual([{ workspaceId: project, count: 1 }]);
      expect((await sessionsHandler.execute(context(['show', nativeId, ...scope, '--json'], cwd))).exitCode).toBe(0);
      const shown = jsonOutput(log).data;
      expect(shown.session).toMatchObject({ nativeSessionId: nativeId, workspaceId: other });
      expect(shown.events).toHaveLength(1);
      if (internalId) expect(shown.session.sessionId).toBe(internalId);
      internalId = shown.session.sessionId;
      expect((await sessionsHandler.execute(context(['timeline', ...scope, '--json'], cwd))).exitCode).toBe(0);
      expect(jsonOutput(log).data.items).toHaveLength(2);
      expect((await sessionsHandler.execute(context(['search', 'recovery', ...scope, '--json'], cwd))).exitCode).toBe(0);
      expect(jsonOutput(log).data.items).toHaveLength(2);
    }
  });

  it('resolves relative --db and canonical cwd without a project instead of choosing another workspace', async () => {
    const { other, database, nativeId } = await importOtherWorkspace();
    expect((await sessionsHandler.execute(context([
      'list', '--db', '../project/.aiwg/sessions/catalog.sqlite', '--json',
    ], other))).exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      page: { total: 2 }, coverage: { workspaceId: other, catalogScope: { database } },
    });
    const alias = resolve(root, 'other-alias');
    symlinkSync(other, alias, 'dir');
    expect((await sessionsHandler.execute(context(['show', nativeId, '--db', database, '--json'], alias))).exitCode).toBe(0);
    expect(jsonOutput(log).data.session.workspaceId).toBe(other);

    expect((await sessionsHandler.execute(context([
      'import', resolve('test/fixtures/sessions/claude/active-session.jsonl'),
      '--provider', 'claude', '--source-id', 'local-other', '--workspace', other, '--json',
    ], other))).exitCode).toBe(0);
    expect((await sessionsHandler.execute(context(['list', '--json'], alias))).exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      page: { total: 1 },
      coverage: { catalogScope: { database: resolve(other, '.aiwg/sessions/catalog.sqlite') } },
    });
  });

  it('reproduces issue 2820 reads, including no-project list before and after --db', async () => {
    // The helper performs discover and import-discovered from the importing
    // project with --workspace pointing outside it, using only temporary data.
    const { project, other, database, nativeId } = await importOtherWorkspace();
    expect((await sessionsHandler.execute(context(['list', '--limit', '100', '--json'], project))).exitCode).toBe(0);
    const original = jsonOutput(log).data;
    expect(original.page.total).toBe(1);
    expect(original.coverage.catalogScope.otherWorkspaces).toEqual([{ workspaceId: other, count: 2 }]);
    // Reindex is an existing mutation: unlike reads, it requires --workspace.
    expect((await sessionsHandler.execute(context(['reindex', '--json'], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error.code).toBe('MISSING_ARGUMENT');
    expect((await sessionsHandler.execute(context(['reindex', '--workspace', project, '--json'], project))).exitCode).toBe(0);
    await sessionsHandler.execute(context(['list', '--limit', '100', '--json'], project));
    expect(jsonOutput(log).data.items).toEqual(original.items);
    expect(jsonOutput(log).data.page.total).toBe(1);
    await sessionsHandler.execute(context(['list', '--limit', '1', '--workspace', other, '--json'], project));
    expect(jsonOutput(log).data.page.total).toBe(2);

    // With no project there is a separate empty cwd catalog. --db is necessary
    // to reach the original catalog, and matching cwd now selects its rows.
    expect((await sessionsHandler.execute(context(['list', '--limit', '1', '--json'], other))).exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      page: { total: 0 },
      coverage: { catalogScope: { database: resolve(other, '.aiwg/sessions/catalog.sqlite') } },
    });
    expect((await sessionsHandler.execute(context(['list', '--limit', '1', '--db', database, '--json'], other))).exitCode).toBe(0);
    expect(jsonOutput(log).data.page.total).toBe(2);
    expect((await sessionsHandler.execute(context(['show', nativeId, '--json'], project))).exitCode).toBe(0);
    const parent = jsonOutput(log).data.session.sessionId;
    expect((await sessionsHandler.execute(context(['show', nativeId, '--db', database, '--json'], other))).exitCode).toBe(0);
    expect(jsonOutput(log).data.session.sessionId).toBe(parent);
  });

  it.each(['00000000-0000-4000-8000-000000002820', 'session_native-2820'])(
    'lists every native-ID candidate across workspaces and providers in JSON and text errors (%s)', async (reference) => {
    const { project, other, database, nativeId } = await importOtherWorkspace(reference);
    const sameId = resolve(root, `${nativeId}.jsonl`);
    writeFileSync(sameId, JSON.stringify({
      type: 'user', uuid: 'other-parent', sessionId: nativeId,
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: 'Another workspace parent.' },
    }) + '\n');
    expect((await sessionsHandler.execute(context([
      'import', sameId, '--provider', 'claude', '--source-id', 'other-parent',
      '--workspace', project, '--json',
    ], project))).exitCode).toBe(0);
    expect((await sessionsHandler.execute(context(['show', nativeId, '--json'], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      details: { candidates: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', workspaceId: project }),
        expect.objectContaining({ provider: 'claude', workspaceId: other }),
      ]) },
    });
    // Explicit workspace selection resolves the cross-workspace collision.
    expect((await sessionsHandler.execute(context(['show', nativeId, '--workspace', other, '--json'], project))).exitCode).toBe(0);
    const generic = resolve(root, 'same-id-generic.jsonl');
    writeFileSync(generic, readFileSync(resolve('test/fixtures/sessions/generic/valid-v1.jsonl'), 'utf8')
      .replaceAll('session-1', nativeId).replaceAll('generic-fixture-v1', 'other-provider'));
    expect((await sessionsHandler.execute(context([
      'import', generic, '--source-id', 'other-provider', '--workspace', other, '--json',
    ], project))).exitCode).toBe(0);
    expect((await sessionsHandler.execute(context(['show', nativeId, '--json'], project))).exitCode).toBe(2);
    const candidates = jsonOutput(log).error.details.candidates;
    expect(candidates).toHaveLength(3);
    expect((await sessionsHandler.execute(context(['show', nativeId.slice(0, -1), '--json'], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error.code).toBe('SESSION_AMBIGUOUS');
    expect(new Set(candidates.map((candidate: any) => candidate.provider))).toEqual(new Set(['claude', 'generic']));
    expect((await sessionsHandler.execute(context(['show', nativeId, '--workspace', other, '--json'], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error.details.candidates).toHaveLength(2);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await sessionsHandler.execute(context(['show', nativeId, '--db', database], other))).exitCode).toBe(2);
    const message = String(error.mock.calls.at(-1)?.[0]);
    expect(message).toContain('SESSION_AMBIGUOUS');
    for (const candidate of candidates) {
      expect(message).toContain(candidate.sessionId);
      expect(message).toContain(candidate.provider);
      expect(message).toContain(candidate.workspaceId);
      expect((await sessionsHandler.execute(context([
        'show', candidate.sessionId, '--workspace', candidate.workspaceId, '--db', database, '--json',
      ], other))).exitCode).toBe(0);
    }
  });

  it('resolves native IDs and unique prefixes with events and tags, and rejects ambiguous references', async () => {
    const { project, other, database, nativeId } = await importOtherWorkspace();
    const scope = ['--workspace', other, '--db', database, '--json'];
    await sessionsHandler.execute(context(['show', nativeId, ...scope], project));
    const internalId = jsonOutput(log).data.session.sessionId;
    expect((await sessionsHandler.execute(context(['tag', internalId, 'recovered', ...scope], project))).exitCode).toBe(0);
    for (const reference of [nativeId, `${nativeId}-c`, internalId]) {
      expect((await sessionsHandler.execute(context(['show', reference, ...scope], project))).exitCode).toBe(0);
      const shown = jsonOutput(log).data;
      expect(shown.events).toHaveLength(1);
      expect(shown.session.nativeSessionId).toBe(reference === `${nativeId}-c` ? `${nativeId}-child` : nativeId);
      if (reference !== `${nativeId}-c`) expect(shown.tags).toEqual(['recovered']);
    }
    expect((await sessionsHandler.execute(context(['show', nativeId.slice(0, -1), ...scope], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error.code).toBe('SESSION_AMBIGUOUS');
    expect((await sessionsHandler.execute(context(['show', '%', ...scope], project))).exitCode).toBe(4);
    expect(jsonOutput(log).error.code).toBe('SESSION_NOT_FOUND');

    // A native ID duplicated across sources must not silently pick one record.
    for (const source of ['duplicate-a', 'duplicate-b']) {
      expect((await sessionsHandler.execute(context([
        'import', resolve('test/fixtures/sessions/claude/active-session.jsonl'),
        '--provider', 'claude', '--source-id', source, ...scope,
      ], project))).exitCode).toBe(0);
    }
    expect((await sessionsHandler.execute(context(['show', 'active-session', ...scope], project))).exitCode).toBe(2);
    expect(jsonOutput(log).error.code).toBe('SESSION_AMBIGUOUS');
    for (const candidate of jsonOutput(log).error.details.candidates) {
      expect((await sessionsHandler.execute(context(['delete', candidate.sessionId, '--confirm', ...scope], project))).exitCode).toBe(0);
    }
    await sessionsHandler.execute(context(['list', ...scope], project));
    expect(jsonOutput(log).data.coverage.catalogScope.total).toBe(3);
    expect((await sessionsHandler.execute(context(['show', 'active-session', ...scope], project))).exitCode).toBe(4);
  });

  it('resolves the parent native ID when subagent artifacts repeat it', async () => {
    const { project, other, database, nativeId } = await importOtherWorkspace();
    const scope = ['--workspace', other, '--db', database, '--json'];
    await sessionsHandler.execute(context(['show', nativeId, ...scope], project));
    const parentId = jsonOutput(log).data.session.sessionId;
    const subagent = resolve(root, 'agent-synthetic.jsonl');
    writeFileSync(subagent, JSON.stringify({
      type: 'user', uuid: 'subagent-event', sessionId: nativeId,
      isSidechain: true, agentId: 'agent-synthetic',
      timestamp: '2026-10-01T10:00:01.000Z',
      message: { role: 'user', content: 'Synthetic subagent transcript.' },
    }) + '\n');
    expect((await sessionsHandler.execute(context([
      'import', subagent, '--provider', 'claude', '--source-id', 'subagent', ...scope,
    ], project))).exitCode).toBe(0);
    await sessionsHandler.execute(context(['list', ...scope], project));
    const subagentId = jsonOutput(log).data.items.find((session: any) => session.sourceId === 'subagent').sessionId;
    await sessionsHandler.execute(context(['show', subagentId, ...scope], project));
    expect(jsonOutput(log).data.events[0].extensions['native.claude'].transcriptFamily)
      .toMatchObject({ sourceArtifactSessionId: '[REDACTED:content]', subagent: true });
    expect((await sessionsHandler.execute(context(['show', nativeId, ...scope], project))).exitCode).toBe(0);
    expect(jsonOutput(log).data.session.sessionId).toBe(parentId);
    expect(jsonOutput(log).data.events).toHaveLength(1);
  });

  it('imports a Grok Bot native transcript replica into the catalog', async () => {
    const dbArgs = [
      '--db', resolve(root, 'grokbot.sqlite'),
      '--workspace', 'workspace-fixture', '--json',
    ];
    const result = await sessionsHandler.execute(context([
      'import', grokbotCompleteReplica, '--provider', 'grokbot', '--source-id', 'x', ...dbArgs,
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { totals: { sessionsInserted: 1, eventsInserted: 13 } },
    });

    expect((await sessionsHandler.execute(context(['list', ...dbArgs]))).exitCode).toBe(0);
    const listed = jsonOutput(log);
    expect(listed.data.page.total).toBe(1);
    expect(listed.data.items[0]).toMatchObject({ provider: 'grokbot', workspaceId: 'workspace-fixture' });
    expect((await sessionsHandler.execute(context(['show', listed.data.items[0].sessionId, ...dbArgs]))).exitCode).toBe(0);
    expect(jsonOutput(log).data.events).toHaveLength(13);
  });

  it('infers the canonical current workspace for catalog reads', async () => {
    const result = await sessionsHandler.execute(context([
      'list', '--db', resolve(root, 'catalog.sqlite'), '--json',
    ]));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        coverage: {
          status: 'unknown',
          workspaceId: realpathSync(process.cwd()),
        },
      },
    });
  });

  it('does not cross a repository boundary to adopt an ancestor workspace', async () => {
    const ancestor = resolve(root, 'ancestor');
    const workspace = resolve(ancestor, 'project');
    mkdirSync(resolve(ancestor, '.aiwg'), { recursive: true });
    writeFileSync(resolve(ancestor, '.aiwg', 'aiwg.config'), '{}\n');
    mkdirSync(resolve(workspace, '.git'), { recursive: true });

    const result = await sessionsHandler.execute(context([
      'list', '--db', resolve(root, 'catalog.sqlite'), '--json',
    ], workspace));
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        coverage: {
          status: 'unknown',
          workspaceId: realpathSync(workspace),
        },
      },
    });
  });

  it('uses one canonical workspace identity across symlink and real paths', async () => {
    const workspace = resolve(root, 'workspace');
    const alias = resolve(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, 'dir');
    const database = resolve(root, 'canonical.sqlite');
    const fixture = resolve('test/fixtures/sessions/claude/active-session.jsonl');

    const imported = await sessionsHandler.execute(context([
      'import',
      fixture,
      '--provider',
      'claude',
      '--source-id',
      'canonical-workspace-source',
      '--workspace',
      alias,
      '--db',
      database,
      '--json',
    ]));
    expect(imported.exitCode).toBe(0);

    const listed = await sessionsHandler.execute(context([
      'list',
      '--workspace',
      workspace,
      '--db',
      database,
      '--json',
    ]));
    expect(listed.exitCode).toBe(0);
    expect(jsonOutput(log).data).toMatchObject({
      page: { total: 1 },
      coverage: { workspaceId: realpathSync(workspace) },
    });
  });

  it('fails safely when a non-project catalog has multiple workspace candidates', async () => {
    const isolated = mkdtempSync(resolve(tmpdir(), 'aiwg-sessions-ambiguous-'));
    try {
      const fixture = resolve('test/fixtures/sessions/claude/active-session.jsonl');
      const database = resolve(isolated, 'ambiguous.sqlite');
      for (const workspace of ['workspace-a', 'workspace-b']) {
        await sessionsHandler.execute(context([
          'import',
          fixture,
          '--provider',
          'claude',
          '--source-id',
          `source-${workspace}`,
          '--workspace',
          workspace,
          '--db',
          database,
          '--json',
        ], isolated));
      }
      const result = await sessionsHandler.execute(context([
        'list', '--db', database, '--json',
      ], isolated));
      expect(result.exitCode).toBe(2);
      expect(jsonOutput(log).error).toMatchObject({
        code: 'WORKSPACE_AMBIGUOUS',
        details: {
          candidates: ['workspace-a', 'workspace-b'],
          example: expect.stringContaining('--workspace'),
        },
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('returns a distinct structured error when another importer owns the lease', async () => {
    const database = resolve(root, 'locked.sqlite');
    const lease = await acquireImportLease(database, 'owning-run');
    try {
      const result = await sessionsHandler.execute(context([
        'import',
        resolve('test/fixtures/sessions/generic/valid-v1.jsonl'),
        '--source-id',
        'generic-fixture-v1',
        '--workspace',
        'workspace-fixture',
        '--db',
        database,
        '--lock-wait-ms',
        '0',
        '--json',
      ]));
      expect(result.exitCode).toBe(7);
      expect(jsonOutput(log).error).toMatchObject({
        code: 'IMPORT_LOCKED',
        details: {
          owner: {
            runId: 'owning-run',
            pid: process.pid,
          },
          waitedMs: 0,
        },
      });
    } finally {
      await lease.release();
    }
  });

  it('records orphaned batch recovery on a single-source import and leaves previews read-only', async () => {
    const database = resolve(root, 'orphaned-batch.sqlite');
    const timestamp = '2026-10-01T00:00:00.000Z';
    const repository = new SessionRepository(database);
    try {
      repository.saveBatchImportRun({
        schemaVersion: '1.0.0', runId: 'orphan', manifestId: 'manifest',
        manifestCreatedAt: timestamp, workspaceId: 'workspace-fixture', status: 'running',
        startedAt: timestamp, updatedAt: timestamp, completedAt: null,
        providers: [], sources: [],
      });
      const args = ['import', resolve('test/fixtures/sessions/generic/valid-v1.jsonl'),
        '--source-id', 'generic-fixture-v1', '--workspace', 'workspace-fixture',
        '--db', database, '--json'];
      expect((await sessionsHandler.execute(context([...args, '--dry-run']))).exitCode).toBe(0);
      expect(repository.getBatchImportRun('orphan')?.status).toBe('running');
      expect((await sessionsHandler.execute(context(args))).exitCode).toBe(0);
      const interruptedRuns = jsonOutput(log).data.interruptedRuns;
      expect(interruptedRuns).toEqual([{ runId: 'orphan', interruptedAt: expect.any(String) }]);
      expect(repository.getBatchImportRun('orphan')).toMatchObject({
        status: 'interrupted', updatedAt: interruptedRuns[0].interruptedAt,
        interruptedAt: interruptedRuns[0].interruptedAt, completedAt: null,
      });
    } finally {
      repository.close();
    }
  });

  it('imports, paginates, shows, tags, relocates, reindexes, previews deletion, and diagnoses', async () => {
    const fixture = resolve('test/fixtures/sessions/generic/valid-v1.jsonl');
    const dbArgs = [
      '--db', resolve(root, 'catalog.sqlite'),
      '--workspace', 'workspace-fixture',
      '--json',
    ];

    expect((await sessionsHandler.execute(context([
      'import', fixture, '--source-id', 'generic-fixture-v1', '--workspace', 'workspace-fixture',
      ...dbArgs,
    ]))).exitCode).toBe(0);
    const importOutput = jsonOutput(log);
    expect(importOutput.data.totals).toEqual({ sessionsInserted: 1, eventsInserted: 2 });

    await sessionsHandler.execute(context(['list', '--limit', '1', ...dbArgs]));
    const list = jsonOutput(log);
    expect(list.data.page).toMatchObject({
      limit: 1, cursor: null, total: 1, nextCursor: null,
      snapshotRowid: expect.any(Number),
    });
    const sessionId = list.data.items[0].sessionId;

    await sessionsHandler.execute(context(['timeline', '--gap', '30m', ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        schemaVersion: '1.0.0',
        workspaceId: 'workspace-fixture',
        gapMs: 1_800_000,
        items: [{
          provider: 'generic',
          sessionId,
          eventCount: 2,
          boundaryBasis: 'session-start',
        }],
        coverage: { status: 'unknown' },
      },
    });

    await sessionsHandler.execute(context(['show', sessionId, ...dbArgs]));
    expect(jsonOutput(log).data.events).toHaveLength(2);

    await sessionsHandler.execute(context([
      'search', 'opaque', '--workspace', 'workspace-fixture', '--role', 'assistant', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        items: [{
          provider: 'generic',
          workspaceId: 'workspace-fixture',
          sessionId,
          citation: {
            provider: 'generic',
            sessionId,
            eventId: expect.any(String),
            importRunId: expect.any(String),
            sourceId: 'generic-fixture-v1',
            locatorClass: 'manual-export',
          },
        }],
        page: { limit: 50, nextCursor: null },
      },
    });

    await sessionsHandler.execute(context([
      'analytics', 'summary', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      command: 'sessions.analytics',
      status: 'ok',
      data: {
        view: 'summary',
        summary: {
          analyticsVersion: '1.0.0',
          workspaceId: 'workspace-fixture',
          totals: { sessions: 1, indicators: 3 },
        },
      },
    });
    await sessionsHandler.execute(context([
      'forensics', 'indicators', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'error',
      error: { code: 'OPERATION_NOT_AUTHORIZED' },
    });
    await sessionsHandler.execute(context([
      'forensics', 'indicators', '--authorize-forensics', ...dbArgs,
    ]));
    const indicators = jsonOutput(log);
    expect(indicators).toMatchObject({
      status: 'ok',
      data: {
        analyticsVersion: '1.0.0',
        view: 'indicators',
        count: 3,
        authorization: {
          explicit: true,
          historicalContentExecuted: false,
        },
      },
    });
    expect(JSON.stringify(indicators)).not.toContain('redaction-canary-value');
    const factId = indicators.data.items[0].factId;
    await sessionsHandler.execute(context([
      'forensics', 'evidence', factId, '--authorize-forensics', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        view: 'evidence',
        fact: { factId, sourceCitation: { eventId: expect.any(String) } },
        event: {
          eventId: expect.any(String),
          rawReference: { locatorClass: 'generic-interchange' },
        },
      },
    });
    await sessionsHandler.execute(context([
      'forensics', 'timeline', sessionId, '--authorize-forensics', '--markdown', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        view: 'timeline',
        markdown: expect.stringContaining('# Session Forensics timeline'),
      },
    });

    await sessionsHandler.execute(context([
      'extract', sessionId, '--workspace', 'workspace-fixture', '--dry-run', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        count: 1,
        durableMemoryWrites: 0,
        items: [{
          type: 'decision',
          reviewState: 'pending',
          evidence: [{ eventId: expect.any(String), quoteDigest: expect.any(String) }],
        }],
      },
    });
    await sessionsHandler.execute(context([
      'extract', sessionId, '--workspace', 'workspace-fixture', ...dbArgs,
    ]));
    const extracted = jsonOutput(log);
    const candidateId = extracted.data.items[0].candidateId;
    await sessionsHandler.execute(context(['candidates', '--state', 'pending', ...dbArgs]));
    expect(jsonOutput(log).data.items).toHaveLength(1);
    await sessionsHandler.execute(context([
      'review', candidateId, '1', 'accepted',
      '--reviewer', 'fixture-reviewer', '--reason', 'evidence verified', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { candidateId, candidateVersion: 1, fromState: 'pending', toState: 'accepted' },
    });
    await sessionsHandler.execute(context(['candidates', '--state', 'accepted', ...dbArgs]));
    expect(jsonOutput(log).data.items).toHaveLength(1);
    const manifestDir = resolve(root, 'agentic/code/frameworks/memory');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(resolve(manifestDir, 'manifest.json'), JSON.stringify({
      id: 'memory',
      memory: { topology: {
        namespace: '.aiwg/memory',
        derivedPages: { session: '.aiwg/memory/session-knowledge' },
      } },
    }));
    await sessionsHandler.execute(context([
      'promote', candidateId, '1', '--consumer', 'memory',
      '--reviewer', 'fixture-reviewer', ...dbArgs,
    ], root));
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        candidateId,
        candidateVersion: 1,
        consumer: 'memory',
        confirmationRequired: true,
        conflictsWith: [],
        supersedes: [],
      },
    });
    await sessionsHandler.execute(context([
      'promote', candidateId, '1', '--consumer', 'memory',
      '--reviewer', 'fixture-reviewer', '--confirm', ...dbArgs,
    ], root));
    const promoted = jsonOutput(log);
    expect(promoted).toMatchObject({
      status: 'ok',
      data: { receipt: {
        candidateId,
        candidateVersion: 1,
        consumer: 'memory',
        duplicate: false,
        evidenceEventIds: [expect.any(String)],
      } },
    });
    expect(readFileSync(resolve(root, promoted.data.receipt.destinationRef), 'utf8'))
      .toContain(`candidate_id: ${candidateId}`);

    const lineAddonDir = resolve(root, 'agentic/code/addons/line-memory');
    mkdirSync(resolve(lineAddonDir, 'commands'), { recursive: true });
    writeFileSync(resolve(lineAddonDir, 'manifest.json'), JSON.stringify({
      id: 'line-memory',
    }));
    const lineModule = pathToFileURL(resolve(
      process.cwd(),
      'agentic/code/addons/line-memory/commands/line-memory.mjs',
    )).href;
    writeFileSync(
      resolve(lineAddonDir, 'commands/line-memory.mjs'),
      `export { LineMemoryPromotionDestination } from ${JSON.stringify(lineModule)};\n`,
    );
    await sessionsHandler.execute(context([
      'promote', candidateId, '1', '--consumer', 'line-memory',
      '--reviewer', 'fixture-reviewer', '--confirm', ...dbArgs,
    ], root));
    const linePromoted = jsonOutput(log);
    expect(linePromoted).toMatchObject({
      status: 'ok',
      data: { receipt: {
        candidateId,
        candidateVersion: 1,
        consumer: 'line-memory',
        destinationRef: expect.stringMatching(/line-memory\.meta\.json#lm_/),
        duplicate: false,
      } },
    });
    expect(readFileSync(resolve(root, '.aiwg/memory/line-memory.txt'), 'utf8').trim())
      .not.toBe('');
    const lineHandle = linePromoted.data.receipt.destinationRef.split('#')[1];
    expect(JSON.parse(readFileSync(
      resolve(root, '.aiwg/memory/line-memory.meta.json'),
      'utf8',
    )).entries[lineHandle]).toMatchObject({
      id: lineHandle,
      sources: [expect.objectContaining({
        ref: `session-candidate:${candidateId}:v1`,
      })],
    });

    await sessionsHandler.execute(context(['tag', sessionId, 'decision', '--dry-run', ...dbArgs]));
    expect(jsonOutput(log).status).toBe('preview');
    await sessionsHandler.execute(context(['tag', sessionId, 'decision', ...dbArgs]));
    expect(jsonOutput(log).data.tags).toEqual(['decision']);

    await sessionsHandler.execute(context([
      'relocate', 'generic-fixture-v1', '/private/new/location.jsonl', '--dry-run', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: { redactedLocator: '<session-source>/location.jsonl' },
    });

    await sessionsHandler.execute(context(['reindex', '--dry-run', ...dbArgs]));
    expect(jsonOutput(log).status).toBe('preview');

    await sessionsHandler.execute(context(['delete', sessionId, ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: { providerLogsModified: false, confirmationRequired: true },
    });

    await sessionsHandler.execute(context(['audit', '--limit', '2', ...dbArgs]));
    const auditOutput = jsonOutput(log);
    expect(auditOutput).toMatchObject({
      status: 'ok',
      data: {
        page: { limit: 2, nextCursor: expect.any(String) },
      },
    });
    expect(auditOutput.data.items[0]).toMatchObject({
      eventName: 'session.import',
      workspaceId: 'workspace-fixture',
      integrityDigest: expect.stringMatching(/^sha256:/),
    });
    await sessionsHandler.execute(context(['audit', '--otel', ...dbArgs]));
    const otelOutput = jsonOutput(log);
    expect(otelOutput.status).toBe('ok');
    expect(otelOutput.data.records[0]).toMatchObject({
      EventName: 'session.import',
      Body: {},
      Resource: { service: 'aiwg.sessions', workspaceId: 'workspace-fixture' },
    });

    await sessionsHandler.execute(context(['doctor', ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { health: { integrity: 'ok', sources: 1, sessions: 1, events: 2 } },
    });
  });

  it('tombstones only after explicit confirmation and keeps JSON errors stable', async () => {
    const fixture = resolve('test/fixtures/sessions/generic/valid-v1.jsonl');
    const dbArgs = [
      '--db', resolve(root, 'catalog.sqlite'),
      '--workspace', 'default',
      '--json',
    ];
    await sessionsHandler.execute(context([
      'import', fixture, '--source-id', 'generic-fixture-v1', ...dbArgs,
    ]));
    await sessionsHandler.execute(context(['list', ...dbArgs]));
    const sessionId = jsonOutput(log).data.items[0].sessionId;
    await sessionsHandler.execute(context(['delete', sessionId, '--confirm', ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({ status: 'ok', data: { outcome: 'tombstoned' } });
    await sessionsHandler.execute(context(['list', ...dbArgs]));
    expect(jsonOutput(log).data.items).toEqual([]);
    await sessionsHandler.execute(context(['restore', sessionId, ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { sessionId, outcome: 'restored', providerLogsModified: false },
    });
    await sessionsHandler.execute(context(['purge', sessionId, ...dbArgs]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'preview',
      data: {
        sessionId,
        counts: { sessions: 1, events: 2, indexes: 2 },
        providerLogsModified: false,
        confirmationRequired: true,
      },
    });
    await sessionsHandler.execute(context([
      'purge', sessionId, '--confirm',
      '--actor-class', 'operator', '--reason-code', 'user_request', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: {
        providerLogsModified: false,
        receipt: { outcome: 'committed', orphanCounts: {
          sessions: 0, events: 0, indexes: 0, candidates: 0,
        } },
      },
    });
    await sessionsHandler.execute(context([
      'purge', sessionId, '--confirm',
      '--actor-class', 'operator', '--reason-code', 'retry', ...dbArgs,
    ]));
    expect(jsonOutput(log)).toMatchObject({
      status: 'ok',
      data: { duplicate: true, receipt: { outcome: 'committed' } },
    });
    const missing = await sessionsHandler.execute(context(['show', sessionId, ...dbArgs]));
    expect(missing.exitCode).toBe(4);
    expect(jsonOutput(log).error.code).toBe('SESSION_NOT_FOUND');
  });
});
