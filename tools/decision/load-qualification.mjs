#!/usr/bin/env node
import { readFile, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importImpl } from '../_resolve-impl.mjs';

/** D05 harness entry point. Only --live enables the Jev adapter; credentials are caller-supplied environment values. */
export async function loadQualificationMain(args, env = process.env) {
  const values = {};
  let live = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live' && !live) { live = true; continue; }
    if (!['--manifest', '--commit', '--credential-env', '--network-path', '--output'].includes(arg)
      || values[arg] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid load harness arguments');
    values[arg] = args[++index];
  }
  if (!['--manifest', '--commit', '--network-path', '--output'].every(key => values[key])) {
    throw new Error('Usage: node tools/decision/load-qualification.mjs [--live] --manifest FILE --commit FULL_COMMIT --network-path DESCRIPTION --output FILE [--credential-env NAME]');
  }
  const runtime = await importImpl(import.meta.url, 'decision/qualification/load.js');
  const manifestBytes = await readFile(resolve(values['--manifest']), 'utf8');
  // Fail before config reads or output writes when the live budget or credential is absent.
  const manifest = runtime.readDecisionLoadManifest(manifestBytes);
  runtime.validateDecisionLoadManifestV3(manifest);
  const credentialEnv = values['--credential-env'] ?? 'AIWG_JEV_LOAD_API_KEY';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialEnv)) throw new Error('Invalid credential environment variable name');
  if (live && !env[credentialEnv]?.trim()) throw new Error('--live requires the caller-supplied environment credential');
  const root = process.cwd();
  const output = resolve(values['--output']);
  const outsideSource = (base, target) => { const path = relative(base, target); return path.startsWith(`..${sep}`); };
  if (!outsideSource(root, output)) throw new Error('Load evidence output must be outside the source tree');
  await mkdir(dirname(output), { recursive: true });
  if (!outsideSource(await realpath(root), await realpath(dirname(output)))) throw new Error('Load evidence output resolves inside the source tree');
  // Reserve the append-only output before any provider work or config reads.
  const destination = await open(output, 'wx', 0o600);
  let record;
  try {
    const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
    const config = await readAiwgConfig(root);
    record = await runtime.runDecisionStagedLoad({ manifestBytes, live, env, credentialEnv, sourceRoot: root,
      sourceCommit: values['--commit'], networkPath: values['--network-path'], pricing: config?.decision?.ask?.cost });
    await destination.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await destination.sync();
  } catch (error) {
    // Preflight refusals have no evidence. A returned partial run remains reserved for recovery on write failure.
    if (!record) await unlink(output);
    throw error;
  } finally { await destination.close(); }

  return record;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const record = await loadQualificationMain(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ execution: record.execution, passed: record.passed, stop: record.stop,
      reservedUsage: record.reservedUsage, reportedUsage: record.reportedUsage, digest: record.digest })}\n`);
    if (!record.passed) process.exitCode = 1;
  } catch {
    // Never echo exceptions from adapters/config/environment into operator evidence.
    process.stderr.write('D05 load harness refused or failed. Check arguments, v3 budget, sourced cost config, clean exact commit and caller environment.\n');
    process.exitCode = 1;
  }
}
