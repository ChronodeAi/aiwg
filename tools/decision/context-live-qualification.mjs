#!/usr/bin/env node
/** Explicit collection entry point. No arguments, or --prepare, never resolves a credential. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!['--prepare', '--collect-approved'].includes(args[0])) {
  process.stdout.write('No provider calls. Use --prepare PROFILE.json OUTPUT.json, or --collect-approved APPROVAL.json CORPUS.json ARTIFACT_ROOT TRUSTED_RESOLVER.mjs RESOLVER_SHA256.\n');
  process.exit(0);
}
try {
  const root = resolve(import.meta.dirname, '../..');
  // Compile the exact source before importing the runtime; stale dist cannot back live evidence.
  execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const runtime = await import('../../dist/src/decision/context-live-qualification.js');
  if (args[0] === '--prepare') {
    if (args.length !== 3) throw new Error('usage');
    const profile = JSON.parse(await readFile(args[1], 'utf8'));
    const corpus = await runtime.generateContextLiveCorpus(profile);
    await runtime.assertContextArtifactRoot(root, dirname(resolve(args[2])));
    await writeFile(args[2], JSON.stringify(corpus, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ corpusDigest: runtime.contextLiveDigest(corpus), cases: corpus.cases.length, providerCalls: 0 }) + '\n');
  } else {
    if (args.length !== 6) throw new Error('usage');
    const approval = JSON.parse(await readFile(args[1], 'utf8'));
    const corpus = JSON.parse(await readFile(args[2], 'utf8'));
    runtime.validateContextLiveApproval(approval, corpus);
    await runtime.assertContextLiveSource(root, approval.sourceCommit);
    await runtime.assertContextArtifactRoot(root, resolve(args[3]));
    const resolverPath = resolve(args[4]);
    const actualDigest = `sha256:${createHash('sha256').update(await readFile(resolverPath)).digest('hex')}`;
    if (args[5] !== actualDigest || approval.credentialResolverDigest !== actualDigest) throw new Error('resolver-pin');
    const host = await import(pathToFileURL(resolverPath).href);
    if (typeof host.resolveCredential !== 'function') throw new Error('resolver-interface');
    const result = await runtime.runContextLiveCollection({ approval, corpus, sourceRoot: root, artifactRoot: resolve(args[3]), host: { resolveCredential: host.resolveCredential } });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.collectionSuccess) process.exitCode = 1;
  }
} catch {
  // Provider, filesystem and secret-service messages may contain private material.
  process.stderr.write('TV-12 stopped: configuration, provenance, admission, collection, or evidence validation failed. No automatic retry.\n');
  process.exitCode = 1;
}
