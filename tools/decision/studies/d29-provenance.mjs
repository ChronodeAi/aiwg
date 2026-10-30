// Pin current entry bytes and verify the extracted scorer modules bound by that entry.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function d29ScorerDigest(_seed, modulePins) {
  for (const [path, expected] of Object.entries(modulePins)) {
    if (digest(await readFile(new URL(path, import.meta.url))) !== expected) {
      throw new Error(`D29 study refused (scorer-module-pin: ${path})`);
    }
  }
  // The shared collector compares this pin with the study entry file's current bytes.
  return digest(await readFile(new URL('./d29.mjs', import.meta.url)));
}
