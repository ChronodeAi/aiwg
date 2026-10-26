import { normalizeAiwgConfigCandidate } from './config-normalization.js';
// Reviews and atomically activates the existing worker policy pair with full-copy recovery.
import { readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigLoader } from '../models/config-loader.js';
import { validateUserProjectModelConfig } from '../models/provider-policy.js';
import type { UserProjectConfig } from '../models/types.js';
import { emptyConfig, getConfigPath, workerActivationDigests, workerConfigDigest, validateParallelismConfig, type AiwgConfig, type ParallelismConfig } from './aiwg-config.js';
import { projectControlPath, resolveProjectAiwgDir } from './project-artifacts.js';
import { acquireWorkerWriteLock, reclaimWorkerWriteLock, atomicConfigWrite, runWorkerMaintenance } from './worker-write.js';

interface Input { file: string; bytes: string | null; digest: string }
export interface WorkerPair { parallelism: ParallelismConfig | null; workerSelection: unknown }
export interface WorkerProposal {
  project: string;
  baseRevision: number;
  inputs: Input[];
  before: WorkerPair;
  after: WorkerPair;
  digest: string;
}
export type AdoptionAuthority = { digest: string } | { project: string; revision: number; fields: string[] };
export interface AdoptionOptions {
  aiwgHome?: string;
  signal?: AbortSignal;
  /** Trusted embedding hooks, never module paths supplied by proposals or CLI flags. */
  regenerate?: (project: string, config: AiwgConfig) => Promise<void>;
  checkpoint?: (step: string) => Promise<void>;
}
const json = (input: Input): any => input.bytes === null ? null : JSON.parse(input.bytes);
async function capture(file: string): Promise<Input> {
  let bytes: string | null = null;
  try { bytes = await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { file: resolve(file), bytes, digest: workerConfigDigest(bytes) };
}
const revisionPath = (project: string) => projectControlPath(project, 'aiwg.config.apply-lock.revision.json');
async function adoptionRevision(project: string, activationRevision = 0): Promise<number> {
  const input = await capture(revisionPath(project));
  const revision = input.bytes === null ? 0 : json(input).revision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid adoption revision');
  return Math.max(revision, activationRevision);
}
async function inventory(project: string, options: AdoptionOptions): Promise<Input[]> {
  const locations = new ConfigLoader(project, options).getLocations();
  const compatibility = join(resolveProjectAiwgDir(project), 'aiwg.config');
  const files = [getConfigPath(project), locations.projectConfig, locations.userConfig, locations.aiwgDefault];
  if (!files.includes(compatibility)) {
    // The config writer synchronizes a compatibility copy when its directory is reachable.
    try { await access(resolveProjectAiwgDir(project)); files.push(compatibility); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return Promise.all([...new Set(files.map(file => resolve(file)))].map(capture));
}
const pair = (config: AiwgConfig, models: any): WorkerPair => {
  const parallelism = structuredClone(config.parallelism ?? null);
  if (parallelism) delete parallelism.activation;
  return { parallelism, workerSelection: structuredClone(models?.defaults?.workerSelection ?? null) };
};
function candidate(inputs: Input[], after?: WorkerPair) {
  const configInput = [inputs[0], ...inputs.slice(4)].find(input => input.bytes !== null);
  const config = normalizeAiwgConfigCandidate(configInput ? json(configInput) : emptyConfig());
  const models: UserProjectConfig = json(inputs[1]) ?? {};
  if (after) {
    config.parallelism = structuredClone(after.parallelism ?? undefined);
    models.defaults ??= {};
    if (after.workerSelection === null) delete models.defaults.workerSelection;
    else models.defaults.workerSelection = structuredClone(after.workerSelection) as NonNullable<UserProjectConfig['defaults']>['workerSelection'];
  }
  return { config, models };
}
async function validate(project: string, config: AiwgConfig, models: UserProjectConfig, options: AdoptionOptions) {
  const errors = validateParallelismConfig(config.parallelism);
  const validation = validateUserProjectModelConfig(models);
  if (errors.length || !validation.valid) throw new Error([...errors, ...validation.diagnostics.map(item => item.message)].join('; '));
  const loader = new ConfigLoader(project, { aiwgHome: options.aiwgHome, workerCandidate: { projectModels: models } });
  await loader.load(config.parallelism);
  return { ...workerActivationDigests(config), ...loader.getInputDigests()! };
}
export async function proposeWorkerAdoption(project: string, changes: Partial<WorkerPair>, options: AdoptionOptions = {}): Promise<WorkerProposal> {
  project = resolve(project);
  const inputs = await inventory(project, options);
  validateRetainedCopies(inputs);
  const { config, models } = candidate(inputs);
  await validate(project, config, models, options);
  const before = pair(config, models);
  const after = { ...before, ...structuredClone(changes) };
  if (after.parallelism?.activation !== undefined) throw new Error('Activation markers are produced by apply, never by proposals');
  const next = candidate(inputs, after);
  await validate(project, next.config, next.models, options);
  const proposal = { project, baseRevision: await adoptionRevision(project, config.parallelism?.activation?.revision), inputs, before, after };
  return { ...proposal, digest: workerConfigDigest(proposal) };
}
function changedFields(before: any, after: any, pointer = ''): string[] {
  if (workerConfigDigest(before) === workerConfigDigest(after)) return [];
  const present = [before, after].filter(value => value !== undefined && value !== null);
  if (present.length && present.every(value => typeof value === 'object' && !Array.isArray(value))) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    if (!keys.length) return [pointer];
    return keys.flatMap(key => changedFields(before?.[key], after?.[key], `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [pointer];
}
function authorize(proposal: WorkerProposal, authority?: AdoptionAuthority) {
  const { digest, ...body } = proposal;
  if (workerConfigDigest(body) !== digest) throw new Error('Proposal digest mismatch; review again');
  if (authority && 'digest' in authority && authority.digest === digest) return;
  if (authority && 'fields' in authority && authority.project === proposal.project && authority.revision === proposal.baseRevision
    && Array.isArray(authority.fields) && authority.fields.length && authority.fields.every(field => typeof field === 'string' && /^\/(parallelism|workerSelection)(\/[^/]+)*$/.test(field) && field !== '/parallelism/activation' && !field.startsWith('/parallelism/activation/'))
    && changedFields(proposal.before, proposal.after).every(field => authority.fields.some(scope => field === scope || field.startsWith(`${scope}/`)))) return;
  throw new Error('Worker adoption requires the exact proposal digest or standing authorization for every changed field and base revision');
}
function validateRetainedCopies(inputs: Input[]) {
  const canonical = [inputs[0], ...inputs.slice(4)].find(input => input.bytes !== null);
  for (const copy of inputs.slice(4)) {
    if (copy.bytes !== null && workerConfigDigest(json(copy)) !== workerConfigDigest(canonical && json(canonical))) throw new Error(`Compatibility config diverges from the canonical validated copy: ${copy.file}`);
  }
}
async function recheck(proposal: WorkerProposal, options: AdoptionOptions, checkRevision = true) {
  const current = await inventory(proposal.project, options);
  if (workerConfigDigest(current) !== workerConfigDigest(proposal.inputs)) throw new Error('Stale proposal: input bytes/digests or participating copies changed');
  const { config, models } = candidate(current);
  if ((checkRevision && await adoptionRevision(proposal.project, config.parallelism?.activation?.revision) !== proposal.baseRevision) || workerConfigDigest(pair(config, models)) !== workerConfigDigest(proposal.before)) throw new Error('Stale proposal: base revision or reviewed pair changed');
  return current;
}
export async function regenerateWorkerGuidance(project: string, config: AiwgConfig): Promise<void> {
  const { generate, discoverDeployedArtifacts } = await import('../smiths/context-pipeline/index.js');
  const { getProviderContextDiscoveryPathStrings } = await import('../providers/provider-definitions.js');
  const providers = [...new Set([...(config.providers ?? []), ...Object.values(config.installed ?? {}).flatMap(entry => Object.keys(entry.deployedTo ?? {}))])];
  if (!providers.length) throw new Error('Cannot regenerate guidance: configure at least one provider');
  for (const provider of providers) {
    const paths = getProviderContextDiscoveryPathStrings(provider);
    if (!paths) throw new Error(`Cannot regenerate guidance for ${provider}`);
    const sections = await discoverDeployedArtifacts(project, paths);
    const result = await generate({ provider: provider as import('../agents/types.js').Platform, projectPath: project, sections, detectExistingFiles: true });
    if (result.warnings.length) throw new Error(`Guidance regeneration for ${provider}: ${result.warnings.join('; ')}`);
  }
}
export async function applyWorkerAdoption(project: string, proposal: WorkerProposal, authority?: AdoptionAuthority, options: AdoptionOptions = {}): Promise<void> {
  if (proposal.project !== resolve(project)) throw new Error('Proposal belongs to a different project');
  authorize(proposal, authority);
  if (proposal.after.parallelism?.activation !== undefined || workerConfigDigest(Object.keys(proposal.after).sort()) !== workerConfigDigest(['parallelism', 'workerSelection'])) throw new Error('Proposal exceeds the worker policy pair');
  // Reject staleness before writing even the lock or recovery record.
  await recheck(proposal, options);
  const lock = await acquireWorkerWriteLock(project, true, proposal.digest);
  const write = (file: string, content: string) => atomicConfigWrite(file, content, lock.assertOwned);
  let keepBlocked = false;
  let regenerationStarted = false;
  try {
    await options.checkpoint?.('locked');
    lock.assertOwned();
    await runWorkerMaintenance(async () => {
      const inputs = await recheck(proposal, options);
      validateRetainedCopies(inputs);
      const previous = candidate(inputs);
      await validate(project, previous.config, previous.models, options);
      const next = candidate(inputs, proposal.after);
      const digests = await validate(project, next.config, next.models, options);
      const configCopies = [inputs[0], ...inputs.slice(4)];
      // Keep the validated bytes durably before the first participating write.
      await write(join(lock.path, 'recovery.json'), JSON.stringify({ proposal, inputs }, null, 2));
      await options.checkpoint?.('blocked');
      lock.assertOwned();
      options.signal?.throwIfAborted();
      await recheck(proposal, options);
      if (next.config.parallelism?.worker_mode === 'managed') {
        next.config.parallelism.activation = { ...digests, revision: proposal.baseRevision + 1,
          snapshotRef: proposal.digest, ...(previous.config.parallelism?.activation ? { previousRef: previous.config.parallelism.activation.snapshotRef } : {}) };
      }
      const configBytes = JSON.stringify(next.config, null, 2) + '\n';
      const modelsBytes = JSON.stringify(next.models, null, 2) + '\n';
      try {
        await write(inputs[1].file, modelsBytes);
        await options.checkpoint?.('models');
        options.signal?.throwIfAborted();
        for (const [index, input] of configCopies.entries()) {
          await write(input.file, configBytes);
          await options.checkpoint?.(`config:${index}`);
          options.signal?.throwIfAborted();
        }
        const check = async () => {
          lock.assertOwned();
          const current = await inventory(project, options);
          const expected = inputs.map(input => ({ ...input, bytes: input.file === inputs[1].file ? modelsBytes : configCopies.some(copy => copy.file === input.file) ? configBytes : input.bytes }));
          if (current.length !== expected.length || current.some((input, index) => input.file !== expected[index].file || input.bytes !== expected[index].bytes)) throw new Error('Activation copies or model inputs changed during apply');
          const actual = await validate(project, next.config, next.models, options);
          if (workerConfigDigest(actual) !== workerConfigDigest(digests)) throw new Error('Activation digest verification failed');
        };
        await check();
        await options.checkpoint?.('activation');
        options.signal?.throwIfAborted();
        lock.assertOwned();
        regenerationStarted = true;
        await (options.regenerate ?? regenerateWorkerGuidance)(project, next.config);
        await options.checkpoint?.('regenerated');
        options.signal?.throwIfAborted();
        await check();
        await write(revisionPath(project), JSON.stringify({ revision: proposal.baseRevision + 1 }) + '\n');
        await options.checkpoint?.('committed');
        lock.assertOwned();
      } catch (error) {
        const failures: string[] = [];
        // Attempt EVERY owned copy, including a write that may have renamed then thrown.
        for (const input of [inputs[1], ...configCopies]) {
          try {
            lock.assertOwned();
            if (input.bytes === null) await rm(input.file, { force: true });
            else await write(input.file, input.bytes);
          } catch (restoreError) { failures.push(`${input.file}: ${restoreError}`); }
        }
        try { await recheck(proposal, options); await validate(project, previous.config, previous.models, options); }
        catch (restoreError) { failures.push(`restored pair validation: ${restoreError}`); }
        // Regenerated guidance may be partial; keep submissions closed until explicit recovery.
        keepBlocked = failures.length > 0 || regenerationStarted;
        throw new Error(`Worker adoption failed: ${error}. ${keepBlocked ? `Dispatch remains closed at ${lock.path}; ${failures.join('; ') || 'guidance consistency requires recovery'}` : 'All participating copies restored and revalidated.'}`);
      }
    });
  } finally {
    // A displaced owner must neither restore bytes nor remove a successor's exclusion.
    let owned = true;
    try { lock.assertOwned(); } catch { owned = false; }
    if (owned) await lock.release(keepBlocked);
  }
}

/** Recover an interrupted apply from its retained, authorized bytes; never infer approval. */
export async function recoverWorkerAdoption(project: string, authority: AdoptionAuthority, options: AdoptionOptions = {}): Promise<void> {
  const lock = await reclaimWorkerWriteLock(project);
  const write = (file: string, content: string) => atomicConfigWrite(file, content, lock.assertOwned);
  let recovered = false;
  try {
    await options.checkpoint?.('recovery:owned');
    await runWorkerMaintenance(async () => {
      lock.assertOwned();
      const record = await capture(join(lock.path, 'recovery.json'));
      if (record.bytes === null) {
        // Publication precedes recovery.json, and recovery.json precedes every pair write.
        // A missing record therefore needs validation, never speculative restoration.
        const inputs = await inventory(project, options);
        validateRetainedCopies(inputs);
        const current = candidate(inputs);
        await validate(project, current.config, current.models, options);
        options.signal?.throwIfAborted();
        lock.assertOwned();
        await (options.regenerate ?? regenerateWorkerGuidance)(project, current.config);
        if (workerConfigDigest(await inventory(project, options)) !== workerConfigDigest(inputs)) throw new Error('Inputs changed during incomplete-initialization recovery');
        await validate(project, current.config, current.models, options);
      } else {
        const retained = json(record) as { proposal: WorkerProposal; inputs: Input[] };
        const proposal = retained.proposal;
        if (proposal.project !== resolve(project)) throw new Error('Recovery belongs to a different project');
        authorize(proposal, authority);
        if (workerConfigDigest(retained.inputs) !== workerConfigDigest(proposal.inputs)) throw new Error('Recovery bytes do not match the reviewed inputs');
        const inputs = await inventory(project, options);
        if (workerConfigDigest(inputs.map(input => input.file)) !== workerConfigDigest(proposal.inputs.map(input => input.file))) throw new Error('Recovery copy inventory changed');
        validateRetainedCopies(proposal.inputs);
        options.signal?.throwIfAborted();
        const previous = candidate(proposal.inputs);
        await validate(project, previous.config, previous.models, options);
        const failures: string[] = [];
        for (const input of [proposal.inputs[1], proposal.inputs[0], ...proposal.inputs.slice(4)]) {
          try {
            lock.assertOwned();
            if (input.bytes === null) await rm(input.file, { force: true });
            else await write(input.file, input.bytes);
          } catch (error) { failures.push(`${input.file}: ${error}`); }
        }
        if (failures.length) throw new Error(failures.join('; '));
        await recheck(proposal, options, false);
        lock.assertOwned();
        await (options.regenerate ?? regenerateWorkerGuidance)(project, previous.config);
        await recheck(proposal, options, false);
      }
      options.signal?.throwIfAborted();
      lock.assertOwned();
      await options.checkpoint?.('recovery:verified');
      lock.assertOwned();
      recovered = true;
    });
  } catch (error) { throw new Error(`Recovery failed; dispatch remains closed at ${lock.path}: ${error}`); }
  finally {
    let owned = true;
    try { lock.assertOwned(); } catch { owned = false; }
    if (owned) await lock.release(!recovered);
  }
}
