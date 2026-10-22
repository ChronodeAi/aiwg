/** Activation-selected deployment, shared by the six provider projections (#2939). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stringify } from 'yaml';
import { createHash, randomUUID } from 'node:crypto';
import { importImpl } from '../../_resolve-impl.mjs';
import {
  listMdFiles, discoverAddons, getFrameworksForMode, collectBehaviorDirs,
  resolveAiwgRoot, ruleEnforcementLevel, stripTriggersFromContent,
  addManagedMarker, contentHash, replaceBoundRulesBlock, deployEmulatedBehaviors, filterAgentFiles,
} from './base.mjs';

const { parseRuleFrontmatter, inferRuleActivation, RULE_BINDING_TYPES } = await importImpl(import.meta.url, 'rules/activation.mjs');
const { trackTemporaryDirectory } = await importImpl(import.meta.url, 'utils/temporary-directory.js');
const { loadRulePinConfigs, installedRuleCapabilities, resolveRulePins } = await importImpl(import.meta.url, 'rules/pins.mjs');
const { guardRulesInlineBudget } = await importImpl(import.meta.url, 'rules/inline-budget.mjs');
const { userConfigFile } = await importImpl(import.meta.url, 'config/user-config-dir.mjs');
const { resolveProjectAiwgDir } = await importImpl(import.meta.url, 'config/project-artifacts-runtime.mjs');
const PREPARATION_HOOK = Symbol.for('aiwg.provider-preparation-hook.v1');

export function installRuleDeploymentPreparationHook(hook) {
  if (!hook || typeof hook.scratch !== 'string' || !hook.inputPool || typeof hook.accept !== 'function' || globalThis[PREPARATION_HOOK]) {
    throw new Error('Invalid or already active rule deployment preparation hook');
  }
  globalThis[PREPARATION_HOOK] = hook;
  return () => { if (globalThis[PREPARATION_HOOK] === hook) delete globalThis[PREPARATION_HOOK]; };
}

export function isRuleDeploymentPreparationActive() {
  return Boolean(globalThis[PREPARATION_HOOK]);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  });
}
// Keep only digests in the transaction snapshot. Artifact stores and binary skill
// resources can be much larger than the provider output being changed.
function fileDigest(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
// Empty directories are part of workspace and skill-resource scaffolds too.
function promoteDirectories(source, destination, skip = () => false, prefix = '') {
  const entries = fs.readdirSync(source, { withFileTypes: true });
  if (!entries.length && !fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory() && !skip(rel)) {
      promoteDirectories(path.join(source, entry.name), path.join(destination, entry.name), skip, rel);
    }
  }
}
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const structural = file => /^(RULES-INDEX|RULES-ONDEMAND)\.(md|mdc)$/.test(path.basename(file));

/** Collect selected source contracts, before any tier filter or projection. */
export function collectDeploymentRuleSources(opts) {
  if (opts.ruleSources) return [...new Set([...opts.ruleSources, ...(opts.previousRuleSources || []).filter(file => fs.existsSync(file))])];
  const roots = [opts.srcRoot];
  for (const framework of getFrameworksForMode(opts.srcRoot, opts.mode)) roots.push(framework.path);
  for (const addon of discoverAddons(opts.srcRoot)) roots.push(addon.path);
  const files = [...(opts.previousRuleSources || []).filter(file => fs.existsSync(file)), ...roots.flatMap(root => listMdFiles(path.join(root, 'rules')))].filter(file => !structural(file));
  const behaviors = collectBehaviorDirs(opts.srcRoot).map(dir => path.join(dir, 'BEHAVIOR.md'));
  return [...new Set([...files, ...behaviors])];
}

