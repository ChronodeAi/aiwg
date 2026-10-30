// Adds headless proposal/review/apply flags to the existing config and models setters.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AdoptionAuthority, WorkerPair, WorkerProposal } from './worker-adoption.js';
import { atomicConfigWrite, workerWriteLock } from './worker-write.js';

export async function handleWorkerAdoptionArgs(args: string[], cwd: string, owner: 'config' | 'models', signal?: AbortSignal, dryRun = false): Promise<boolean> {
  args = args.flatMap(arg => {
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    return equals > 0 ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg];
  });
  if (!args.some(arg => ['--propose', '--apply', '--authorize', '--standing-authorization', '--parallelism', '--worker-selection', '--recover'].includes(arg))) return false;
  if (dryRun) throw new Error('Reviewed maintenance cannot write in dry-run mode; use --propose explicitly to create a review');
  if (!['set', 'set-default'].includes(args[0]) || (owner === 'config' && args[0] !== 'set')) throw new Error('Reviewed adoption flags are supported only on existing config/models setters; refresh cannot authorize or apply preferences');
  const { applyWorkerAdoption, proposeWorkerAdoption, recoverWorkerAdoption } = await import('./worker-adoption.js');
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  const values = new Set(['--target', '--propose', '--apply', '--authorize', '--standing-authorization', '--parallelism', '--worker-selection']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || flags.has(arg)) throw new Error(`A single value is required for ${arg}`);
      flags.set(arg, args[++i]);
    } else if (arg === '--project' || arg === '--json' || arg === '--recover') continue;
    else if (arg.startsWith('--')) throw new Error(`Unsupported reviewed adoption flag: ${arg}`);
    else positionals.push(arg);
  }
  const project = resolve(flags.get('--target') ?? cwd);
  const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(resolve(cwd, file), 'utf8'));
  if (args.includes('--recover')) {
    if (flags.has('--apply') || flags.has('--propose') || flags.has('--parallelism') || flags.has('--worker-selection') || positionals.length) throw new Error('Recovery accepts only authorization flags');
    if (flags.has('--authorize') === flags.has('--standing-authorization')) throw new Error('Recovery requires exactly one authorization');
    const authority: AdoptionAuthority = flags.has('--authorize') ? { digest: flags.get('--authorize')! } : await readJson(flags.get('--standing-authorization')!);
    await recoverWorkerAdoption(project, authority, { signal });
    console.log('Previous validated policy pair restored; guidance regenerated.');
    return true;
  }
  if (flags.has('--apply')) {
    if (flags.has('--propose') || flags.has('--parallelism') || flags.has('--worker-selection') || positionals.length) throw new Error('Apply accepts only a reviewed proposal and authorization');
    if (flags.has('--authorize') === flags.has('--standing-authorization')) throw new Error('Supply exactly one of --authorize DIGEST or --standing-authorization FILE');
    const proposal = await readJson(flags.get('--apply')!) as WorkerProposal;
    const authority: AdoptionAuthority = flags.has('--authorize') ? { digest: flags.get('--authorize')! } : await readJson(flags.get('--standing-authorization')!);
    await applyWorkerAdoption(project, proposal, authority, { signal });
    console.log(JSON.stringify({ applied: proposal.digest, revision: proposal.after.parallelism?.worker_mode === 'managed' ? proposal.baseRevision + 1 : null }));
    return true;
  }
  if (!flags.has('--propose') || flags.has('--authorize') || flags.has('--standing-authorization')) throw new Error('Use --propose FILE to review first, then --apply FILE with separate authorization');
  const changes: Partial<WorkerPair> = {};
  if (flags.has('--parallelism')) changes.parallelism = await readJson(flags.get('--parallelism')!);
  if (flags.has('--worker-selection')) changes.workerSelection = await readJson(flags.get('--worker-selection')!);
  if (positionals.length) {
    const [key, raw] = positionals;
    const parts = key.split('.');
    if (owner !== 'config' || parts[0] !== 'parallelism' || positionals.length !== 2 || flags.has('--parallelism')
      || parts.some(part => !part || ['__proto__', 'prototype', 'constructor', 'activation'].includes(part))) throw new Error('Reviewed edits support safe parallelism fields; model preferences use --worker-selection FILE');
    let value: any;
    try { value = JSON.parse(raw); } catch { value = raw; }
    if (parts.length === 1) changes.parallelism = value;
    else {
      const base = await proposeWorkerAdoption(project, {});
      const parallelism = structuredClone(base.before.parallelism ?? {});
      let node: Record<string, any> = parallelism;
      for (const part of parts.slice(1, -1)) {
        if (!Object.hasOwn(node, part) || !node[part] || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
      }
      node[parts.at(-1)!] = value;
      changes.parallelism = parallelism;
    }
  }
  if (!Object.keys(changes).length) throw new Error('Proposal requires --parallelism FILE or --worker-selection FILE');
  const proposal = await proposeWorkerAdoption(project, changes, { signal });
  const file = resolve(cwd, flags.get('--propose')!);
  if (proposal.inputs.some(input => input.file === file) || file.startsWith(workerWriteLock(project))) throw new Error('Proposal output must be separate from activation inputs and recovery files');
  await atomicConfigWrite(file, JSON.stringify(proposal, null, 2) + '\n');
  console.log(JSON.stringify(proposal, null, 2));
  return true;
}
