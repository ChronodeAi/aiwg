/**
 * Grok Bot desktop native-store locator primitives (#2970).
 *
 * The Grok Bot desktop app ("sand") persists one JSON document per logical
 * key under `$XDG_CONFIG_HOME/Grok Bot/sand-client-persistence/` (default
 * `~/.config/Grok Bot/...`, Linux only — macOS/Windows equivalents are
 * unverified and must never be guessed). Each file is named `<key>.blob`,
 * where `<key>` is the RFC 4648 section 6 base32 encoding of the key string,
 * lowercase, unpadded.
 *
 * This module decodes filenames ONLY — it never opens file content. The
 * adapter layer uses {@link classifyGrokbotBlobName} to build a strict
 * allowlist: only filenames that decode to a transcript-replica or
 * last-roster key are ever candidates for opening. Every other `.blob` file
 * (composer drafts, send journal, experiments, UI layout, secrets, cookies,
 * local/session storage, etc.) is left untouched.
 *
 * @see docs/providers/grokbot-sessions.md
 * @issue #2970
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_INDEX = new Map(BASE32_ALPHABET.split('').map((char, index) => [char, index]));
const BASE32_SHAPE = /^[a-z2-7]+$/;

const TRANSCRIPT_REPLICA_KEY_PATTERN =
  /^sand\.client\.slice\.account\.grok%7Cuser_[^.]+\.transcript\.replicas\.([0-9a-fA-F-]{36})$/;
const ROSTER_KEY_PATTERN =
  /^sand\.client\.slice\.account\.grok%7Cuser_[^.]+\.roster\.last-roster$/;

export type GrokbotBlobClassification =
  | { kind: 'transcript-replica'; conversationId: string }
  | { kind: 'roster' }
  | null;

/** Unpadded lowercase RFC 4648 base32 encode, most significant bit first. */
export function encodeGrokbotKey(key: string): string {
  const bytes = Buffer.from(key, 'utf8');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode an unpadded lowercase RFC 4648 base32 string back to its original
 * UTF-8 key. Returns null for anything that is not canonical base32 (wrong
 * alphabet, or non-zero padding bits) rather than guessing.
 */
export function decodeGrokbotKey(encoded: string): string | null {
  if (encoded.length === 0 || !BASE32_SHAPE.test(encoded)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of encoded) {
    const index = BASE32_INDEX.get(char);
    if (index === undefined) return null;
    buffer = (buffer << 5) | index;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  if (bitsLeft >= 5) return null;
  if (bitsLeft > 0 && (buffer & ((1 << bitsLeft) - 1)) !== 0) return null;
  try {
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Classify a `<base32>.blob` filename WITHOUT opening it. Returns null for
 * anything that is not a `.blob` file, does not decode to canonical base32,
 * or decodes to a key outside the allowlist (composer drafts, send journal,
 * experiments, ui-layout, secrets, cookies, storage, etc.).
 */
export function classifyGrokbotBlobName(filename: string): GrokbotBlobClassification {
  if (!filename.endsWith('.blob')) return null;
  const encoded = filename.slice(0, -'.blob'.length);
  const key = decodeGrokbotKey(encoded);
  if (key === null) return null;
  const transcript = TRANSCRIPT_REPLICA_KEY_PATTERN.exec(key);
  if (transcript) return { kind: 'transcript-replica', conversationId: transcript[1] };
  if (ROSTER_KEY_PATTERN.test(key)) return { kind: 'roster' };
  return null;
}

/** Build the `<key>.blob` filename for a transcript replica (test fixtures only). */
export function grokbotTranscriptReplicaFilename(account: string, conversationId: string): string {
  return `${encodeGrokbotKey(
    `sand.client.slice.account.grok%7Cuser_${account}.transcript.replicas.${conversationId}`,
  )}.blob`;
}

/** Build the `<key>.blob` filename for the account roster (test fixtures only). */
export function grokbotRosterFilename(account: string): string {
  return `${encodeGrokbotKey(
    `sand.client.slice.account.grok%7Cuser_${account}.roster.last-roster`,
  )}.blob`;
}

/** Extract the conversation id from an authorized transcript-replica locator path, or null. */
export function grokbotConversationIdFromLocator(locator: string): string | null {
  const base = locator.replaceAll('\\', '/').split('/').pop() ?? '';
  const classification = classifyGrokbotBlobName(base);
  return classification?.kind === 'transcript-replica' ? classification.conversationId : null;
}
