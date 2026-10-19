/** Activation-selected deployment, shared by the six provider projections (#2939). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
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
      console.warn(`${file}: ${diagnostic.code}: ${diagnostic.code === 'missing-activation' ? `Missing activation; inferred ${rule.activation} delivery (migration fallback).` : diagnostic.message}`);
    }
    return rule;
  });
  const configs = opts.pinConfigs || loadRulePinConfigs(opts.target, opts.config);
  const installed = installedRuleCapabilities(configs);
  const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  const { loadRelations } = await importImpl(import.meta.url, 'artifacts/relations.js');
  const relations = loadRelations(opts.target) || loadRelations(root, opts.target);
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
    const { loadLocalCapabilityEntries, resolveRuleBindingTarget } = await importImpl(import.meta.url, 'artifacts/query-engine.js');
    const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
    // Framework graph paths are package-relative; project graph paths belong
    // to the queried project. Normalize before merging so one source cannot
    // become two apparently ambiguous targets after a source-index rebuild.
    const loadEntries = cwd => loadLocalCapabilityEntries(cwd).map(entry => ({ ...entry,
      path: path.resolve(entry.path.startsWith('agentic/code/') ? root : cwd, entry.path),
    }));
    let rebuilt = false;
    const cacheDir = process.env.AIWG_RULE_BINDING_INDEX_CACHE;
    const cacheFile = cacheDir && path.join(cacheDir, `${contentHash(root)}.json`);
    const buildSourceEntries = async (refresh = false) => {
      if (!refresh && cacheFile && fs.existsSync(cacheFile)) return JSON.parse(read(cacheFile));
      const indexTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-index-'));
      try {
        const { buildIndex } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
        await buildIndex(root, { scope: root === opts.srcRoot && !fs.existsSync(path.join(root, 'agentic')) ? '.' : 'agentic/code', outputDir: indexTemp, force: true, quiet: true });
        rebuilt = true;
        const index = JSON.parse(read(path.join(indexTemp, '.aiwg', '.index', 'metadata.json')));
        const entries = Object.values(index.entries).map(entry => ({ ...entry, path: path.resolve(root, entry.path) }));
        if (cacheFile) {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(entries));
        }
        return entries;
      } finally { fs.rmSync(indexTemp, { recursive: true, force: true }); }
    };
    let entries = opts.bindingEntries || loadEntries(opts.target);
    if (!opts.bindingEntries) {
      const sourceEntries = loadEntries(root);
      entries.push(...sourceEntries);
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
          entries.push(...Object.values(index.entries).map(entry => ({ ...entry, path: path.resolve(localRoot, entry.path) })));
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      }
    }
    // A stored index can predate the source tree (edge/dev checkouts). Rebuild once from source
    // before reporting a binding target as missing.
    const resolvedTargets = new Map();
    const resolveTarget = async (type, id) => {
      const key = `${type}:${id}`;
      if (resolvedTargets.has(key)) return resolvedTargets.get(key);
      let target;
      try { target = resolveRuleBindingTarget(entries, type, id); }
      catch (error) {
        if (rebuilt || opts.bindingEntries || !/^Missing /.test(error.message)) throw error;
        entries = [...loadEntries(opts.target), ...await buildSourceEntries(true)];
        rebuilt = true;
        target = resolveRuleBindingTarget(entries, type, id);
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
  for (const rule of summary) lines.push(`- ${rule.name} — ${rule.summary} Fetch and follow: \`aiwg show rule ${rule.name}\`.`, '');
  if (paths.length) {
    lines.push('## Path rules (prompt emulation)', '',
      'Before reading or changing files, compare intended project-relative paths with the globs below and fetch matching rules before their first read/write. If paths are initially unknown, check when they become known. An agent-only task has no path match. This is prompt emulation, not a filesystem hook.', '');
    for (const rule of paths) lines.push(`- ${rule.name} | ${rule.paths.map(glob => `\`${glob}\``).join(', ')} | ${rule.summary} | \`aiwg show rule ${rule.name}\``, '');
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
    const fetchKernels = deferredKernels.length ? 'Before every task and subagent task, fetch and follow the kernel rules listed below with `aiwg show rule <name>` before governed work. Their full rules are binding.' : '';
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
  const bridgeNames = { claude: ['CLAUDE.md'], cursor: ['AGENTS.md'], codex: ['AGENTS.md'], hermes: ['AGENTS.md', '.hermes.md'], warp: ['WARP.md'], openclaw: [] };
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

/** Stage only provider/context output, never the user's source tree. On failure
 * no staged output (including skills and behaviors) reaches the prior deployment. */
export async function deployWithRuleDelivery(original, provider, deploy) {
  if (original.ruleDelivery) return deploy(original);
  const ruleDir = path.isAbsolute(provider.paths.rules || '') ? provider.paths.rules : path.join(original.target, provider.paths.rules || `.${provider.name}/rules`);
  const manifestFile = path.join(ruleDir, '.aiwg-manifest.json');
  const previous = fs.existsSync(manifestFile) ? JSON.parse(read(manifestFile)) : {};
  const delivery = await prepareRuleDelivery({ ...original, previousRuleSources: previous.ruleSources || [] });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-deploy-'));
  const removeTemp = trackTemporaryDirectory(temp);
  const mappings = [];
  const originals = { ...provider.paths };
  try {
    const target = path.resolve(original.target);
    const stage = path.join(temp, 'project');
    fs.mkdirSync(stage);
    const mount = (from, to) => {
      if (mappings.some(mapping => mapping.from === from)) return;
      const before = new Map(walk(from).map(file => [path.relative(from, file), fileDigest(file)]));
      if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, dereference: true });
      mappings.push({ from, to, before });
    };
    // Mount directories independently so only provider-owned surfaces are promoted.
    for (const dir of [`.${provider.name}`, '.agents', '.aiwg']) mount(path.join(target, dir), path.join(stage, dir));
    const rootNames = ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md'];
    for (const name of rootNames) if (fs.existsSync(path.join(target, name))) fs.copyFileSync(path.join(target, name), path.join(stage, name));
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
    let activeWorkspace;
    if (provider.resolveOpenClawWorkspace) {
      const from = provider.resolveOpenClawWorkspace();
      activeWorkspace = path.join(temp, 'active-workspace');
      mount(from, activeWorkspace);
    }
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
      return content.split(stage).join(target);
    };
    const projected = startupFiles(opts, provider).map(file => ({ path: normalize(file.path), content: normalize(file.content) }));
    const configFile = path.join(target, '.aiwg', 'aiwg.config');
    const config = original.config || (fs.existsSync(configFile) ? JSON.parse(read(configFile)) : {});
    const guarded = guardRulesInlineBudget({ provider: provider.name, files: projected, config,
      reportOnly: delivery.pins.length ? original.allowOverBudget === true : original.reportOnly !== false && !original.strict && !process.env.CI });
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
    if (original.previewReport) return guarded.report;
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
      return guarded.report;
    }
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
    return guarded.report;
  } finally {
    Object.assign(provider.paths, originals);
    removeTemp();
  }
}
