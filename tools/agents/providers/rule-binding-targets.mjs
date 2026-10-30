/** Discover and bind rule targets from indexed and currently deployed bundle sources. */
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { contentHash } from './base.mjs';
const { RULE_BINDING_TYPES } = await importImpl(import.meta.url, 'rules/activation.mjs');

function isPackageSource(directory, root) {
  return path.relative(root, directory).split(path.sep).slice(0, 2).join('/') === 'agentic/code';
}

function bindingBundleRoot(file, root) {
  // Packaged contracts retain their established project/user override policy.
  if (isPackageSource(file, root)) return undefined;
  let directory = path.dirname(file);
  while (path.dirname(directory) !== directory) {
    if (['rules', 'behaviors'].includes(path.basename(directory))) return path.dirname(directory);
    directory = path.dirname(directory);
  }
  return undefined;
}

export async function resolveDeliveryRuleBindings(opts, rules, configs, root, packageRelations) {
  const bindings = new Map();
  const targets = [];
  const targetKeys = new Set();
  if (rules.some(rule => Object.values(rule.bound_to).some(ids => ids.length))) {
    const { loadLocalCapabilityEntries, loadLocalOverrideCapabilityEntries, createRuleBindingTargetResolver } = await importImpl(import.meta.url, 'artifacts/query-engine.js');
    // Framework graph paths are package-relative; project graph paths belong
    // to the queried project. Normalize before merging so one source cannot
    // become two apparently ambiguous targets after a source-index rebuild.
    const indexEntries = new Map();
    const entryPaths = new Map();
    const loadEntries = (cwd, overridesOnly = false) => (overridesOnly
      ? loadLocalOverrideCapabilityEntries(cwd)
      : loadLocalCapabilityEntries(cwd, undefined, indexEntries)).map(entry => {
      const anchor = entry.path.startsWith('agentic/code/') ? root : cwd;
      const key = `${anchor}\0${entry.path}`;
      if (!entryPaths.has(key)) entryPaths.set(key, path.resolve(anchor, entry.path));
      const resolvedPath = entryPaths.get(key);
      // Canonical IDs hash the indexed package-relative path. Keep it through
      // resolution; the selected target is anchored to root below.
      return { ...entry, path: entry.path.startsWith('agentic/code/') ? entry.path
        : opts.mapInputPath ? opts.mapInputPath(resolvedPath) : resolvedPath };
    });
    let rebuilt = false;
    const cacheDir = process.env.AIWG_RULE_BINDING_INDEX_CACHE;
    const cacheFile = cacheDir && path.join(cacheDir, `${contentHash(opts.logicalInputPath ? opts.logicalInputPath(root) : root)}.json`);
    const buildSourceEntries = async (refresh = false) => {
      if (!refresh && cacheFile) {
        try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).map(entry => ({ ...entry, path: path.isAbsolute(entry.path) && opts.mapInputPath ? opts.mapInputPath(entry.path) : entry.path })); }
        catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
      }
      const { collectRuleBindingEntries } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
      const sourceEntries = await collectRuleBindingEntries(root,
        root === opts.srcRoot && !fs.existsSync(path.join(root, 'agentic')) ? '.' : 'agentic/code');
      rebuilt = true;
      const entries = sourceEntries.map(entry => ({ ...entry, path: entry.path.startsWith('agentic/code/')
        ? entry.path : path.resolve(root, entry.path) }));
      if (cacheFile) {
        fs.mkdirSync(cacheDir, { recursive: true });
        // Workers may publish the same immutable source snapshot concurrently.
        const temporary = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(entries.map(entry => ({ ...entry, path: opts.logicalInputPath ? opts.logicalInputPath(entry.path) : entry.path }))));
        fs.renameSync(temporary, cacheFile);
      }
      return entries;
    };
    const localEntries = opts.bindingEntries || loadEntries(opts.target, Boolean(packageRelations));
    let entries = [...localEntries];
    if (!opts.bindingEntries) {
      // The validated package table is authoritative for its exact source digest.
      // Keep the canonical resolver for aliases, local overrides and ambiguity.
      const sourceEntries = packageRelations
        ? Object.values(packageRelations.index.artifacts).map(entry => ({ ...entry,
          indexScope: 'packaged', indexGraph: 'framework' }))
        : loadEntries(root);
      // A relocated project graph may also be visible while querying the
      // package root. Keep its project-anchored instance only.
      const uniqueSources = sourceEntries.filter(entry => !(opts.sharedProjectGraph &&
        entry.path.startsWith(path.join(root, '.aiwg') + path.sep) &&
        localEntries.some(local => local.type === entry.type && local.name === entry.name)));
      entries.push(...uniqueSources);
      if (!sourceEntries.length) entries.push(...await buildSourceEntries());
    }
    // Include first-time invocations before their installed entry is persisted.
    // Scan only selected bundle roots; use the existing metadata extractor without
    // creating a full index or treating a stale project index as authoritative.
    if (!opts.bindingEntries) {
      const selectedRoots = new Set([opts.srcRoot, ...(opts.additionalSources || []),
        ...rules.map(rule => bindingBundleRoot(rule.file, root)).filter(Boolean),
        ...Object.values(configs.project.installed || {}).filter(entry => entry.localPath)
          .map(entry => path.resolve(opts.target, entry.localPath))]);
      const { collectRuleBindingEntries } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
      for (const localRoot of selectedRoots) {
        if (localRoot === root || isPackageSource(localRoot, root) || !fs.existsSync(localRoot)) continue;
        const scoped = (await collectRuleBindingEntries(localRoot, '.'))
          .map(entry => ({ ...entry, path: path.resolve(localRoot, entry.path) }));
        localEntries.push(...scoped);
        entries.push(...scoped);
      }
    }
    // A stored index can predate the source tree (edge/dev checkouts). Rebuild once from source
    // before reporting a binding target as missing.
    const resolvedTargets = new Map();
    const identityOptions = { cwd: opts.target, packageRoot: root, logicalPath: opts.logicalInputPath };
    let resolveBinding = createRuleBindingTargetResolver(entries, identityOptions);
    const resolveTarget = async (type, id, bundleRoot) => {
      const key = `${bundleRoot}:${type}:${id}`;
      if (resolvedTargets.has(key)) return resolvedTargets.get(key);
      let target;
      try { target = resolveBinding(type, id, bundleRoot); }
      catch (error) {
        if (packageRelations || rebuilt || opts.bindingEntries || !/^Missing /.test(error.message)) throw error;
        indexEntries.clear();
        entryPaths.clear();
        entries = [...localEntries, ...await buildSourceEntries(true)];
        rebuilt = true;
        resolveBinding = createRuleBindingTargetResolver(entries, identityOptions);
        target = resolveBinding(type, id, bundleRoot);
        // A rebuild replaces the input set for every lookup.
        resolvedTargets.clear();
      }
      resolvedTargets.set(key, target);
      return target;
    };
    for (const rule of rules.filter(rule => rule.tagged)) {
      for (const [key, type] of Object.entries(RULE_BINDING_TYPES)) {
        for (const id of rule.bound_to[key]) {
          const target = await resolveTarget(type, id, bindingBundleRoot(rule.file, root));
          const source = path.isAbsolute(target.path) ? target.path : path.resolve(target.path.startsWith('agentic/code/') ? root : opts.target, target.path);
          if (!fs.existsSync(source)) throw new Error(`${rule.file}: binding target content missing: ${source}`);
          bindings.set(source, [...(bindings.get(source) || []), rule]);
          const key = `${target.type}:${source}`;
          if (!targetKeys.has(key)) {
            targetKeys.add(key);
            targets.push({ ...target, source });
          }
        }
      }
    }
  }
  return { bindings, targets };
}
