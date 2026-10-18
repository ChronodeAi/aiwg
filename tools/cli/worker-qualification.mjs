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
      const result = await host.recordWorkerInstallation(driver, { cli: row.cli, installation,
        binding: { cliVersion: row.installedVersion, profile, accountScope,
          endpointFingerprint: `local-cli:${row.cli}`, identityEvidence: 'runtime-configured' },
        modelObservations: { provider: adapter.provider, source: 'native', observedAt: observed?.observedAt ?? verifiedAt,
          runtimeVersion: row.installedVersion, accountScope: 'local-account', accountBinding: accountScope, models: approvedModels } });
      if (result.status !== 'ENABLED') throw new Error(result.reason);
      results.push({ cli: row.cli, status: 'qualified', models: approvedModels.map(model => model.id),
        ...(missing.length ? { warning: `No exact current model observations for ${missing.join(', ')}. Refresh model discovery before qualifying again.` } : {}) });
    } catch (error) { results.push({ cli: row.cli, status: 'failed', message: error.message }); }
  }
  return { status: !ready.length || results.some(result => result.status === 'failed') ? 'failed'
    : results.some(result => result.warning) ? 'partial' : 'recorded', targets, storeChanges, results };
}
