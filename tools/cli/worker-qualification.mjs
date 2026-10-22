/** Explicit operator approval of the installed direct CLI baseline (decision 17). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { importImpl } from '../_resolve-impl.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function executablePath(executable) {
  if (path.isAbsolute(executable)) return fs.realpath(executable);
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const filename = path.resolve(directory, executable);
    try { await fs.access(filename, 1); return await fs.realpath(filename); } catch { /* Next PATH entry. */ }
  }
  throw new Error(`Executable is unavailable: ${executable}`);
}

/** Only the shipped package selects driver modules; project config cannot supply code. */
async function installedDriver(packageRoot, adapter) {
  const { normalizeProviderDefinitionId } = await importImpl(import.meta.url, 'providers/provider-definitions.js');
  const id = normalizeProviderDefinitionId(adapter.provider);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Unsupported bundled worker driver');
  const modulePath = `tools/ralph-external/lib/${id}-adapter.mjs`;
  const filename = path.join(packageRoot, modulePath);
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const source = await fs.readFile(filename);
  adapter.adapterVersion = pkg.version;
  adapter.runtimeDriver = `installed:${adapter.id}`;
  const modules = [{ reference: adapter.runtimeDriver, packageRoot, packageName: pkg.name,
    packageVersion: pkg.version, modulePath, interfaceVersion: 1, sha256: digest(source),
    adapterIds: [adapter.id], platforms: ['linux'] }];
  // Bind the bundled driver's local dependency closure, including shared owners.
  const runtimeFiles = new Set();
  async function visit(file) {
    file = await fs.realpath(file);
    if (runtimeFiles.has(file)) return;
    if (!file.startsWith(`${packageRoot}${path.sep}`)) throw new Error('Worker dependency escapes installed package');
    runtimeFiles.add(file);
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+\.mjs)['"]/g)) {
      await visit(path.resolve(path.dirname(file), match[1]));
    }
  }
  await visit(filename);
  return { modules, runtimeFiles: [...runtimeFiles] };
}

/** Exercise the installed renderer with synthetic input; no files or workers are created. */
export async function checkWorkerInvocationBuilds({ projectDir, config, policy, cli, driver, observations }) {
  const { buildWorkerInvocationTransport, resolveWorkerEffectiveHealth, workerInvocationDiagnostic,
    WorkerInvocationCheckError } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { workerModelKey } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const checks = [];
  const workdir = await fs.realpath(projectDir);
  const adapter = driver.qualification.adapter;
  const profileRef = driver.qualification.installation.profile;
  for (const [groupId, group] of Object.entries(config.parallelism.groups ?? {})) {
    for (const member of group.members) {
      if (member.cli !== cli || member.enabled === false || config.parallelism.clis?.[cli]?.enabled === false) continue;
      const row = observations?.models.find(row => row.id === member.model);
      if (!row?.worker) continue; // Missing observations are reported separately by qualification.
      for (const role of member.roles) {
        const effort = row.worker.effortSupport === 'not-applicable' ? null : policy?.roleGuidance?.[role]?.initialEffort ?? null;
        const check = { cli, group: groupId, member: member.id, role, model: member.model, effort, workdir, status: 'passed', diagnostics: [] };
        try {
          if (workdir !== await fs.realpath(driver.qualification.installation.cwd)) {
            throw new WorkerInvocationCheckError('OG_CONFIG_REFERENCE', 'qualified_workspace_mismatch');
          }
          const selected = { group: groupId, member: member.id, cli, model: row.apiModelId, inferenceProvider: row.llmProvider,
            family: row.worker.family, effort: { support: effort === null ? 'not-applicable' : 'explicit', value: effort },
            profileRef, qualificationDigest: adapter.qualification.fixtureDigest };
          const limits = { tokens: 50000, costUsd: null, wallSeconds: 900, maxAttempts: 3 };
          const health = resolveWorkerEffectiveHealth(config.parallelism.health, { role, effort,
            modelKey: workerModelKey(row.llmProvider, row.apiModelId), profileRef, wallSeconds: limits.wallSeconds,
            stepEnforcement: config.parallelism.health?.requireStepCap
              ? adapter.invocationProfiles[profileRef].controls.stepCap.support : 'unavailable' });
          await buildWorkerInvocationTransport(driver, { selected, permissions: group.execution ?? {}, cwd: workdir,
            briefPath: path.join(workdir, '.worker-probe', 'brief.txt'), brief: 'Check worker invocation.',
            finalPath: path.join(workdir, '.worker-probe', 'result.json'), limits, health });
        } catch (error) {
          check.status = 'blocked';
          check.diagnostics.push(workerInvocationDiagnostic(error, '/invocation/buildInvocation', 'OG_ADAPTER_UNQUALIFIED'));
        }
        checks.push(check);
      }
    }
  }
  return checks;
}

