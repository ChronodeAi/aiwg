#!/usr/bin/env node
// Trusted-check fixture (Rule 9 step 8/9, #2888 fix round 2).
//
// A standalone process run by the CONDUCTOR, never by the worker: it reads
// a worker's final output from disk, re-digests it, and validates its
// declared shape. This is the "small node check over the worker's produced
// output, run by the conductor-side helper" the review asked for — a real
// subprocess the test spawns and waits on, not a JS function called inline
// in the same process as the assertion.
//
// Usage (source checkout): node --import tsx verify-worker-final.mjs --final <path> --expect-digest sha256:<hex>
// Exit 0 and print the recomputed digest on success; exit 1 and print a
// diagnostic to stderr on any failure (missing file, digest mismatch, or an
// output that is not a well-formed completed `result` claim).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ProviderAdapter } from '../../tools/ralph-external/lib/provider-adapter.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const finalPath = arg('--final');
const expectDigest = arg('--expect-digest');
if (!finalPath || !expectDigest) {
  process.stderr.write('usage: verify-worker-final.mjs --final <path> --expect-digest sha256:<hex>\n');
  process.exit(2);
}

let bytes;
try {
  bytes = readFileSync(finalPath);
} catch (error) {
  process.stderr.write(`cannot read final output: ${error.message}\n`);
  process.exit(1);
}

const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
if (digest !== expectDigest) {
  process.stderr.write(`digest mismatch: expected ${expectDigest}, got ${digest}\n`);
  process.exit(1);
}

let claims;
try {
  // Synthetic shape/digest check only. The conductor independently observes the
  // actual worker termination and supplies execution to trusted result assembly.
  class FixtureAdapter extends ProviderAdapter {}
  claims = await new FixtureAdapter().parseWorkerOutput(bytes, {
    observation: { transport: 'shell', status: 'completed', exitCode: 0, termination: 'confirmed' },
  });
} catch (error) {
  process.stderr.write(`final output is not a completed result claim: ${error.message}\n`);
  process.exit(1);
}

if (claims.status !== 'completed') {
  process.stderr.write(`final output is not a completed result claim (status=${claims.status})\n`);
  process.exit(1);
}

process.stdout.write(`${digest}\n`);
process.exit(0);