export async function prepareRuleDelivery(opts) {
  const rules = collectDeploymentRuleSources(opts).map(file => {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseRuleFrontmatter(content);
    if (!parsed.valid) throw new Error(`${file}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
    const behavior = path.basename(file) === 'BEHAVIOR.md';
    const rule = { ...parsed.rule, file, content, body: parsed.body, behavior,
      name: behavior ? `behavior/${path.basename(path.dirname(file))}` : parsed.data.name || path.basename(file, '.md') };
    if (!rule.tagged) rule.activation = behavior ? 'kernel' : inferRuleActivation(ruleEnforcementLevel(content));
    for (const diagnostic of parsed.diagnostics) {
      console.warn(`${opts.logicalInputPath ? opts.logicalInputPath(file) : file}: ${diagnostic.code}: ${diagnostic.code === 'missing-activation' ? `Missing activation; inferred ${rule.activation} delivery (migration fallback).` : diagnostic.message}`);
    }
    return rule;
  });
  const configs = opts.pinConfigs || loadRulePinConfigs(opts.target, opts.config);
  const installed = installedRuleCapabilities(configs);
  const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  const { loadRelations, selectPrebuiltRelations } = await importImpl(import.meta.url, 'artifacts/relations.js');
  const packageRelations = selectPrebuiltRelations(root, opts.target).reader;
  const relations = packageRelations || loadRelations(opts.target) || loadRelations(root, opts.target);
  const ruleIdsByPath = new Map(Object.entries(relations?.index.rules || {}).map(([id, rule]) => [rule.path, id]));
  const pinRules = rules.map(rule => {
    const owner = rule.file.replaceAll('\\', '/').match(/(?:frameworks|addons|extensions|plugins)\/([^/]+)\//)?.[1];
    const local = Object.entries(configs.project.installed || {}).find(([, entry]) => entry.localPath && rule.file.startsWith(path.resolve(opts.target, entry.localPath) + path.sep))?.[0];
    const indexedPath = path.relative(root, rule.file);
    return { ...rule, id: ruleIdsByPath.get(indexedPath) || rule.file, path: rule.file, indexedPath,
      capability: local || owner || opts.capability, enforcement: ruleEnforcementLevel(rule.content) };
  });
  const pinned = resolveRulePins({ rules: pinRules, configs, installed, relations });
  for (const warning of pinned.warnings) console.warn(warning);
  const pinsByFile = new Map(pinned.rules.map(rule => [rule.file, rule]));
  for (const rule of rules) {
    const pin = pinsByFile.get(rule.file);
    if (!pin) continue;
    rule.canonicalActivation = rule.activation;
    rule.pinMatches = pin.matches;
    rule.pinned = true;
    rule.activation = 'kernel';
    // All pins use native kernel projection, including legacy untagged rules.
    rule.tagged = true;
  }
  const bindings = new Map();
  const targets = [];
  const targetKeys = new Set();
  if (rules.some(rule => Object.values(rule.bound_to).some(ids => ids.length))) {
    const { loadLocalCapabilityEntries, loadLocalOverrideCapabilityEntries, createRuleBindingTargetResolver } = await importImpl(import.meta.url, 'artifacts/query-engine.js');
    const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
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
      return { ...entry, path: opts.mapInputPath ? opts.mapInputPath(resolvedPath) : resolvedPath };
    });
    let rebuilt = false;
    const cacheDir = process.env.AIWG_RULE_BINDING_INDEX_CACHE;
    const cacheFile = cacheDir && path.join(cacheDir, `${contentHash(opts.logicalInputPath ? opts.logicalInputPath(root) : root)}.json`);
    const buildSourceEntries = async (refresh = false) => {
      if (!refresh && cacheFile) {
        try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).map(entry => ({ ...entry, path: opts.mapInputPath ? opts.mapInputPath(entry.path) : entry.path })); }
        catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
      }
      const indexTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-index-'));
      try {
        const { buildIndex } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
        await buildIndex(root, { scope: root === opts.srcRoot && !fs.existsSync(path.join(root, 'agentic')) ? '.' : 'agentic/code', outputDir: indexTemp, force: true, quiet: true });
        rebuilt = true;
        const index = JSON.parse(read(path.join(indexTemp, '.aiwg', '.index', 'metadata.json')));
        const entries = Object.values(index.entries).map(entry => ({ ...entry, path: path.resolve(root, entry.path) }));
        if (cacheFile) {
          fs.mkdirSync(cacheDir, { recursive: true });
          // Workers may publish the same immutable source snapshot concurrently.
          const temporary = `${cacheFile}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(entries.map(entry => ({ ...entry, path: opts.logicalInputPath ? opts.logicalInputPath(entry.path) : entry.path }))));
          fs.renameSync(temporary, cacheFile);
        }
        return entries;
      } finally { fs.rmSync(indexTemp, { recursive: true, force: true }); }
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
    // Project-local installed bundles are outside the package source index.
    // Reuse the existing binding index builder only for those source roots.
    if (!opts.bindingEntries) {
      for (const entry of Object.values(configs.project.installed || {})) {
        if (!entry.localPath) continue;
        const localRoot = path.resolve(opts.target, entry.localPath);
        if (localRoot === root || !fs.existsSync(localRoot)) continue;
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-local-rule-index-'));
        try {
          const { buildIndex } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
          await buildIndex(localRoot, { scope: '.', outputDir: temp, force: true, quiet: true });
          const index = JSON.parse(read(path.join(temp, '.aiwg', '.index', 'metadata.json')));
          const scoped = Object.values(index.entries).map(entry => ({ ...entry, path: path.resolve(localRoot, entry.path) }));
          localEntries.push(...scoped);
          entries.push(...scoped);
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      }
    }
    // A stored index can predate the source tree (edge/dev checkouts). Rebuild once from source
    // before reporting a binding target as missing.
    const resolvedTargets = new Map();
    let resolveBinding = createRuleBindingTargetResolver(entries);
    const resolveTarget = async (type, id) => {
      const key = `${type}:${id}`;
      if (resolvedTargets.has(key)) return resolvedTargets.get(key);
      let target;
      try { target = resolveBinding(type, id); }
      catch (error) {
        if (packageRelations || rebuilt || opts.bindingEntries || !/^Missing /.test(error.message)) throw error;
        indexEntries.clear();
        entryPaths.clear();
        entries = [...localEntries, ...await buildSourceEntries(true)];
        rebuilt = true;
        resolveBinding = createRuleBindingTargetResolver(entries);
        target = resolveBinding(type, id);
        // A rebuild replaces the input set for every lookup.
        resolvedTargets.clear();
      }
      resolvedTargets.set(key, target);
      return target;
    };
    for (const rule of rules.filter(rule => rule.tagged)) {
      for (const [key, type] of Object.entries(RULE_BINDING_TYPES)) {
        for (const id of rule.bound_to[key]) {
          const target = await resolveTarget(type, id);
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
  return { rules, bindings, targets, pins: pinned.rules, pinWarnings: pinned.warnings };
}

export function renderRuleKernelIndex(rules, nativePaths = false) {
  const summary = rules.filter(rule => rule.tagged && (rule.canonicalActivation || rule.activation) === 'summary');
  const paths = nativePaths ? [] : rules.filter(rule => rule.tagged && (rule.canonicalActivation || rule.activation) === 'paths');
  if (!summary.length && !paths.length) return '';
  const lines = ['# Rule kernel index', ''];
  for (const rule of summary) lines.push(`- ${rule.name} — ${rule.summary} Fetch and follow: \`aiwg show rule ${rule.name} --body\`.`, '');
  if (paths.length) {
    lines.push('## Path rules (prompt emulation)', '',
      'Before reading or changing files, compare intended project-relative paths with the globs below and fetch matching rules before their first read/write. If paths are initially unknown, check when they become known. An agent-only task has no path match. This is prompt emulation, not a filesystem hook.', '');
    for (const rule of paths) lines.push(`- ${rule.name} | ${rule.paths.map(glob => `\`${glob}\``).join(', ')} | ${rule.summary} | \`aiwg show rule ${rule.name} --body\``, '');
  }
  return lines.join('\n');
}

function managed(content, opts) {
  return addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function block(content, body) {
  const marker = /\n?<!-- AIWG:rule-startup:start -->[\s\S]*?<!-- AIWG:rule-startup:end -->\n?/g;
  const clean = content.replace(marker, '');
  return body ? `${clean.trimEnd()}\n\n<!-- AIWG:rule-startup:start -->\n${body}\n<!-- AIWG:rule-startup:end -->\n` : clean;
}

function putStartup(file, body) {
  const content = fs.existsSync(file) ? read(file) : '<!-- aiwg-managed -->\n';
  put(file, block(content, body));
}

/** Tagged rules bypass legacy aggregate writers. Untagged projections retain their tier policy. */
function projectRules(opts, provider) {
  const { rules } = opts.ruleDelivery;
  const nativePaths = ['claude', 'cursor'].includes(provider.name);
  const rulesDir = path.isAbsolute(provider.paths.rules || '') ? provider.paths.rules : path.join(opts.target, provider.paths.rules || `.${provider.name}/rules`);
  const tagged = rules.filter(rule => rule.tagged);
  const extension = provider.name === 'cursor' ? '.mdc' : '.md';
  const writeRule = (rule, content) => {
    const name = rule.behavior ? `behaviors/${path.basename(path.dirname(rule.file))}` : path.basename(rule.file, '.md');
    put(path.join(rulesDir, `${name}${extension}`), managed(content, opts));
  };
  const priorManifestPath = path.join(rulesDir, '.aiwg-manifest.json');
  const priorSources = fs.existsSync(priorManifestPath) ? JSON.parse(read(priorManifestPath)).ruleSources || [] : [];
  for (const source of priorSources.filter(file => !fs.existsSync(file))) {
    const name = path.basename(source) === 'BEHAVIOR.md' ? `behaviors/${path.basename(path.dirname(source))}` : path.basename(source, '.md');
    for (const ext of ['.md', '.mdc']) {
      const stale = path.join(rulesDir, name + ext);
      if (/aiwg:managed/.test(read(stale))) fs.rmSync(stale);
    }
  }
  // Remove former startup bodies even on activation changes and legacy .md -> .mdc migration.
  for (const rule of tagged) {
    const name = rule.behavior ? `behaviors/${path.basename(path.dirname(rule.file))}` : path.basename(rule.file, '.md');
    for (const ext of ['.md', '.mdc']) {
      const dest = path.join(rulesDir, `${name}${ext}`);
      if (/aiwg:managed/.test(read(dest))) fs.rmSync(dest);
    }
  }
  for (const rule of tagged) {
    if (rule.activation === 'kernel' || (nativePaths && rule.activation === 'paths')) {
      let content = stripTriggersFromContent(rule.content);
      if (rule.pinned) {
        const parsed = parseRuleFrontmatter(content);
        const data = { ...parsed.data, activation: 'kernel' };
        delete data.paths;
        delete data.bound_to;
        content = `---\n${stringify(data)}---\n${parsed.body}`;
      }
      if (provider.name === 'cursor') content = provider.transformRule(rule.file, content, opts);
      writeRule(rule, content);
    }
  }
  // A legacy consolidated index can mention now-bound rules. Replace it with an
  // activation-selected index when migration starts; pure legacy deployments keep it.
  // Hermes's 20K context limit requires a fixed provider projection: only
  // frontmatter-CRITICAL kernel bodies are inline (operator decision 2026-10-19).
  // Explicit operator pins retain full bodies; other activation metadata and
  // every other provider's projection remain unchanged.
  const isCritical = rule => String(rule.enforcement || '').trim().toLowerCase() === 'critical';
  const deferredKernels = provider.name === 'hermes'
    ? rules.filter(rule => rule.tagged && rule.activation === 'kernel' && !rule.pinned && !isCritical(rule)) : [];
  const indexRules = deferredKernels.length ? rules.map(rule => deferredKernels.includes(rule)
    ? { ...rule, activation: 'summary', summary: rule.summary || 'Fetch and follow the full rule before governed work.' } : rule) : rules;
  const index = renderRuleKernelIndex(indexRules, nativePaths);
  if (tagged.length) {
    for (const ext of ['.md', '.mdc']) {
      const file = path.join(rulesDir, `RULES-INDEX${ext}`);
      if (/aiwg:managed/.test(read(file))) fs.rmSync(file);
    }
    if (index) put(path.join(rulesDir, `RULES-INDEX${extension}`), managed(provider.name === 'cursor' ? `---\nalwaysApply: true\n---\n${index}` : index, opts));
  }
  fs.rmSync(path.join(rulesDir, '.aiwg-rules-budget.json'), { force: true });
  const manifestPath = path.join(rulesDir, '.aiwg-manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(read(manifestPath)) : { managed: {} };
  manifest.ruleSources = rules.map(rule => rule.file);
  for (const file of walk(rulesDir).filter(file => /\.(md|mdc)$/.test(file) && /aiwg:managed/.test(read(file)))) {
    const name = path.relative(rulesDir, file);
    manifest.managed[name] = { ...manifest.managed[name], hash: `sha256:${contentHash(read(file))}` };
  }
  for (const name of Object.keys(manifest.managed)) if (!fs.existsSync(path.join(rulesDir, name))) delete manifest.managed[name];
  put(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!nativePaths) {
    // The conventional directory is not a loader: startup reaches the complete
    // selected bodies through the provider's existing context owner.
    const kernels = rules.filter(rule => rule.activation === 'kernel' &&
      rule.tagged && (provider.name !== 'hermes' || rule.pinned || isCritical(rule)));
    const routes = [...new Set(opts.definitionRoutes || [])];
    const routing = routes.length ? `## Invoked artifact definitions\n\nRead the complete definition before invoking its artifact:\n${routes.map(route => `- ${route}`).join('\n')}` : '';
    let startupIndex = index;
    let startupRouting = routing;
    const fetchKernels = deferredKernels.length ? 'Before every task and subagent task, fetch and follow the kernel rules listed below with `aiwg show rule <name> --body` before governed work. Their full rules are binding.' : '';
    const renderBody = () => [...kernels.map(rule => `## Rule: ${rule.name}\n\n${rule.body.trim()}`), fetchKernels, startupIndex, startupRouting].filter(Boolean).join('\n\n');
    const dest = path.join(opts.target, 'AGENTS.md');
    if (provider.name === 'hermes' && block(read(dest), renderBody()).length > 19_000) {
      // The complete summary/path index and definition routes can themselves
      // exceed 10K. Keep kernel fetch obligations inline and explicitly reach
      // the rest through the existing index, rather than dropping contracts.
      if (index || routing) {
        const name = `RULES-INDEX${extension}`;
        const content = managed([index, routing].filter(Boolean).join('\n\n'), opts);
        put(path.join(rulesDir, name), content);
        manifest.managed[name] = { ...manifest.managed[name], hash: `sha256:${contentHash(content)}` };
        put(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const deferredFiles = new Set(deferredKernels.map(rule => rule.file));
      const kernelIndex = renderRuleKernelIndex(indexRules.filter(rule => deferredFiles.has(rule.file)));
      startupIndex = [kernelIndex,
        index || routing ? 'Before every task and subagent task, read and follow `.hermes/rules/RULES-INDEX.md` for summary rules, path checks, and invoked artifact definitions. Fetch matching full rules before governed work.' : '',
      ].filter(Boolean).join('\n\n');
      startupRouting = '';
    }
    const body = renderBody();
    if (!body) {
      // No activation-selected startup contract: retain legacy context owners
      // without inventing an empty policy file or a dangling bootstrap read.
      const contexts = ['AIWG.md', 'AGENTS.md', 'WARP.md', '.hermes.md'].map(name => path.join(opts.target, name));
      if (opts.activeWorkspace) contexts.push(path.join(opts.activeWorkspace, 'AGENTS.md'));
      for (const file of contexts) {
        if (!fs.existsSync(file)) continue;
        const content = read(file);
        const clean = block(content, '');
        if (clean !== content) put(file, clean);
      }
      return;
    }
    if (provider.name === 'hermes') {
      const dest = path.join(opts.target, 'AGENTS.md');
      putStartup(dest, body);
      putStartup(path.join(opts.target, '.hermes.md'), 'Read and follow `AGENTS.md` in this directory before every task and subagent task.');
    } else if (provider.name === 'warp') {
      const dest = path.join(opts.target, 'WARP.md');
      putStartup(dest, body);
    } else {
      const dest = path.join(opts.target, 'AIWG.md');
      putStartup(dest, body);
      const bridge = provider.name === 'openclaw' ? path.join(opts.activeWorkspace, 'AGENTS.md') : path.join(opts.target, 'AGENTS.md');
      putStartup(bridge, `Read and follow ${JSON.stringify(dest)} before every task and subagent task. It contains the complete activation-selected kernel and rule index.`);
    }
  }
}

/** External helpers also project skills/flows. Inject into their body, never descriptions. */
function finishBindings(opts, provider) {
  const roots = [opts.target, opts.deploymentHome, ...Object.values(provider.paths).filter(p => path.isAbsolute(p))];
  const files = [...new Set(roots.flatMap(walk))];
  const targetsBySource = new Map();
  for (const target of opts.ruleDelivery.targets) {
    targetsBySource.set(target.source, [...(targetsBySource.get(target.source) || []), target]);
  }
  for (const file of files.filter(file => /\.(md|toml)$/.test(file))) {
    if (!/(?:[/\\](?:skills|agents|commands)[/\\])/.test(file)) continue;
    if (/[/\\]rules[/\\]/.test(file) || /[/\\]\.aiwg[/\\](?!skills[/\\])/.test(file.replace(opts.target, ''))) continue;
    let content = read(file);
    if (!/aiwg:managed/.test(content) && !fs.existsSync(path.join(path.dirname(file), '.aiwg-managed')) && !fs.existsSync(path.join(path.dirname(file), '.aiwg-manifest.json'))) continue;
    const skill = path.basename(file) === 'SKILL.md';
    const name = skill ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.(md|toml)$/, '');
    const sidecarPath = path.join(skill ? path.dirname(file) : path.dirname(file), '.aiwg-manifest.json');
    const sidecar = fs.existsSync(sidecarPath) ? JSON.parse(read(sidecarPath)) : null;
    const source = sidecar?.skillSource ? path.join(sidecar.skillSource, 'SKILL.md') : sidecar?.managed?.[path.basename(file)]?.sourcePath;
    const flowSource = opts.flowSkillSources?.get(file);
    const targets = [...(flowSource ? targetsBySource.get(flowSource) || [] : []),
      ...(source ? targetsBySource.get(path.resolve(source)) || [] : opts.ruleDelivery.targets.filter(target =>
        (skill ? target.type !== 'agent' : file.includes('/agents/') ? target.type === 'agent' : target.type === 'flow') &&
        [target.name, path.basename(target.source, '.md'), path.basename(path.dirname(target.source))].includes(name)))];
    const rules = targets.flatMap(target => opts.ruleDelivery.bindings.get(target.source) || []);
    if (!rules.length && !content.includes('<!-- AIWG:bound-rules:start -->')) continue;
    if (file.endsWith('.toml')) content = content.replace(/^developer_instructions = (".*")$/m, (_, value) => `developer_instructions = ${JSON.stringify(replaceBoundRulesBlock(JSON.parse(value), rules))}`);
    else content = replaceBoundRulesBlock(content, rules);
    put(file, content);
    // Keep deployment hashes honest after projection by external helpers.
    if (sidecar?.managed?.[path.basename(file)]) {
      sidecar.managed[path.basename(file)].hash = `sha256:${contentHash(content)}`;
      put(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    }
  }
}

/** Bindings annotate the selected deployment; they do not select standard skills
 * (ADR lines 102–108). Flow projections follow the same opt-in and tier routing. */
function projectBoundFlowSkills(opts, provider, selected) {
  opts.flowSkillSources = new Map();
  if (opts.rulesOnly || opts.commandsOnly || !(opts.deploySkills || opts.skillsOnly)) return;
  const kernel = path.isAbsolute(provider.kernelSkillsPath || '') ? opts.kernelSkillsPath
    : path.join(opts.target, provider.kernelSkillsPath || `.${provider.name}/skills`);
  // Codex's opt-in standard tier shares the native skills directory.
  const standard = provider.name === 'codex' ? kernel : path.isAbsolute(provider.paths.skills)
    ? provider.paths.skills : path.join(opts.target, provider.paths.skills);
  const flows = opts.ruleDelivery.targets.filter(entry => entry.type === 'flow' && selected(entry));
  const sources = new Set(flows.map(entry => entry.source));
  for (const root of new Set([kernel, standard])) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, 'SKILL.md');
      const content = read(file);
      const receiptFile = path.join(dir, '.aiwg-manifest.json');
      const receipt = fs.existsSync(receiptFile) ? JSON.parse(read(receiptFile)) : null;
      // Recognize the old projector's exact generated wrapper as well as new
      // receipts. Ordinary deployed skills and operator files are preserved.
      const legacy = !receipt?.skillSource && !receipt?.flowSource && /aiwg:managed/.test(content)
        && content.includes(`description: Invoke ${entry.name}.\n`)
        && content.includes('```yaml\n') && content.includes('<!-- AIWG:bound-rules:start -->');
      const stale = receipt?.flowSource && (opts.copyStandardSkills !== true
        || !sources.has(receipt.flowSource) || root !== standard);
      if (!legacy && !stale) continue;
      fs.rmSync(file, { force: true });
      if (receipt?.flowSource) {
        fs.rmSync(receiptFile, { force: true });
        fs.rmSync(path.join(dir, '.aiwg-managed'), { force: true });
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    }
  }
  if (opts.copyStandardSkills !== true) return;
  for (const entry of flows) {
    const name = entry.name || path.basename(entry.source).replace(/\.(md|ya?ml)$/, '');
    const dir = path.join(standard, name);
    const file = path.join(dir, 'SKILL.md');
    const receiptFile = path.join(dir, '.aiwg-manifest.json');
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(read(receiptFile)) : null;
    // A selected authored skill may already represent this flow. Keep its body;
    // finishBindings adds both artifact identities' contracts after projection.
    if (!fs.existsSync(file) || receipt?.flowSource === entry.source) {
      const body = read(entry.source);
      const markdown = entry.source.endsWith('.md') ? body : `---\nname: ${name}\nnamespace: aiwg\ndescription: Invoke ${name}.\n---\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
      const content = managed(replaceBoundRulesBlock(markdown, opts.ruleDelivery.bindings.get(entry.source)), opts);
      put(file, content);
      put(path.join(dir, '.aiwg-managed'), 'true\n');
      put(receiptFile, `${JSON.stringify({ flowSource: entry.source,
        managed: { 'SKILL.md': { sourcePath: entry.source, hash: `sha256:${contentHash(content)}` } } }, null, 2)}\n`);
    }
    opts.flowSkillSources.set(file, entry.source);
    if (['warp', 'hermes'].includes(provider.name)) opts.definitionRoutes.push(`${name}: ${file}`);
  }
}

/** Count rule sections, excluding aggregated agent/command definitions and project prose. */
export function warpRuleContent(content) {
  const blocks = [...content.matchAll(/<!-- AIWG:rule-startup:start -->[\s\S]*?<!-- AIWG:rule-startup:end -->/g)].map(match => match[0]);
  // Remove managed blocks first so their internal headings cannot be counted twice.
  const remaining = content.replace(/<!-- AIWG:rule-startup:start -->[\s\S]*?<!-- AIWG:rule-startup:end -->/g, '');
  const sections = [...remaining.matchAll(/^## (?:AIWG Rules|On-Demand Rules)\r?\n[\s\S]*?(?=^## |(?![\s\S]))/gm)].map(match => match[0]);
  return [...sections, ...blocks].join('\n');
}

function startupFiles(opts, provider) {
  const bridgeNames = { claude: ['CLAUDE.md'], cursor: ['AGENTS.md'], codex: ['AGENTS.md'], hermes: ['AGENTS.md', '.hermes.md'], pi: ['AGENTS.md'], warp: ['WARP.md'], openclaw: [] };
  const paths = ['AIWG.md', 'WORKSPACE.md', '.aiwg/AIWG.md', ...bridgeNames[provider.name]].map(name => path.join(opts.target, name));
  if (opts.activeWorkspace) paths.push(path.join(opts.activeWorkspace, 'AGENTS.md'));
  if (['claude', 'cursor', 'openclaw'].includes(provider.name)) {
    const dir = path.isAbsolute(provider.paths.rules) ? provider.paths.rules : path.join(opts.target, provider.paths.rules);
    paths.push(...walk(dir).filter(file => /\.(md|mdc)$/.test(file)));
  }
  return [...new Set(paths)].filter(file => fs.existsSync(file)).map(file => {
    let content = read(file);
    if (['claude', 'cursor'].includes(provider.name)) {
      const parsed = parseRuleFrontmatter(content);
      if (parsed.data?.paths || parsed.data?.globs) content = content.slice(0, content.length - parsed.body.length);
    }
    // WARP.md aggregates agents and commands as well; only its rule content
    // (managed startup blocks, legacy inline rules, and on-demand lists) counts
    // toward the rules startup budget.
    if (provider.name === 'warp' && path.basename(file) === 'WARP.md') content = warpRuleContent(content);
    return { path: file, content };
  });
}

// Plans contain only JSON values and a scratch directory. The preparing process
// owns that directory until disposal; cross-process transfer needs a separate lease.
const stagedCleanups = new Map();
export class RuleDeploymentStaleError extends Error {
  constructor(message, paths = []) {
    super(message);
    this.name = 'RuleDeploymentStaleError';
    this.code = 'AIWG_RULE_DEPLOYMENT_STALE';
    this.paths = paths;
  }
}
function capturePreimage(file, ancestors = new Set()) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    const resolved = path.resolve(path.dirname(file), target);
    if (ancestors.has(resolved)) throw new Error(`Cyclic deployment preimage: ${file}`);
    return { kind: 'symlink', mode, target, resolved: capturePreimage(resolved, new Set([...ancestors, resolved])) };
  }
  if (stat.isFile()) return { kind: 'file', mode, digest: fileDigest(file) };
  if (stat.isDirectory()) return { kind: 'directory', mode, entries: fs.readdirSync(file).sort().map(name => [name, capturePreimage(path.join(file, name), new Set([...ancestors, path.resolve(file)]))]) };
  throw new Error(`Unsupported deployment preimage: ${file}`);
}
// cpSync materializes links; compare its output with the recursively resolved
// content while retaining the original link-shaped preimage for commit drift.
function materializeInput(from, to, ancestors = new Set()) {
  if (!fs.existsSync(from)) return;
  const real = fs.realpathSync(from);
  if (ancestors.has(real)) throw new Error(`Cyclic deployment input: ${from}`);
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) materializeInput(path.join(from, name), path.join(to, name), new Set([...ancestors, real]));
    fs.chmodSync(to, stat.mode & 0o7777);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode & 0o7777);
  } else throw new Error(`Unsupported deployment input: ${from}`);
}
function materializedPreimage(state) {
  if (state.kind === 'symlink') return materializedPreimage(state.resolved);
  if (state.kind === 'directory') return { ...state, entries: state.entries.map(([name, child]) => [name, materializedPreimage(child)]) };
  return state;
}
function snapshotPreimages(paths) {
  return [...new Set(paths.map(file => path.resolve(file)))].map(file => ({ path: file, state: capturePreimage(file) }));
}
function planSeal(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
function planOwner(plan) {
  const owner = stagedCleanups.get(plan?.lease);
  return owner && owner.seal === planSeal(plan) ? owner : null;
}
export function disposeRuleDeploymentPlan(plan) {
  const owner = planOwner(plan);
  if (owner) { stagedCleanups.delete(plan.lease); owner.cleanup(); }
}

/** Release process-local ownership while retaining a coordinator-owned stage. */
export function detachRuleDeploymentPlan(plan) {
  const owner = planOwner(plan);
  if (!owner || !owner.transferable) throw new Error('Rule deployment plan is not transferable');
  stagedCleanups.delete(plan.lease);
  owner.detach();
  return plan;
}
function captureAnchors(paths) {
  const names = new Set();
  for (const name of paths) {
    let current = path.resolve(name);
    for (;;) {
      names.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...names].sort().map(file => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      return { path: file, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
        link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null, real: fs.realpathSync(file) };
    } catch (error) {
      if (error.code === 'ENOENT') return { path: file, missing: true };
      throw error;
    }
  });
}

// Opaque coordinator-owned input pool. A plan retains a lease until committed or
// disposed, so disposing the creator's handle cannot invalidate active stages.
const inputPools = new WeakMap();
// Executable links are identity-bound but their installed code is trusted host
// state. Data files, modes, directory membership, and links are sealed in full.
function poolInventory(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return { kind: 'symlink', mode, target: fs.readlinkSync(file) };
  if (stat.isFile()) return { kind: 'file', mode, digest: fileDigest(file) };
  if (stat.isDirectory()) return { kind: 'directory', mode, entries: fs.readdirSync(file).sort().map(name => [name, poolInventory(path.join(file, name))]) };
  throw new Error(`Unsupported shared input pool entry: ${file}`);
}
function setPoolWritable(file, writable) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory() && writable) fs.chmodSync(file, (stat.mode & 0o7777) | 0o700);
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) setPoolWritable(path.join(file, name), writable);
  if (!writable) fs.chmodSync(file, (stat.mode & 0o7777) & ~0o222);
}
function verifyInputPool(pool) {
  try {
    if (planSeal(poolInventory(pool.snapshotRoot)) === pool.inventorySeal &&
      JSON.stringify(captureAnchors(pool.execAnchors.map(anchor => anchor.path))) === JSON.stringify(pool.execAnchors)) return;
  } catch (error) { throw new Error(`Shared input pool changed: ${error.message}`); }
  throw new Error('Shared input pool changed');
}

export function createRuleDeploymentInputPool(srcRoot) {
  const corpusRoot = resolveAiwgRoot(srcRoot) || srcRoot;
  const sourceTree = fs.existsSync(path.join(corpusRoot, 'agentic', 'code')) ? path.join(corpusRoot, 'agentic', 'code') : srcRoot;
  const isCorpusTree = path.relative(corpusRoot, sourceTree) === path.join('agentic', 'code');
  const paths = [sourceTree, path.join(corpusRoot, 'prebuilt', 'framework-relations'), path.join(corpusRoot, 'package.json'), path.join(corpusRoot, 'schemas')];
  const preimages = snapshotPreimages(paths);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-input-'));
  const cleanup = trackTemporaryDirectory(temp);
  try {
    const snapshotRoot = path.join(temp, 'input');
    const snapshotTree = isCorpusTree ? path.join(snapshotRoot, 'agentic', 'code') : snapshotRoot;
    materializeInput(sourceTree, snapshotTree);
    if (JSON.stringify(capturePreimage(snapshotTree)) !== JSON.stringify(materializedPreimage(preimages[0].state))) throw new Error('Source changed while preparing immutable snapshot');
    const trustedExec = [];
    if (isCorpusTree) {
      for (const rel of ['package.json', 'prebuilt/framework-relations', 'schemas']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        materializeInput(from, to);
        const expected = preimages.find(item => item.path === path.resolve(from));
        if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Package input changed while preparing snapshot: ${from}`);
      }
      for (const rel of ['tools', 'dist', 'node_modules', 'src']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) { fs.symlinkSync(from, to, 'dir'); trustedExec.push(from); }
      }
    }
    setPoolWritable(snapshotRoot, false);
    const inventorySeal = planSeal(poolInventory(snapshotRoot));
    const execAnchors = captureAnchors(trustedExec);
    const safeCleanup = () => { setPoolWritable(snapshotRoot, true); cleanup(); };
    const token = Object.freeze({});
    inputPools.set(token, { corpusRoot: path.resolve(corpusRoot), sourceTree: path.resolve(sourceTree), snapshotRoot, snapshotTree, isCorpusTree, preimages, inventorySeal, execAnchors, refs: 1, closed: false, cleanup: safeCleanup, transferable: true });
    return token;
  } catch (error) { setPoolWritable(path.join(temp, 'input'), true); cleanup(); throw error; }
}
function releaseInputPool(pool) { if (--pool.refs === 0) pool.cleanup(); }
export function disposeRuleDeploymentInputPool(token) {
  const pool = inputPools.get(token);
  if (pool && !pool.closed) { pool.closed = true; releaseInputPool(pool); }
}

/** A descriptor contains immutable snapshot identity, never its cleanup lease. */
export function describeRuleDeploymentInputPool(token) {
  const pool = inputPools.get(token);
  if (!pool || pool.closed || !pool.transferable) throw new Error('Invalid or closed rule deployment input pool');
  verifyInputPool(pool);
  return {
    version: 1,
    corpusRoot: pool.corpusRoot,
    sourceTree: pool.sourceTree,
    snapshotRoot: pool.snapshotRoot,
    snapshotTree: pool.snapshotTree,
    isCorpusTree: pool.isCorpusTree,
    inventorySeal: pool.inventorySeal,
    execAnchors: pool.execAnchors,
  };
}

/** Import a read-only pool view in a preparation worker. The coordinator keeps
 * the only cleanup lease and later restores the live-source preimages. */
export function importRuleDeploymentInputPool(descriptor) {
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.inventorySeal !== 'string' ||
      !Array.isArray(descriptor.execAnchors)) throw new Error('Invalid rule deployment input pool descriptor');
  for (const key of ['corpusRoot', 'sourceTree', 'snapshotRoot', 'snapshotTree']) {
    if (typeof descriptor[key] !== 'string' || !path.isAbsolute(descriptor[key])) throw new Error('Invalid rule deployment input pool descriptor');
  }
  const token = Object.freeze({});
  const pool = { ...descriptor, corpusRoot: path.resolve(descriptor.corpusRoot), sourceTree: path.resolve(descriptor.sourceTree),
    snapshotRoot: path.resolve(descriptor.snapshotRoot), snapshotTree: path.resolve(descriptor.snapshotTree), preimages: [],
    refs: 1, closed: false, cleanup: () => {}, transferable: false };
  verifyInputPool(pool);
  inputPools.set(token, pool);
  return token;
}

