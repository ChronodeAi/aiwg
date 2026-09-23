import { describe, expect, it } from 'vitest';
import {
  discoverSessionOutputCandidates,
  sha256,
  type DerivedOutputRegistration,
} from '../../../src/sessions/index.js';

function registration(overrides: Partial<DerivedOutputRegistration> = {}): DerivedOutputRegistration {
  return {
    schemaVersion: 'aiwg.output-registration.v1',
    registrationId: sha256('registration-1'),
    output: {
      locator: 'output/reports/result.md', mediaType: 'text/markdown', digest: sha256('result'), byteLength: 42,
    },
    contextPack: {
      id: 'context-pack:task-1',
      digest: sha256('exact bounded context pack'),
      sources: [{ kind: 'session', ref: 'session-1', digest: sha256('session evidence'), span: null }],
    },
    supersedes: [],
    conflictsWith: [],
    ...overrides,
  };
}

const session = { sessionId: 'session-1', nativeSessionId: 'native-1', provider: 'claude' as const };

describe('discoverSessionOutputCandidates (#2566)', () => {
  it('matches a source whose ref equals the stable session id', () => {
    const candidates = discoverSessionOutputCandidates([registration()], [session]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sessionId: 'session-1', lineage: 'registered', matchReason: 'ref equals the stable session id',
    });
  });

  it('matches the session:<id> prefix convention', () => {
    const reg = registration({
      contextPack: {
        id: 'context-pack:task-2', digest: sha256('pack'),
        sources: [{ kind: 'session', ref: 'session:session-1', digest: sha256('e'), span: null }],
      },
    });
    const candidates = discoverSessionOutputCandidates([reg], [session]);
    expect(candidates[0].matchReason).toBe("ref equals 'session:<stable session id>'");
  });

  it('matches the native session id when the stable id is not used', () => {
    const reg = registration({
      contextPack: {
        id: 'context-pack:task-3', digest: sha256('pack'),
        sources: [{ kind: 'session', ref: 'native-1', digest: sha256('e'), span: null }],
      },
    });
    const candidates = discoverSessionOutputCandidates([reg], [session]);
    expect(candidates[0].matchReason).toBe('ref equals the native session id');
  });

  it('never matches a non-session source kind, even with an identical ref string', () => {
    const reg = registration({
      contextPack: {
        id: 'context-pack:task-4', digest: sha256('pack'),
        sources: [{ kind: 'url', ref: 'session-1', digest: sha256('e'), span: null }],
      },
    });
    expect(discoverSessionOutputCandidates([reg], [session])).toEqual([]);
  });

  it('does not match an unrelated session id', () => {
    const other = { sessionId: 'session-999', nativeSessionId: 'native-999', provider: 'claude' as const };
    expect(discoverSessionOutputCandidates([registration()], [other])).toEqual([]);
  });

  it('never infers a match from the output file path/locator alone', () => {
    const reg = registration({
      output: {
        locator: 'output/session-1/result.md', mediaType: 'text/markdown', digest: sha256('r'), byteLength: 1,
      },
      contextPack: {
        id: 'context-pack:task-5', digest: sha256('pack'),
        sources: [{ kind: 'url', ref: 'https://example.test/session-1', digest: sha256('e'), span: null }],
      },
    });
    expect(discoverSessionOutputCandidates([reg], [session])).toEqual([]);
  });
});
