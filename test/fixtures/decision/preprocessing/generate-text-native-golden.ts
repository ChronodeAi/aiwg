/**
 * Regenerates `text-native-golden-v1.json` from a BASELINE runtime, never from the branch under test.
 *
 * Usage (from a detached checkout of the baseline, for example origin/main, with this file and
 * `text-native-cases.ts` copied into the same relative paths):
 *
 *   npx tsx test/fixtures/decision/preprocessing/generate-text-native-golden.ts "$(git rev-parse HEAD)" <out.json>
 *
 * The golden records `generatedFrom` so a reviewer can re-run it against that exact commit.
 */
import { writeFileSync } from 'node:fs';
import * as runtime from '../../../../src/decision/index.js';
import { canonicalJson } from '../../../../src/security/artifact-trust.js';
import { runTextNativeCases, TEXT_NATIVE_EPOCH_MS } from './text-native-cases.js';

const [generatedFrom, output] = process.argv.slice(2);
if (!generatedFrom || !output) throw new Error('usage: generate-text-native-golden.ts <baseline-commit> <out.json>');
const cases = await runTextNativeCases(runtime as never);
const golden = {
  schemaVersion: 'decision-text-native-golden/v1',
  generatedFrom,
  epochMs: TEXT_NATIVE_EPOCH_MS,
  cases: cases.map(item => ({ id: item.id, canonical: canonicalJson(item) })),
};
writeFileSync(output, `${JSON.stringify(golden, null, 2)}\n`);
