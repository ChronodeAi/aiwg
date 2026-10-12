import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROKBOT_ADAPTER_VERSION,
  GROKBOT_EXPORT_SCHEMA_VERSION,
  GrokbotSessionAdapter,
  SessionSourceAdapterRegistry,
  type SelectedSource,
} from '../../../src/sessions/index.js';

const fixturesRoot = resolve('test/fixtures/sessions/grokbot');

function selected(name: string, sourceId: string, locatorClass = 'manual-export'): SelectedSource {
  return {
    provider: 'grokbot',
    locator: resolve(fixturesRoot, name),
    locatorClass,
    sourceId,
    authorizedScope: { workspaceId: 'workspace-fixture', allowedRoots: [fixturesRoot] },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

describe('Grok Bot session adapter', () => {
  const adapter = new GrokbotSessionAdapter();

  it('is implemented, with native discovery evidence-gated and a no-op over a manual-export-only root', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(adapter);
    expect(registry.report('grokbot', {
      state: 'available',
      evidence: {
        adapterVersion: GROKBOT_ADAPTER_VERSION,
        sourceSchemaVersion: GROKBOT_EXPORT_SCHEMA_VERSION,
        verifiedAt: '2026-10-09',
        reference: 'docs/providers/grokbot-sessions.md',
      },
      reason: null,
      remediation: 'select an authorized manual-export interchange file, or pass --grokbot-root',
    })).toMatchObject({
      classification: 'implemented',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['manual-export', 'jsonl'],
    });
    // discover() does not throw; it requires an authorized root (#2970) and
    // then only ever selects filenames that decode to a transcript-replica
    // key. None of the manual-export jsonl fixtures in this directory match,
    // so discovery over it is a well-defined no-op, not an error.
    registry.assertOperation('grokbot', 'discover');
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [fixturesRoot],
    }))).resolves.toEqual([]);
    await expect(collect(adapter.discover({
      workspaceId: 'workspace-fixture',
      allowedRoots: [],
    }))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
  });

  it('inspects and streams an authorized manual interchange export', async () => {
    const source = selected('valid-v1.jsonl', 'grokbot-fixture-v1');
    await expect(adapter.inspect(source)).resolves.toEqual({
      sourceSchemaVersion: '1.0.0',
      consistency: 'complete',
      operationalState: 'available',
      declaredWorkspaceId: 'workspace-fixture',
    });
    const events = await collect(adapter.stream(source));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      nativeSessionId: 'session-1',
      nativeEventId: 'event-1',
      role: 'user',
    });
  });

  it.each([
    ['opaque-input.jsonl', 'opaque', 'MALFORMED_SOURCE'],
    ['unknown-major-v2.jsonl', 'grokbot-v2', 'UNKNOWN_SCHEMA_MAJOR'],
  ])('fails closed for %s with %s', async (name, sourceId, code) => {
    await expect(adapter.inspect(selected(name, sourceId))).rejects.toMatchObject({ code });
  });

  it('rejects Cursor or other non-manual locator classes', async () => {
    await expect(adapter.inspect(selected('valid-v1.jsonl', 'grokbot-fixture-v1', 'cursor-composer')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
