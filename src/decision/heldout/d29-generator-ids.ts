/**
 * D29 generator identities. A leaf module with no imports, so every module in
 * the generator / contract / registry import cycle can read these constants
 * during evaluation regardless of which module is imported first.
 */
export const D29_V8_GENERATOR_ID = 'd29-synthetic/v8';
export const D29_V8_SEED = 'd29-study-v8';
/** Latest D29 generator: fresh private seeds always prepare with it. */
export const D29_LATEST_GENERATOR_ID = D29_V8_GENERATOR_ID;
/** Generators whose corpora may be approved for paid collection; older ids are public-replay-only. */
export const D29_PAID_GENERATOR_IDS: readonly string[] = Object.freeze([D29_V8_GENERATOR_ID]);
