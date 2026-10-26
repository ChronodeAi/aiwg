// Shared dispatch evidence constants; receipt and storage owners use the same identities.
import { createHash } from 'node:crypto';
import { importImpl } from '../../_resolve-impl.mjs';
const { INVOCATION_PATTERN: SHARED_INVOCATION_PATTERN } = await importImpl(import.meta.url, 'effects/dispatch-verifier.js');

export const DISPATCH_DIR_MODE = 0o700;
export const DISPATCH_FILE_MODE = 0o600;
/** The only prompt filename cleanup ever removes. */
export const DISPATCH_PROMPT_FILENAME = 'prompt.md';

/**
 * Canonical invocation-ID shape. The single source is
 * `src/effects/dispatch-verifier.ts` `INVOCATION_PATTERN`; this binding is
 * the SAME regex object (imported, not copied), so the two can never drift.
 */
export const INVOCATION_PATTERN = SHARED_INVOCATION_PATTERN;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Strict id/enum shapes for the redacted export (#2891 R2). Any value that
 * does not match is dropped and replaced with `REDACTION_MARKER` rather than
 * ever reaching the exported object: an allowlisted FIELD NAME is not an
 * allowlisted VALUE. */
export const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const CHECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const PROFILE_VERSION_PATTERN = /^\d{1,5}(?:\.\d{1,5}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
export const IDENTITY_CONFIDENCE_VALUES = Object.freeze(['unavailable', 'runtime-configured-only', 'backend-attested']);
export const RECEIPT_TERMINATION_VALUES = Object.freeze(['confirmed', 'uncertain']);
export const REDACTION_MARKER = '[redacted:invalid]';

/** Execution outcomes this module settles. `uncertain` covers live and unreconciled work. */
export const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled', 'timed-out', 'uncertain']);

/** Usage confidence labels from #2890's WorkerUsage quality. Unknown stays unknown. */
export const USAGE_QUALITIES = Object.freeze(['reported', 'estimated', 'unknown']);

export class DispatchEvidenceError extends Error {
  constructor(message, code = 'dispatch-evidence-failed') {
    super(message);
    this.name = 'DispatchEvidenceError';
    this.code = code;
  }
}

export const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