/** Recheck existing approval through the same installation owner as models resolve. */
export async function checkRecordedWorkerInvocationBuilds({ projectDir, config, registry, workers }) {
  const host = await importImpl(import.meta.url, 'models/worker-installation.mjs');
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const { workerInvocationDiagnostic } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { WorkerPolicyError } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const policy = (await new ConfigLoader(projectDir).load(config.parallelism)).defaults.workerSelection;
  // No approval yet: the version-only finding remains an installation result.
  const store = path.join(process.env.AIWG_CONFIG || path.join(homedir(), '.config/aiwg'), 'worker-installations.json');
  if (!await fs.access(store).then(() => true, () => false)) return [];
  try {
    const loaded = await host.loadRecordedWorkerInstallations({ registry, cwd: projectDir, policy, parallelism: config.parallelism });
    const checks = [];
    for (const worker of workers.filter(worker => worker.ready)) {
      if (!loaded.drivers[worker.cli]) {
        checks.push({ cli: worker.cli, workdir: projectDir, status: 'blocked', diagnostics: [workerInvocationDiagnostic(
          new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', 'Trusted installation qualification is required'), `/parallelism/clis/${worker.cli}`)] });
        continue;
      }
      checks.push(...await checkWorkerInvocationBuilds({ projectDir, config, policy, cli: worker.cli,
        driver: loaded.drivers[worker.cli], observations: loaded.observations[worker.cli] }));
    }
    return checks;
  } catch (error) {
    return workers.filter(worker => worker.ready).map(worker => ({ cli: worker.cli, workdir: projectDir, status: 'blocked',
      diagnostics: [workerInvocationDiagnostic(error, '/parallelism/clis', 'OG_ADAPTER_UNQUALIFIED')] }));
  }
}

export async function qualifyProbedWorkers({ projectDir, packageRoot, config, registry, section,
  yes = false, dryRun = false }) {
  const host = await importImpl(import.meta.url, 'models/worker-installation.mjs');
  const { WORKER_OPERATOR_APPROVAL } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const { ConfigLoader } = await importImpl(import.meta.url, 'models/config-loader.js');
  const { workerConfigDigest } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const discovery = await importImpl(import.meta.url, 'models/model-discovery.js');
  if (!dryRun && !yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Qualification requires confirmation. Rerun aiwg doctor --probe-workers --qualify --yes (or use --dry-run).');
  }
  const models = await new ConfigLoader(projectDir).load(config.parallelism);
  const policy = models.defaults.workerSelection;
  const ready = section.installFindings.filter(row => row.readiness === 'ready');
  const targets = ready.map(row => ({ cli: row.cli, version: row.installedVersion, executable: row.executable,
    accountScope: config.parallelism.clis?.[row.cli]?.accountScope ?? 'local-account',
    models: Object.values(config.parallelism.groups ?? {}).flatMap(group => group.members)
      .filter(member => member.cli === row.cli && member.enabled !== false)
      .map(member => ({ model: member.model, roles: member.roles })) }));
  if (!ready.length) return { status: 'failed', targets, results: [], message: 'No configured worker CLIs probed ready; no qualification was recorded.' };
  const storeChanges = await host.prepareWorkerInstallationStore({ workerWritableRoots: [projectDir] });
  if (!dryRun && !yes) {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await terminal.question(`Record installation and configured model/role approval for ${JSON.stringify(targets)} and apply store changes ${JSON.stringify(storeChanges)}? This trusts the local CLI; no live model or sandbox attestation is performed. [y/N]: `);
      if (!/^y(es)?$/i.test(answer.trim())) return { status: 'declined', targets, storeChanges, results: [] };
    } finally { terminal.close(); }
  }
  if (dryRun) return { status: 'dry-run', targets, storeChanges, results: [] };
  await host.prepareWorkerInstallationStore({ workerWritableRoots: [projectDir], apply: true });
  const results = [];
  for (const row of ready) {
    try {
      const cliConfig = config.parallelism.clis?.[row.cli] ?? {};
      const [namespace = 'providers', id = row.cli] = (cliConfig.adapter ?? `providers:${row.cli}`).split(':');
      const provider = registry.providers[id];
      const adapter = structuredClone(namespace === 'providers'
        ? provider?.workerAdapter ?? provider?.workerHealthAdapter : registry.workerAdapters?.[id]);
      if (!adapter || adapter.invocation.kind !== 'process') throw new Error('No bundled process driver');
      const profile = cliConfig.invocationProfile ?? row.profile ?? 'direct-shell';
      if (adapter.invocationProfiles?.[profile]?.transport !== 'shell') throw new Error('Qualification requires a direct shell profile');
      const verifiedAt = new Date().toISOString();
      adapter.qualification = { status: 'qualified', fixtureDigest: await host.workerNegativeFixtureDigest(),
        verifiedAt, evidenceRef: WORKER_OPERATOR_APPROVAL };
      const trusted = await installedDriver(packageRoot, adapter);
      const loading = structuredClone(registry);
      for (const entry of Object.values(loading.providers)) delete entry.workerAdapter;
      loading.workerAdapters = {};
      if (namespace === 'providers') loading.providers[id].workerAdapter = adapter;
      else loading.workerAdapters[id] = adapter;
      await host.loadInstalledWorkerAdapters({ registry: loading, modules: trusted.modules, workerWritableRoots: [projectDir] });
      const driver = host.createProvider(adapter.id);
      const executable = await executablePath(row.executable);
      const accountScope = cliConfig.accountScope ?? 'local-account';
      let observed;
      // These are existing read-only catalog interfaces, never inference calls.
      if (adapter.provider === 'codex') observed = await discovery.discoverCodexDebugModels(executable, undefined, { accountBinding: accountScope, runtimeVersion: row.installedVersion });
      else if (adapter.provider === 'muse') observed = await discovery.discoverMuseCatalogModels({ accountBinding: accountScope, runtimeVersion: row.installedVersion });
      // Other providers can reuse previously discovered observations. No auth files are read.
      if (!observed?.models?.length) {
        try {
          const cache = JSON.parse(await fs.readFile(path.join(homedir(), '.cache/aiwg/model-catalog.v1.json'), 'utf8'));
          observed = cache.discovery?.instances?.[row.cli] ?? cache.discovery?.providers?.[adapter.provider];
        } catch { /* No prior discovery. Installation approval can still be recorded. */ }
      }
      const configured = targets.find(target => target.cli === row.cli).models;
      const approvedModels = [];
      const missing = [];
      for (const model of new Set(configured.map(member => member.model))) {
        const found = observed?.models?.find(entry => entry.id === model && entry.apiModelId === model && entry.llmProvider && entry.worker);
        if (!found) { missing.push(model); continue; }
        const approved = structuredClone(found);
        // Keep catalog facts and their timestamps. Approval cannot renew stale discovery,
        // invent context limits/data policy, or upgrade backend identity.
        if (approved.worker.runtimeVersion !== row.installedVersion || approved.worker.accountScope !== accountScope) {
          missing.push(model); continue;
        }
        approved.worker.cliId = row.cli;
        approved.worker.endpointFingerprint = `local-cli:${row.cli}`;
        approved.worker.qualification = { status: 'qualified', roles: [...new Set(configured.filter(member => member.model === model).flatMap(member => member.roles))],
          verifiedAt, fixtureDigest: adapter.qualification.fixtureDigest, evidenceRef: WORKER_OPERATOR_APPROVAL };
        approved.worker.provenance.push({ fields: ['/qualification'], source: WORKER_OPERATOR_APPROVAL,
          kind: 'operator', observedAt: verifiedAt, digest: workerConfigDigest(approved.worker.qualification), confidence: 'reported' });
        approvedModels.push(approved);
      }
      const installation = { ...trusted, adapter, profile, cliVersion: row.installedVersion,
        executable, now: Date.now(), cwd: projectDir, workerWritableRoots: [projectDir], environment: Object.fromEntries(adapter.invocationProfiles[profile].envAllowlist
          .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
        effectiveConfigDigest: workerConfigDigest(policy), accountScope, policy, permissions: {},
        boundary: { kind: 'native', identity: 'operator-approved-cli', digest: workerConfigDigest(adapter.invocation), controls: [] } };
      const scope = await host.inspectWorkerInstallation(driver, installation);
      installation.evidence = { scopeDigest: scope.scopeDigest, fixtureDigest: adapter.qualification.fixtureDigest,
        verifiedAt, evidenceRef: WORKER_OPERATOR_APPROVAL };
      const qualified = await host.qualifyWorkerInstallation(driver, installation);
      if (qualified.status !== 'ENABLED') throw new Error(qualified.reason);
      const invocationChecks = await checkWorkerInvocationBuilds({ projectDir, config, policy, cli: row.cli,
        observations: { models: approvedModels }, driver: {
          qualification: { adapter, installation },
          buildInvocation: async input => ({ argv: [executable, ...driver.buildWorkerArgs(input,
            adapter.invocationProfiles[profile], input.permissions)], stdin: adapter.invocation.stdin,
          envNames: Object.keys(installation.environment),
          ...(typeof driver.buildWorkerArtifacts === 'function' ? { artifacts: driver.buildWorkerArtifacts(input) } : {}) }),
        } });
      if (invocationChecks.some(check => check.status === 'blocked')) {
        results.push({ cli: row.cli, status: 'failed', invocationChecks });
        continue;
      }
      const result = await host.recordWorkerInstallation(driver, { cli: row.cli, installation,
        binding: { cliVersion: row.installedVersion, profile, accountScope,
          endpointFingerprint: `local-cli:${row.cli}`, identityEvidence: 'runtime-configured' },
        modelObservations: { provider: adapter.provider, source: 'native', observedAt: observed?.observedAt ?? verifiedAt,
          runtimeVersion: row.installedVersion, accountScope: 'local-account', accountBinding: accountScope, models: approvedModels } });
      if (result.status !== 'ENABLED') throw new Error(result.reason);
      results.push({ cli: row.cli, status: 'qualified', models: approvedModels.map(model => model.id), invocationChecks,
        ...(missing.length ? { warning: `No exact current model observations for ${missing.join(', ')}. Refresh model discovery before qualifying again.` } : {}) });
    } catch (error) { results.push({ cli: row.cli, status: 'failed', message: error.message }); }
  }
  return { status: !ready.length || results.some(result => result.status === 'failed') ? 'failed'
    : results.some(result => result.warning) ? 'partial' : 'recorded', targets, storeChanges, results };
}
