#!/usr/bin/env node
/**
 * Explicit TV-12 entry point (#2681). No arguments, --prepare, --dry-run, --record-qualification and
 * --verify-qualification never resolve a credential or call a provider. Only --collect-approved and
 * --canary-approved import the pinned trusted resolver and dispatch to Jev.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const usage = { '--prepare': 3, '--dry-run': 6, '--collect-approved': 6, '--record-qualification': 6, '--verify-qualification': 2, '--canary-approved': 7 };
if (!(args[0] in usage)) {
  process.stdout.write('No provider calls. Use --prepare PROFILE.json OUTPUT.json; --dry-run or --collect-approved APPROVAL.json CORPUS.json ARTIFACT_ROOT TRUSTED_RESOLVER.mjs RESOLVER_SHA256; '
    + '--record-qualification APPROVAL.json CORPUS.json RUN_DIR REVIEW.json OUTPUT.json; --verify-qualification RECORD.json; '
    + '--canary-approved CANARY_APPROVAL.json CORPUS.json RECORD.json ARTIFACT_ROOT TRUSTED_RESOLVER.mjs RESOLVER_SHA256.\n');
  process.exit(0);
}
const offline = ['--prepare', '--dry-run', '--record-qualification', '--verify-qualification'].includes(args[0]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fileDigest = async path => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
try {
  if (args.length !== usage[args[0]]) throw new Error('usage');
  const root = resolve(import.meta.dirname, '../..');
  // Compile the exact source before importing the runtime; stale dist cannot back live evidence.
  execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const runtime = await import('../../dist/src/decision/context-live-qualification.js');
  const promotion = await import('../../dist/src/decision/context-live-promotion.js');
  const pinnedHost = async (resolverPath, expected, approved) => {
    const actualDigest = await fileDigest(resolve(resolverPath));
    if (expected !== actualDigest || approved !== actualDigest) throw new Error('resolver-pin');
    const host = await import(pathToFileURL(resolve(resolverPath)).href);
    if (typeof host.resolveCredential !== 'function') throw new Error('resolver-interface');
    return { resolveCredential: host.resolveCredential };
  };
  if (args[0] === '--prepare') {
    const profile = await json(args[1]);
    const corpus = await runtime.generateContextLiveCorpus(profile);
    await runtime.assertContextArtifactRoot(root, dirname(resolve(args[2])));
    await writeFile(args[2], JSON.stringify(corpus, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ corpusDigest: runtime.contextLiveDigest(corpus), cases: corpus.cases.length, providerCalls: 0 }) + '\n');
  } else if (args[0] === '--dry-run') {
    // Same preconditions as --collect-approved; reports instead of dispatching, and never imports the resolver.
    const approval = await json(args[1]), corpus = await json(args[2]);
    const estimate = await runtime.estimateContextLiveCollection(approval, corpus);
    const check = async fn => { try { await fn(); return true; } catch { return false; } };
    const resolverDigest = await fileDigest(resolve(args[4]));
    const preconditions = {
      completeGeneratedCorpus: runtime.contextLiveDigest(await runtime.generateContextLiveCorpus(corpus.profile)) === approval.corpusDigest,
      cleanExactSource: await check(() => runtime.assertContextLiveSource(root, approval.sourceCommit)),
      canonicalArtifactRoot: await check(() => runtime.assertContextArtifactRoot(root, resolve(args[3]))),
      resolverPinned: args[5] === resolverDigest && approval.credentialResolverDigest === resolverDigest,
    };
    const ready = Object.values(preconditions).every(Boolean) && estimate.fitsBeforeStop;
    process.stdout.write(JSON.stringify({ ...estimate, preconditions, readyForApprovedCollection: ready }, null, 2) + '\n');
    if (!ready) process.exitCode = 1;
  } else if (args[0] === '--record-qualification') {
    const approval = await json(args[1]), corpus = await json(args[2]), review = await json(args[4]);
    const runDir = resolve(args[3]);
    const records = await Promise.all((await readdir(runDir)).filter(name => name.endsWith('-comparison.json')).sort().map(name => json(join(runDir, name))));
    const record = await promotion.recordContextQualification({ approval, corpus, records, review });
    await runtime.assertContextArtifactRoot(root, dirname(resolve(args[5])));
    await writeFile(args[5], JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ recordDigest: runtime.contextLiveDigest(record), profile: record.profile, profileDigest: record.profileDigest, selection: record.selection, providerCalls: 0 }) + '\n');
  } else if (args[0] === '--verify-qualification') {
    const record = await json(args[1]);
    promotion.verifyContextQualificationRecord(record);
    let versionChangeRejected = false;
    try { promotion.verifyContextQualificationRecord(record, { ...record.profile, version: `${record.profile.version}-changed` }); } catch { versionChangeRejected = true; }
    process.stdout.write(JSON.stringify({ accepted: true, versionChangeRejected, recordDigest: runtime.contextLiveDigest(record), providerCalls: 0 }) + '\n');
    if (!versionChangeRejected) process.exitCode = 1;
  } else if (args[0] === '--collect-approved') {
    const approval = await json(args[1]), corpus = await json(args[2]);
    runtime.validateContextLiveApproval(approval, corpus);
    await runtime.assertContextLiveSource(root, approval.sourceCommit);
    await runtime.assertContextArtifactRoot(root, resolve(args[3]));
    const host = await pinnedHost(args[4], args[5], approval.credentialResolverDigest);
    const result = await runtime.runContextLiveCollection({ approval, corpus, sourceRoot: root, artifactRoot: resolve(args[3]), host });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.collectionSuccess) process.exitCode = 1;
  } else {
    const approval = await json(args[1]), corpus = await json(args[2]), record = await json(args[3]);
    promotion.validateContextCanaryApproval(approval, corpus, record);
    await runtime.assertContextLiveSource(root, approval.sourceCommit);
    await runtime.assertContextArtifactRoot(root, resolve(args[4]));
    const host = await pinnedHost(args[5], args[6], approval.credentialResolverDigest);
    const result = await promotion.runContextEnforceCanary({ approval, corpus, record, sourceRoot: root, artifactRoot: resolve(args[4]), host });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.canaryPassed) process.exitCode = 1;
  }
} catch (error) {
  // Provider, filesystem and secret-service messages may contain private material; offline modes touch neither.
  process.stderr.write(offline && error instanceof Error ? `TV-12 offline step failed: ${error.message}\n`
    : 'TV-12 stopped: configuration, provenance, admission, collection, or evidence validation failed. No automatic retry.\n');
  process.exitCode = 1;
}
