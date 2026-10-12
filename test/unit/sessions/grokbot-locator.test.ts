import { describe, expect, it } from 'vitest';
import {
  classifyGrokbotBlobName,
  decodeGrokbotKey,
  encodeGrokbotKey,
  grokbotConversationIdFromLocator,
  grokbotRosterFilename,
  grokbotTranscriptReplicaFilename,
} from '../../../src/sessions/adapters/grokbot-locator.js';

describe('Grok Bot native locator primitives', () => {
  it('round-trips RFC 4648 base32 (lowercase, unpadded) for representative keys', () => {
    const keys = [
      'sand.client.slice.account.grok%7Cuser_synth01.transcript.replicas.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
      'sand.client.slice.account.grok%7Cuser_synth01.roster.last-roster',
      'sand.client.slice.account.grok%7Cuser_synth01.composer-drafts',
      'short',
      'a',
    ];
    for (const key of keys) {
      const encoded = encodeGrokbotKey(key);
      expect(encoded).toMatch(/^[a-z2-7]*$/);
      expect(decodeGrokbotKey(encoded)).toBe(key);
    }
  });

  it('rejects non-canonical base32 input (wrong alphabet, non-zero padding bits)', () => {
    expect(decodeGrokbotKey('')).toBeNull();
    expect(decodeGrokbotKey('***')).toBeNull();
    expect(decodeGrokbotKey('ONQW4ZBO')).toBeNull(); // uppercase is not this store's canonical form
    // 'a' decodes to 5 bits (all zero, valid); 'b' would leave non-zero leftover bits for a 1-char input.
    expect(decodeGrokbotKey('b')).toBeNull();
  });

  it('classifies a transcript-replica filename and recovers its conversation id', () => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
    const filename = grokbotTranscriptReplicaFilename('synth01', conversationId);
    expect(filename).toMatch(/^[a-z2-7]+\.blob$/);
    expect(classifyGrokbotBlobName(filename)).toEqual({
      kind: 'transcript-replica',
      conversationId,
    });
    expect(grokbotConversationIdFromLocator(`/some/root/${filename}`)).toBe(conversationId);
  });

  it('classifies a last-roster filename without exposing it as a transcript source', () => {
    const filename = grokbotRosterFilename('synth01');
    expect(classifyGrokbotBlobName(filename)).toEqual({ kind: 'roster' });
    expect(grokbotConversationIdFromLocator(`/some/root/${filename}`)).toBeNull();
  });

  it('never classifies non-allowlisted keys, non-.blob files, or malformed base32 as importable', () => {
    const decoyKey = 'sand.client.slice.account.grok%7Cuser_synth01.composer-drafts';
    expect(classifyGrokbotBlobName(`${encodeGrokbotKey(decoyKey)}.blob`)).toBeNull();
    expect(classifyGrokbotBlobName('sand-secrets.json')).toBeNull();
    expect(classifyGrokbotBlobName('box-secrets-main.blob')).toBeNull();
    expect(classifyGrokbotBlobName('***not-base32***.blob')).toBeNull();
    expect(classifyGrokbotBlobName('no-extension-at-all')).toBeNull();
  });
});
