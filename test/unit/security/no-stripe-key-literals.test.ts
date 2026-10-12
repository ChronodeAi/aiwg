import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// GitHub push protection rejects mirror pushes that contain Stripe-shaped
// secret or restricted keys, even test canaries (#2856). Canaries must be
// assembled at runtime instead, e.g. ['sk', 'live', '<body>'].join('_').
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SCANNED = ['src', 'test', 'tools', 'agentic'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);
const TEXT_FILE = /\.(?:[cm]?[jt]s|json|md|ya?ml|txt)$/;
const STRIPE_SECRET = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT_FILE.test(entry.name) && statSync(full).size < 4 * 1024 * 1024) yield full;
  }
}

describe('Stripe key literals', () => {
  it('keeps Stripe-shaped secret keys out of source so mirror pushes are not blocked', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of files(join(root, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (STRIPE_SECRET.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