function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeRelative(root, name) {
  return typeof name === 'string' && name !== '' && name !== '.' && path.normalize(name) === name && !path.isAbsolute(name) && within(root, path.join(root, name));
}

function exactObjectKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validPreimageState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.kind !== 'string') return false;
  if (state.kind === 'missing') return Object.keys(state).length === 1;
  if (!Number.isSafeInteger(state.mode) || state.mode < 0) return false;
  if (state.kind === 'file') return Object.keys(state).length === 3 && /^[a-f0-9]{64}$/.test(state.digest);
  if (state.kind === 'symlink') return Object.keys(state).length === 4 && typeof state.target === 'string' && validPreimageState(state.resolved);
  return state.kind === 'directory' && Object.keys(state).length === 3 && Array.isArray(state.entries) && state.entries.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0] !== '' && !entry[0].includes(path.sep) && validPreimageState(entry[1]));
}

function expectedAnchorPaths(paths) {
  const names = new Set();
  for (const name of paths) {
    let current = path.resolve(name);
    for (;;) {
      names.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...names].sort();
}

/** Adopt a detached worker plan into the coordinator's process-local lease. */
export function adoptRuleDeploymentPlan(detached, { scratch, target, inputPool, cleanup }) {
  const invalid = () => { throw new Error('Invalid transferred rule deployment plan'); };
  if (!exactObjectKeys(detached, ['version', 'lease', 'temp', 'target', 'stage', 'rootNames', 'workspaceDirs', 'preimages', 'poolSeal', 'anchors', 'snapshotRoot', 'corpusRoot', 'sourceMappings', 'staged', 'report', 'mappings']) ||
      detached.version !== 1 || typeof detached.lease !== 'string' || !(detached.poolSeal === null || typeof detached.poolSeal === 'string') ||
      !detached.report || typeof detached.report !== 'object' || Array.isArray(detached.report) || typeof scratch !== 'string' || typeof target !== 'string' || typeof cleanup !== 'function') invalid();
  const root = path.resolve(scratch), expectedTarget = path.resolve(target);
  if (path.resolve(detached.temp || '') !== root || path.resolve(detached.stage || '') !== path.join(root, 'project') || path.resolve(detached.target || '') !== expectedTarget) invalid();
  if (!Array.isArray(detached.staged) || !Array.isArray(detached.mappings) || !Array.isArray(detached.rootNames) || !Array.isArray(detached.preimages) ||
      !Array.isArray(detached.workspaceDirs) || !Array.isArray(detached.anchors) || !Array.isArray(detached.sourceMappings) ||
      typeof detached.snapshotRoot !== 'string' || !path.isAbsolute(detached.snapshotRoot) || typeof detached.corpusRoot !== 'string' || !path.isAbsolute(detached.corpusRoot)) invalid();
  if (detached.rootNames.some(name => !safeRelative(expectedTarget, name))) invalid();
  const pool = inputPool && inputPools.get(inputPool);
  if (inputPool && (!pool || pool.closed || !pool.transferable)) invalid();
  if (pool) {
    verifyInputPool(pool);
    if (detached.poolSeal !== pool.inventorySeal || path.resolve(detached.snapshotRoot || '') !== pool.snapshotRoot) invalid();
  } else if (detached.poolSeal) invalid();
  const expectedArtifactRoot = path.resolve(resolveProjectAiwgDir(expectedTarget));
  const validSourceMapping = item => within(root, item.to) || (pool && within(pool.snapshotRoot, item.to)) ||
    (path.resolve(item.from) === path.join(expectedTarget, '.aiwg') && path.resolve(item.to) === expectedArtifactRoot);
  if (detached.workspaceDirs.some(name => !safeRelative(expectedTarget, name)) ||
      detached.preimages.some(item => !item || Object.keys(item).length !== 2 || typeof item.path !== 'string' || !path.isAbsolute(item.path) || !validPreimageState(item.state)) ||
      detached.staged.some(item => !item || Object.keys(item).length !== 2 || typeof item.path !== 'string' || !within(root, item.path) || !validPreimageState(item.state)) ||
      detached.sourceMappings.some(item => !item || Object.keys(item).length !== 2 || typeof item.from !== 'string' || !path.isAbsolute(item.from) ||
        typeof item.to !== 'string' || !path.isAbsolute(item.to) || !validSourceMapping(item)) ||
      detached.mappings.some(item => !item || Object.keys(item).length !== 3 || typeof item.from !== 'string' || !path.isAbsolute(item.from) ||
        typeof item.to !== 'string' || !within(root, item.to) || within(root, item.from) || !Array.isArray(item.before) || item.before.some(entry =>
          !Array.isArray(entry) || entry.length !== 2 || !safeRelative(item.to, entry[0]) || !/^[a-f0-9]{64}$/.test(entry[1])))) invalid();
  const expectedStaged = [path.join(root, 'project'), ...detached.mappings.map(item => path.resolve(item.to))].sort();
  if (JSON.stringify(detached.staged.map(item => path.resolve(item.path)).sort()) !== JSON.stringify([...new Set(expectedStaged)])) invalid();
  const anchorPaths = expectedAnchorPaths([expectedTarget, ...detached.mappings.map(item => item.from), ...detached.workspaceDirs.map(name => path.join(expectedTarget, name))]);
  if (detached.anchors.some(item => !item || typeof item.path !== 'string' || !path.isAbsolute(item.path) ||
      (item.missing === true ? Object.keys(item).length !== 2 : Object.keys(item).sort().join(',') !== 'dev,ino,link,mode,path,real' ||
        !['dev', 'ino', 'mode', 'real'].every(key => typeof item[key] === 'string') || !(item.link === null || typeof item.link === 'string'))) ||
      JSON.stringify(detached.anchors.map(item => path.resolve(item.path)).sort()) !== JSON.stringify(anchorPaths)) invalid();
  const plan = structuredClone(detached);
  plan.lease = randomUUID();
  if (pool) {
    const existing = new Set(plan.preimages.map(item => path.resolve(item.path)));
    plan.preimages.unshift(...pool.preimages.filter(item => !existing.has(path.resolve(item.path))));
    pool.refs++;
  }
  const ownerCleanup = () => { try { cleanup(); } finally { if (pool) releaseInputPool(pool); } };
  stagedCleanups.set(plan.lease, { temp: root, cleanup: ownerCleanup, pool, seal: planSeal(plan), transferable: false, detach: () => {} });
  return plan;
}

/** Stage only provider/context output, never the user's source tree. On failure
 * no staged output (including skills and behaviors) reaches the prior deployment. */
export async function prepareRuleDeployment(original, provider, deploy) {
  const budgetEnv = { ...process.env };
  const ruleDir = path.isAbsolute(provider.paths.rules || '') ? provider.paths.rules : path.join(original.target, provider.paths.rules || `.${provider.name}/rules`);
  const manifestFile = path.join(ruleDir, '.aiwg-manifest.json');
  const previousText = fs.existsSync(manifestFile) ? read(manifestFile) : '';
  const previous = previousText ? JSON.parse(previousText) : {};
  const corpusRoot = resolveAiwgRoot(original.srcRoot) || original.srcRoot;
  const sourceTree = fs.existsSync(path.join(corpusRoot, 'agentic', 'code'))
    ? path.join(corpusRoot, 'agentic', 'code') : original.srcRoot;
  const pool = original.inputPool && inputPools.get(original.inputPool);
  if (original.inputPool && (!pool || pool.closed || pool.corpusRoot !== path.resolve(corpusRoot) || pool.sourceTree !== path.resolve(sourceTree))) throw new Error('Invalid or closed rule deployment input pool');
  if (pool) verifyInputPool(pool);
  let projectConfig = original.config;
  if (!projectConfig) {
    try { projectConfig = JSON.parse(read(path.join(original.target, '.aiwg', 'aiwg.config')) || '{}'); } catch { projectConfig = {}; }
  }
  const artifactRoot = resolveProjectAiwgDir(original.target);
  const userIndexRoot = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aiwg', 'index');
  const projectGraphFiles = ['.index/metadata.json', '.index/project/metadata.json'].map(name => path.join(artifactRoot, name));
  const userGraphFiles = ['user'].map(name => path.join(userIndexRoot, name, 'metadata.json'));
  const localSources = Object.values(projectConfig.installed || {}).filter(entry => entry?.localPath)
    .map(entry => path.resolve(original.target, entry.localPath));
  const selectedRules = collectDeploymentRuleSources({ ...original, previousRuleSources: previous.ruleSources || [] });
  const initialPreimages = [...(pool ? pool.preimages : snapshotPreimages([sourceTree, path.join(corpusRoot, 'prebuilt', 'framework-relations'), path.join(corpusRoot, 'package.json'), path.join(corpusRoot, 'schemas')])), ...snapshotPreimages([path.join(corpusRoot, '.aiwg', '.index'),
    manifestFile, path.join(original.target, '.aiwg', 'aiwg.config'), path.join(original.target, '.aiwg', 'AIWG.md'), path.join(original.target, '.aiwg', 'skills'), path.join(original.target, '.aiwg-location'), ...projectGraphFiles, ...userGraphFiles, ...localSources,
    ...(path.resolve(original.srcRoot) === path.resolve(corpusRoot) ? [] : [original.srcRoot]), ...selectedRules, ...selectedRules.map(file => path.dirname(file)),
    userConfigFile('aiwg.config'), process.env.AIWG_USER_REGISTRY_PATH || userConfigFile('installed.json'),
    ...(original.ruleSources || []), ...(previous.ruleSources || []), ...(original.bindingEntries || []).map(entry => entry.path)])];
  let manifestState = initialPreimages.find(item => item.path === path.resolve(manifestFile)).state;
  if (manifestState.kind === 'symlink') manifestState = manifestState.resolved;
  const manifestDigest = previousText ? createHash('sha256').update(previousText).digest('hex') : null;
  if ((manifestState.kind === 'missing' ? null : manifestState.digest) !== manifestDigest) throw new Error('Rule manifest changed while preparing snapshot');
  const transferable = Boolean(original.ruleDeploymentScratch);
  const temp = transferable ? path.resolve(original.ruleDeploymentScratch) : fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-deploy-'));
  if (transferable) {
    const stat = fs.lstatSync(temp);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(temp).length) throw new Error('Invalid rule deployment scratch directory');
  }
  const removeStage = transferable
    ? () => fs.rmSync(temp, { recursive: true, force: true })
    : trackTemporaryDirectory(temp);
  if (pool) pool.refs++;
  const removeTemp = () => { removeStage(); if (pool) releaseInputPool(pool); };
  const lease = randomUUID();
  stagedCleanups.set(lease, { temp, cleanup: removeTemp, detach: () => { if (pool) releaseInputPool(pool); }, pool, seal: null, transferable });
  const mappings = [];
  const preimages = [...initialPreimages];
  let retained = false;
  const originals = { ...provider.paths };
  const logicalTarget = original.target;
  const priorAiwgRoot = process.env.AIWG_ROOT;
  const priorRegistry = process.env.AIWG_USER_REGISTRY_PATH;
  const priorArtifacts = process.env.AIWG_ARTIFACTS_PATH;
  const priorXdgData = process.env.XDG_DATA_HOME;
  try {
    const snapshotRoot = pool ? pool.snapshotRoot : path.join(temp, 'input');
    const treeRelative = path.relative(corpusRoot, sourceTree);
    const isCorpusTree = treeRelative === path.join('agentic', 'code');
    const snapshotTree = isCorpusTree ? path.join(snapshotRoot, 'agentic', 'code') : snapshotRoot;
    if (!pool) { fs.mkdirSync(path.dirname(snapshotTree), { recursive: true }); materializeInput(sourceTree, snapshotTree); }
    const expectedTree = initialPreimages.find(item => item.path === path.resolve(sourceTree));
    if (!pool && JSON.stringify(capturePreimage(snapshotTree)) !== JSON.stringify(materializedPreimage(expectedTree.state))) throw new Error('Source changed while preparing immutable snapshot');
    if (isCorpusTree && !pool) {
      for (const rel of ['package.json', 'prebuilt', 'schemas']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) materializeInput(from, to);
        const expected = initialPreimages.find(item => item.path === path.resolve(from));
        if (expected && JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Package input changed while preparing snapshot: ${from}`);
      }
      // The projector helpers execute installed code but receive the snapshot as data.
      for (const rel of ['tools', 'dist', 'node_modules', 'src']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) fs.symlinkSync(from, to, 'dir');
      }
    }
    // Keep standalone fixture/bundle snapshots from inheriting the installed
    // package's unrelated prebuilt relations through module-root fallback.
    process.env.AIWG_ROOT = snapshotRoot;
    const frozenConfigDir = path.join(temp, 'config');
    fs.mkdirSync(frozenConfigDir);
    const frozenFile = (from, name, expected) => {
      const to = path.join(frozenConfigDir, name);
      if (fs.existsSync(from)) { fs.copyFileSync(from, to); fs.chmodSync(to, fs.statSync(from).mode & 0o7777); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`Configuration changed while preparing snapshot: ${from}`);
      return to;
    };
    const projectFile = path.join(logicalTarget, '.aiwg', 'aiwg.config');
    const projectFileState = initialPreimages.find(item => item.path === path.resolve(projectFile))?.state;
    const userFile = userConfigFile('aiwg.config');
    const registryFile = priorRegistry || userConfigFile('installed.json');
    const projectSnapshot = frozenFile(projectFile, 'project.json', projectFileState);
    const userSnapshot = frozenFile(userFile, 'user.json', initialPreimages.find(item => item.path === path.resolve(userFile))?.state);
    const registrySnapshot = frozenFile(registryFile, 'registry.json', initialPreimages.find(item => item.path === path.resolve(registryFile))?.state);
    const readConfig = file => fs.existsSync(file) ? JSON.parse(read(file)) : {};
    const effectiveConfig = structuredClone(original.config || readConfig(projectSnapshot));
    const pinConfigs = structuredClone(original.pinConfigs || { project: effectiveConfig, user: readConfig(userSnapshot) });
    const frozenLocal = Object.values(pinConfigs.project.installed || {}).filter(entry => entry?.localPath)
      .map(entry => path.resolve(logicalTarget, entry.localPath));
    if (JSON.stringify([...new Set(frozenLocal)].sort()) !== JSON.stringify([...new Set(localSources)].sort())) throw new Error('Project-local configuration changed while preparing snapshot');
    const sourceMappings = [{ from: path.resolve(sourceTree), to: snapshotTree }];
    for (const [index, from] of [...new Set(localSources)].entries()) {
      const to = path.join(temp, 'local-input', String(index));
      const expected = initialPreimages.find(item => item.path === from)?.state;
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); materializeInput(from, to); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`Project-local input changed while preparing snapshot: ${from}`);
      sourceMappings.push({ from, to });
    }
    const externalInputs = [...new Set([...(path.resolve(original.srcRoot) === path.resolve(corpusRoot) ? [] : [original.srcRoot]), ...(original.ruleSources || []), ...(previous.ruleSources || []),
      ...(original.bindingEntries || []).map(entry => entry.path)].map(file => path.resolve(file)))];
    for (const [index, from] of externalInputs.entries()) {
      if (sourceMappings.some(item => from === item.from || from.startsWith(`${item.from}${path.sep}`))) continue;
      const to = path.join(temp, 'external-input', String(index), path.basename(from));
      const expected = initialPreimages.find(item => item.path === from)?.state;
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); materializeInput(from, to); }
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected || { kind: 'missing' }))) throw new Error(`External input changed while preparing snapshot: ${from}`);
      sourceMappings.push({ from, to });
    }
    for (const entry of Object.values(pinConfigs.project.installed || {})) {
      if (!entry?.localPath) continue;
      const from = path.resolve(logicalTarget, entry.localPath);
      entry.localPath = sourceMappings.find(mapping => mapping.from === from).to;
    }
    process.env.AIWG_USER_REGISTRY_PATH = registrySnapshot;
    let stagedProjectRoot;
    const mapSource = file => {
      let absolute = path.resolve(file);
      if (stagedProjectRoot && absolute.startsWith(`${stagedProjectRoot}${path.sep}`)) {
        const logical = path.join(logicalTarget, path.relative(stagedProjectRoot, absolute));
        if (sourceMappings.some(item => logical === item.from || logical.startsWith(`${item.from}${path.sep}`)) || !fs.existsSync(absolute)) absolute = logical;
      }
      const mapping = [...sourceMappings].sort((a, b) => b.from.length - a.from.length)
        .find(item => absolute === item.from || absolute.startsWith(`${item.from}${path.sep}`));
      if (mapping) return path.join(mapping.to, path.relative(mapping.from, absolute));
      if (isCorpusTree && absolute === path.resolve(corpusRoot)) return snapshotRoot;
      return file;
    };
    const logicalInputPath = file => {
      let result = file;
      for (const mapping of [...sourceMappings].sort((a, b) => b.to.length - a.to.length)) result = result.split(mapping.to).join(mapping.from);
      return result.split(snapshotRoot).join(corpusRoot);
    };
    original = { ...original, config: effectiveConfig, srcRoot: mapSource(original.srcRoot), pinConfigs, mapInputPath: mapSource, logicalInputPath,
      ...(original.ruleSources ? { ruleSources: original.ruleSources.map(mapSource) } : {}),
      ...(original.bindingEntries ? { bindingEntries: original.bindingEntries.map(entry => ({ ...entry, path: mapSource(entry.path) })) } : {}) };
    const target = path.resolve(original.target);
    const stage = path.join(temp, 'project');
    stagedProjectRoot = stage;
    fs.mkdirSync(stage);
    const mount = (from, to) => {
      if (mappings.some(mapping => mapping.from === from)) return;
      const mountPreimage = snapshotPreimages([from])[0];
      preimages.push(mountPreimage);
      if (fs.existsSync(from)) materializeInput(from, to);
      const before = new Map(walk(to).map(file => [path.relative(to, file), fileDigest(file)]));
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(mountPreimage.state))) throw new Error(`Deployment input changed while preparing snapshot: ${from}`);
      mappings.push({ from, to, before });
    };
    // Mount directories independently so only provider-owned surfaces are promoted.
    for (const dir of [`.${provider.name}`, '.agents', '.aiwg/skills']) mount(path.join(target, dir), path.join(stage, dir));
    fs.mkdirSync(path.join(stage, '.aiwg'), { recursive: true });
    if (fs.existsSync(projectSnapshot)) materializeInput(projectSnapshot, path.join(stage, '.aiwg', 'aiwg.config'));
    const rootNames = ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md', '.aiwg/AIWG.md', '.aiwg/frameworks/registry.json'];
    for (const framework of getFrameworksForMode(original.srcRoot, original.mode)) {
      for (const entry of framework.manifest?.memory?.creates || []) {
        if (typeof entry?.path !== 'string' || !entry.path.startsWith('.aiwg/') || !path.extname(entry.path)) continue;
        const safe = path.normalize(entry.path);
        if (!safe.startsWith(`.aiwg${path.sep}`)) throw new Error(`Invalid framework workspace path: ${entry.path}`);
        if (!rootNames.includes(safe)) rootNames.push(safe);
      }
    }
    preimages.push(...snapshotPreimages(rootNames.map(name => path.join(target, name))));
    for (const name of rootNames) {
      const from = path.join(target, name), to = path.join(stage, name);
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); fs.chmodSync(to, fs.statSync(from).mode & 0o7777); }
      const expected = preimages.find(item => item.path === path.resolve(from));
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Deployment input changed while preparing snapshot: ${from}`);
    }
    const home = path.join(temp, 'home');
    for (const [key, dir] of Object.entries(provider.paths)) {
      if (!path.isAbsolute(dir)) continue;
      const to = path.join(temp, 'native', key);
      mount(dir, to);
      provider.paths[key] = to;
    }
    let kernel = provider.kernelSkillsPath;
    if (kernel && path.isAbsolute(kernel)) {
      const to = path.join(temp, 'native', 'kernel-skills');
      mount(kernel, to);
      kernel = to;
    }
    // Codex's legacy prompt helper is home-global. Give it an isolated home and
    // promote only its output after validation.
    if (provider.name === 'codex' && (original.deployCommands || original.commandsOnly)) mount(path.join(os.homedir(), '.codex', 'prompts'), path.join(home, '.codex', 'prompts'));
    let hermesLegacySkills;
    let legacyCodexSkills;
    if (provider.name === 'hermes') {
      const source = path.join(path.dirname(provider.kernelSkillsPath), '.aiwg', 'skills');
      hermesLegacySkills = path.join(temp, 'hermes-legacy-skills');
      mount(source, hermesLegacySkills);
    }
    if (provider.name === 'codex' && (original.deploySkills || original.skillsOnly)) {
      legacyCodexSkills = path.join(temp, 'codex-legacy-skills');
      mount(path.join(os.homedir(), '.codex', 'skills'), legacyCodexSkills);
    }
    // Existing receipts carry logical source paths. Projectors operate against
    // the immutable snapshot, so translate those paths before stale cleanup;
    // promotion normalizes them back to their logical paths.
    for (const { to } of mappings) {
      for (const file of walk(to).filter(name => path.basename(name) === '.aiwg-manifest.json')) {
        let receipt; try { receipt = JSON.parse(read(file)); } catch { continue; }
        let changed = false;
        const remap = value => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (['skillSource', 'flowSource', 'sourcePath'].includes(key) && typeof child === 'string' && path.isAbsolute(child)) {
              const mapped = mapSource(child); if (mapped !== child) { value[key] = mapped; changed = true; }
            }
            else remap(child);
          }
        };
        remap(receipt); if (changed) fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
      }
    }
    let activeWorkspace;
    if (provider.resolveOpenClawWorkspace) {
      const from = provider.resolveOpenClawWorkspace();
      activeWorkspace = path.join(temp, 'active-workspace');
      mount(from, activeWorkspace);
    }
    // Graph discovery must read the same immutable inputs as projection, including
    // relocated project indexes and shared user indexes.
    const graphRoot = path.join(temp, 'graph-artifacts');
    const xdgRoot = path.join(temp, 'xdg-data');
    const copyGraph = (from, to) => {
      const expected = initialPreimages.find(item => item.path === path.resolve(from)).state;
      materializeInput(from, to);
      if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected))) throw new Error(`Graph input changed while preparing snapshot: ${from}`);
    };
    for (const from of projectGraphFiles) copyGraph(from, path.join(graphRoot, path.relative(artifactRoot, from)));
    for (const from of userGraphFiles) copyGraph(from, path.join(xdgRoot, 'aiwg', 'index', path.relative(userIndexRoot, from)));
    // Non-index graph targets remain logical until selected, then are copied
    // individually by the discovered-input loop below.
    if (path.resolve(artifactRoot) !== path.resolve(target, '.aiwg')) sourceMappings.push({ from: path.resolve(target, '.aiwg'), to: artifactRoot });
    process.env.AIWG_ARTIFACTS_PATH = graphRoot;
    process.env.XDG_DATA_HOME = xdgRoot;
    const delivery = await prepareRuleDelivery({ ...original, target: stage, sharedProjectGraph: path.resolve(artifactRoot) !== path.resolve(target, '.aiwg'), previousRuleSources: (previous.ruleSources || []).map(mapSource) });
    // Provider writes belong to the staged project control plane, not the
    // read-only graph snapshot used for binding discovery.
    process.env.AIWG_ARTIFACTS_PATH = path.join(stage, '.aiwg');
    // Discovery can select absolute user/project sources not known at entry.
    // Bind the exact copied bytes before any projector consumes them.
    const remappedBindings = new Map();
    for (const entry of delivery.targets) {
      const source = path.resolve(entry.source);
      const alreadyFrozen = source.startsWith(`${temp}${path.sep}`);
      if (!alreadyFrozen) {
        const state = capturePreimage(source);
        const to = path.join(temp, 'discovered-input', String(sourceMappings.length), path.basename(source));
        materializeInput(source, to);
        if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(state))) throw new Error(`Discovered input changed while preparing snapshot: ${source}`);
        preimages.push({ path: source, state });
        sourceMappings.push({ from: source, to });
        entry.source = to;
      }
      const rules = delivery.bindings.get(source);
      if (rules) remappedBindings.set(entry.source, rules);
    }
    delivery.bindings = remappedBindings;
    preimages.push(...snapshotPreimages([...delivery.rules.map(rule => rule.file), ...delivery.targets.map(entry => entry.source), path.join(target, '.aiwg', 'aiwg.config')]));
    const opts = { ...original, target: stage, dryRun: false, ruleDelivery: delivery,
      kernelSkillsPath: kernel, deploymentHome: home, activeWorkspace, hermesLegacySkills, legacyCodexSkills, staging: true };
    await deploy(opts);
    if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly && opts.deployBehaviors !== false) {
      deployEmulatedBehaviors(collectBehaviorDirs(opts.srcRoot), provider.name, stage, opts);
    }
    const selectedRoots = [original.srcRoot, ...getFrameworksForMode(original.srcRoot, original.mode).map(framework => framework.path), ...discoverAddons(original.srcRoot).map(addon => addon.path)];
    const selected = entry => selectedRoots.some(root => /^(agents|skills|commands|flows|workflows)[/\\]/.test(path.relative(root, entry.source)));
    opts.definitionRoutes = [];
    if (provider.name === 'hermes' && !opts.kernelOnly && !opts.skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
      const agents = delivery.targets.filter(target => target.type === 'agent' && selected(target));
      const selectedAgents = new Set(filterAgentFiles(agents.map(target => target.source), opts));
      for (const target of agents.filter(target => selectedAgents.has(target.source))) {
        const source = target.source;
        put(path.join(stage, '.hermes', 'agents', path.basename(source)), replaceBoundRulesBlock(read(source), delivery.bindings.get(source)));
        opts.definitionRoutes.push(`${target.name}: .hermes/agents/${path.basename(source)}`);
      }
    }
    projectBoundFlowSkills(opts, provider, selected);
    if (provider.name === 'warp') {
      for (const entry of delivery.targets.filter(entry => entry.type === 'agent' && selected(entry))) {
        const dest = path.join(stage, '.warp', 'agents', path.basename(entry.source));
        if (fs.existsSync(dest)) opts.definitionRoutes.push(`${entry.name}: .warp/agents/${path.basename(entry.source)}`);
      }
    }
    if (opts.deployRules || opts.rulesOnly || (!opts.skillsOnly && !opts.commandsOnly && ['hermes', 'warp'].includes(provider.name))) projectRules(opts, provider);
    finishBindings(opts, provider);
    // Normalize all generated path wrappers before counting or promoting bytes.
    const normalize = content => {
      for (const mapping of [...mappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      for (const mapping of [...sourceMappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      return content.split(snapshotRoot).join(corpusRoot).split(stage).join(target);
    };
    const projected = startupFiles(opts, provider).map(file => ({ path: normalize(file.path), content: normalize(file.content) }));
    const config = effectiveConfig;
    const guarded = guardRulesInlineBudget({ provider: provider.name, files: projected, config, env: budgetEnv,
      reportOnly: delivery.pins.length ? original.allowOverBudget === true : original.reportOnly !== false && !original.strict && !budgetEnv.CI });
    guarded.report.pins = delivery.pins.map(rule => ({ id: rule.id, name: rule.name, matches: rule.matches, canonical_activation: rule.canonical_activation, bytes: Buffer.byteLength(rule.body || '') }));
    const pinDetails = delivery.pins.map(rule => `${rule.name}: ${Buffer.byteLength(rule.body || '')} body bytes via ${JSON.stringify(rule.matches)}`).join('; ');
    const budgetFailure = message => new Error(`${provider.name}: ${message}; ${guarded.report.selected_bytes} startup bytes. Pins: ${pinDetails || '(none)'}.${delivery.pins.length ? ' Use --allow-over-budget to retain every pinned body.' : ''}`);
    for (const diagnostic of guarded.diagnostics) console.warn(diagnostic.message);
    if (!guarded.passed) throw budgetFailure(guarded.diagnostics.map(d => d.message).join('\n'));
    const agents = normalize(read(path.join(stage, 'AGENTS.md')));
    if (provider.name === 'codex' && Buffer.byteLength(agents) >= 32_768 && !(delivery.pins.length && original.allowOverBudget)) throw budgetFailure(`Codex AGENTS.md (${Buffer.byteLength(agents)} bytes) exceeds its 32 KB hard cap`);
    if (provider.name === 'hermes') {
      for (const name of ['AGENTS.md', '.hermes.md']) {
        const content = normalize(read(path.join(stage, name)));
        if (!(delivery.pins.length && original.allowOverBudget)) {
          try { provider.assertContextBudget(content, name, delivery.rules); }
          catch (error) { throw budgetFailure(error.message); }
        }
        if (content.length > 15_000) console.warn(`Hermes ${name} above 15000 character soft limit (${content.length})`);
      }
    }
    // Absolute provider roots can nest (Hermes standard skills live beneath
    // its kernel root). A more specific mount owns that subtree exclusively;
    // the parent's older snapshot must not resurrect pruned files/directories.
    const delegated = (from, rel) => mappings.some(mapping => mapping.from !== from
      && mapping.from.startsWith(`${from}${path.sep}`)
      && (path.join(from, rel) === mapping.from || path.join(from, rel).startsWith(`${mapping.from}${path.sep}`)));
    if (pool) verifyInputPool(pool);
    if (original.previewReport) return { report: guarded.report, noop: true };
    if (original.dryRun) {
      // A validated plan must describe the operator's final paths, rather than
      // exposing only the temporary paths used to assemble that plan.
      for (const { from, to, before } of mappings) {
        const after = new Set(walk(to).map(file => path.relative(to, file)).filter(rel => !delegated(from, rel)));
        for (const rel of after) {
          const file = path.join(to, rel);
          if (before.get(rel) !== fileDigest(file)) console.log(`[dry-run] Would write ${normalize(file)}`);
        }
        for (const rel of before.keys()) if (!delegated(from, rel) && !after.has(rel)) console.log(`[dry-run] Would remove ${path.join(from, rel)}`);
      }
      for (const name of rootNames) {
        const file = path.join(stage, name);
        if (fs.existsSync(file) && normalize(read(file)) !== read(path.join(target, name))) console.log(`[dry-run] Would write ${path.join(target, name)}`);
      }
      console.log(`[dry-run] Planned ${provider.name} deployment: ${guarded.report.selected_bytes} startup bytes; no output promoted.`);
      return { report: guarded.report, noop: true };
    }
    const workspaceDirs = [];
    const collectDirs = (dir, rel = '') => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = path.join(rel, entry.name); workspaceDirs.push(name);
        collectDirs(path.join(dir, entry.name), name);
      }
    };
    collectDirs(path.join(stage, '.aiwg'), '.aiwg');
    const plan = { version: 1, lease, temp, target, stage, rootNames, workspaceDirs, preimages, poolSeal: pool?.inventorySeal || null,
      anchors: captureAnchors([target, ...mappings.map(mapping => mapping.from), ...workspaceDirs.map(dir => path.join(target, dir))]),
      snapshotRoot, corpusRoot, sourceMappings, staged: snapshotPreimages([stage, ...mappings.map(mapping => mapping.to)]), report: guarded.report,
      mappings: mappings.map(({ from, to, before }) => ({ from, to, before: [...before] })) };
    stagedCleanups.get(lease).seal = planSeal(plan);
    retained = true;
    return plan;
  } finally {
    Object.assign(provider.paths, originals);
    if (priorAiwgRoot === undefined) delete process.env.AIWG_ROOT; else process.env.AIWG_ROOT = priorAiwgRoot;
    if (priorRegistry === undefined) delete process.env.AIWG_USER_REGISTRY_PATH; else process.env.AIWG_USER_REGISTRY_PATH = priorRegistry;
    if (priorArtifacts === undefined) delete process.env.AIWG_ARTIFACTS_PATH; else process.env.AIWG_ARTIFACTS_PATH = priorArtifacts;
    if (priorXdgData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = priorXdgData;
    if (!retained) { stagedCleanups.delete(lease); removeTemp(); }
  }
}

/** Validate every captured input before applying a staged provider plan. */
export function commitRuleDeploymentPlan(plan) {
  if (plan.noop) return plan.report;
  try {
    if (plan.version !== 1 || !plan.temp || !plan.stage || !Array.isArray(plan.preimages)) throw new Error('Invalid rule deployment plan');
    const owner = planOwner(plan);
    if (!owner) throw new Error('Unowned or modified rule deployment plan');
    if (owner.pool) { if (plan.poolSeal !== owner.pool.inventorySeal) throw new Error('Shared input pool lease changed'); verifyInputPool(owner.pool); }
    if (JSON.stringify(snapshotPreimages(plan.staged.map(item => item.path))) !== JSON.stringify(plan.staged)) throw new Error('Staged provider output changed');
    if (JSON.stringify(captureAnchors(plan.anchors.map(item => item.path))) !== JSON.stringify(plan.anchors)) {
      throw new RuleDeploymentStaleError('Provider deployment root or ancestor changed', plan.anchors.map(item => item.path));
    }
    const stale = plan.preimages.filter(item => JSON.stringify(capturePreimage(item.path)) !== JSON.stringify(item.state)).map(item => item.path);
    if (stale.length) throw new RuleDeploymentStaleError(`Provider deployment preimage changed: ${stale.join(', ')}`, stale);
    const { target, stage, rootNames } = plan;
    for (const dir of plan.workspaceDirs || []) fs.mkdirSync(path.join(target, dir), { recursive: true });
    const mappings = plan.mappings.map(({ from, to, before }) => ({ from, to, before: new Map(before) }));
    const normalize = content => {
      for (const mapping of [...mappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      for (const mapping of [...plan.sourceMappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      return content.split(plan.snapshotRoot).join(plan.corpusRoot).split(stage).join(target);
    };
    const delegated = (from, rel) => mappings.some(mapping => mapping.from !== from
      && mapping.from.startsWith(`${from}${path.sep}`)
      && (path.join(from, rel) === mapping.from || path.join(from, rel).startsWith(`${mapping.from}${path.sep}`)));
    for (const { from, to, before } of mappings) {
      if (!fs.existsSync(to)) {
        if (before.size) fs.rmSync(from, { recursive: true, force: true });
        continue;
      }
      promoteDirectories(to, from, rel => delegated(from, rel));
      const after = new Set(walk(to).map(file => path.relative(to, file)).filter(rel => !delegated(from, rel)));
      for (const rel of before.keys()) if (!delegated(from, rel) && !after.has(rel)) {
        fs.rmSync(path.join(from, rel), { force: true });
        // A pruned managed skill must disappear as a directory too. Remove
        // only empty parents absent from the staged result; preserve siblings.
        let parent = path.dirname(rel);
        while (parent !== '.' && !fs.existsSync(path.join(to, parent))) {
          try { fs.rmdirSync(path.join(from, parent)); } catch { break; }
          parent = path.dirname(parent);
        }
      }
      for (const rel of after) {
        const file = path.join(to, rel);
        if (before.get(rel) === fileDigest(file)) continue;
        const buffer = fs.readFileSync(file);
        // Provider output includes binary skill resources; normalize text only.
        const output = buffer.includes(0) ? buffer : Buffer.from(normalize(buffer.toString('utf8')));
        fs.mkdirSync(path.dirname(path.join(from, rel)), { recursive: true });
        fs.writeFileSync(path.join(from, rel), output);
      }
    }
    for (const name of rootNames) if (fs.existsSync(path.join(stage, name))) put(path.join(target, name), normalize(read(path.join(stage, name))));
    return plan.report;
  } finally {
    disposeRuleDeploymentPlan(plan);
  }
}

/** Stage and commit serially for existing provider callers. */
export async function deployWithRuleDelivery(original, provider, deploy) {
  if (original.ruleDelivery) return deploy(original);
  const hook = globalThis[PREPARATION_HOOK];
  if (hook) {
    const plan = await prepareRuleDeployment({ ...original, inputPool: hook.inputPool, ruleDeploymentScratch: hook.scratch }, provider, deploy);
    const report = plan.report;
    hook.accept(detachRuleDeploymentPlan(plan));
    return report;
  }
  return commitRuleDeploymentPlan(await prepareRuleDeployment(original, provider, deploy));
}
