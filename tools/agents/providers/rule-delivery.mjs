/** Activation-selected deployment, shared by the six provider projections (#2939). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { importImpl } from '../../_resolve-impl.mjs';
import {
  listMdFiles, discoverAddons, getFrameworksForMode, collectBehaviorDirs,
  resolveAiwgRoot, ruleEnforcementLevel, stripTriggersFromContent,
  addManagedMarker, contentHash, replaceBoundRulesBlock, deployEmulatedBehaviors,
} from './base.mjs';

const { parseRuleFrontmatter, inferRuleActivation, RULE_BINDING_TYPES } = await importImpl(import.meta.url, 'rules/activation.mjs');
const { guardRulesInlineBudget } = await importImpl(import.meta.url, 'rules/inline-budget.mjs');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  });
}
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const structural = file => /^(RULES-INDEX|RULES-ONDEMAND)\.(md|mdc)$/.test(path.basename(file));

/** Collect selected source contracts, before any tier filter or projection. */
export function collectDeploymentRuleSources(opts) {
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
  const bindings = new Map();
  const targets = [];
  if (rules.some(rule => Object.values(rule.bound_to).some(ids => ids.length))) {
    const { loadLocalCapabilityEntries, resolveRuleBindingTarget } = await importImpl(import.meta.url, 'artifacts/query-engine.js');
    const root = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
    const entries = opts.bindingEntries || loadLocalCapabilityEntries(opts.target);
    if (!opts.bindingEntries) {
      const sourceEntries = loadLocalCapabilityEntries(root);
      entries.push(...sourceEntries);
      if (!sourceEntries.length) {
        const indexTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-index-'));
        try {
          const { buildIndex } = await importImpl(import.meta.url, 'artifacts/index-builder.js');
          await buildIndex(root, { scope: root === opts.srcRoot && !fs.existsSync(path.join(root, 'agentic')) ? '.' : 'agentic/code', outputDir: indexTemp, force: true, quiet: true });
          const index = JSON.parse(read(path.join(indexTemp, '.aiwg', '.index', 'metadata.json')));
          entries.push(...Object.values(index.entries).map(entry => ({ ...entry, path: path.resolve(root, entry.path) })));
        } finally { fs.rmSync(indexTemp, { recursive: true, force: true }); }
      }
    }
    for (const rule of rules.filter(rule => rule.tagged)) {
      for (const [key, type] of Object.entries(RULE_BINDING_TYPES)) {
        for (const id of rule.bound_to[key]) {
          const target = resolveRuleBindingTarget(entries, type, id);
          const source = path.isAbsolute(target.path) ? target.path : path.resolve(target.path.startsWith('agentic/code/') ? root : opts.target, target.path);
          if (!fs.existsSync(source)) throw new Error(`${rule.file}: binding target content missing: ${source}`);
          bindings.set(source, [...(bindings.get(source) || []), rule]);
          targets.push({ ...target, source });
        }
      }
    }
  }
  return { rules, bindings, targets };
}

export function renderRuleKernelIndex(rules, nativePaths = false) {
  const summary = rules.filter(rule => rule.tagged && rule.activation === 'summary');
  const paths = nativePaths ? [] : rules.filter(rule => rule.tagged && rule.activation === 'paths');
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
      if (provider.name === 'cursor') content = provider.transformRule(rule.file, content, opts);
      writeRule(rule, content);
    }
  }
  // A legacy consolidated index can mention now-bound rules. Replace it with an
  // activation-selected index when migration starts; pure legacy deployments keep it.
  const index = renderRuleKernelIndex(rules, nativePaths);
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
      rule.tagged);
    const routes = [...new Set(opts.definitionRoutes || [])];
    const routing = routes.length ? `## Invoked artifact definitions\n\nRead the complete definition before invoking its artifact:\n${routes.map(route => `- ${route}`).join('\n')}` : '';
    const body = [...kernels.map(rule => `## Rule: ${rule.name}\n\n${rule.body.trim()}`), index, routing].filter(Boolean).join('\n\n');
    if (provider.name === 'hermes') {
      const dest = path.join(opts.target, 'AGENTS.md');
      put(dest, block(read(dest), body));
      put(path.join(opts.target, '.hermes.md'), block(read(path.join(opts.target, '.hermes.md')), 'Read and follow `AGENTS.md` in this directory before every task and subagent task.'));
    } else if (provider.name === 'warp') {
      const dest = path.join(opts.target, 'WARP.md');
      put(dest, block(read(dest), body));
    } else {
      const dest = path.join(opts.target, 'AIWG.md');
      put(dest, block(read(dest), body));
      const bridge = provider.name === 'openclaw' ? path.join(opts.activeWorkspace, 'AGENTS.md') : path.join(opts.target, 'AGENTS.md');
      put(bridge, block(read(bridge), `Read and follow ${JSON.stringify(dest)} before every task and subagent task. It contains the complete activation-selected kernel and rule index.`));
    }
  }
}

/** External helpers also project skills/flows. Inject into their body, never descriptions. */
function finishBindings(opts, provider) {
  const roots = [opts.target, opts.deploymentHome, ...Object.values(provider.paths).filter(p => path.isAbsolute(p))];
  const files = [...new Set(roots.flatMap(walk))];
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
    const targets = opts.ruleDelivery.targets.filter(target => source ? path.resolve(source) === target.source :
      (skill ? target.type !== 'agent' : file.includes('/agents/') ? target.type === 'agent' : target.type === 'flow') &&
      [target.name, path.basename(target.source, '.md'), path.basename(path.dirname(target.source))].includes(name));
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
  const mappings = [];
  const originals = { ...provider.paths };
  try {
    const target = path.resolve(original.target);
    const stage = path.join(temp, 'project');
    fs.mkdirSync(stage);
    const mount = (from, to) => {
      if (mappings.some(mapping => mapping.from === from)) return;
      const before = new Map(walk(from).map(file => [path.relative(from, file), fs.readFileSync(file)]));
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
    if (provider.name === 'hermes' && !opts.skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
      for (const target of delivery.targets.filter(target => target.type === 'agent' && selected(target))) {
        const source = target.source;
        put(path.join(stage, '.hermes', 'agents', path.basename(source)), replaceBoundRulesBlock(read(source), delivery.bindings.get(source)));
        opts.definitionRoutes.push(`${target.name}: .hermes/agents/${path.basename(source)}`);
      }
    }
    // Flow identity is kept even when a provider represents it as a native skill.
    for (const entry of delivery.targets.filter(entry => entry.type === 'flow' && !opts.rulesOnly && (opts.deploySkills || opts.skillsOnly || opts.deployCommands || opts.commandsOnly))) {
      // Only copy targets belonging to the selected bundle/framework.
      if (!selected(entry)) continue;
      const name = entry.name || path.basename(entry.source).replace(/\.(md|ya?ml)$/, '');
      const dest = path.isAbsolute(provider.kernelSkillsPath || '') ? opts.kernelSkillsPath : path.join(stage, provider.kernelSkillsPath || `.${provider.name}/skills`);
      const body = read(entry.source);
      const markdown = entry.source.endsWith('.md') ? body : `---\nname: ${name}\ndescription: Invoke ${name}.\n---\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
      put(path.join(dest, name, 'SKILL.md'), managed(replaceBoundRulesBlock(markdown, delivery.bindings.get(entry.source)), opts));
      if (['warp', 'hermes'].includes(provider.name)) opts.definitionRoutes.push(`${name}: ${path.join(dest, name, 'SKILL.md')}`);
    }
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
      reportOnly: original.reportOnly !== false && !original.strict && !process.env.CI });
    for (const diagnostic of guarded.diagnostics) console.warn(diagnostic.message);
    if (!guarded.passed) throw new Error(guarded.diagnostics.map(d => d.message).join('\n'));
    const agents = normalize(read(path.join(stage, 'AGENTS.md')));
    if (provider.name === 'codex' && Buffer.byteLength(agents) >= 32_768) throw new Error('Codex AGENTS.md exceeds its 32 KB hard cap');
    if (provider.name === 'hermes') {
      for (const name of ['AGENTS.md', '.hermes.md']) {
        const content = normalize(read(path.join(stage, name)));
        if (content.length > 19_000) throw new Error(`Hermes ${name} (${content.length} chars) exceeds hard cap of 19000`);
        if (content.length > 15_000) console.warn(`Hermes ${name} above 15000 character soft limit (${content.length})`);
      }
    }
    if (original.dryRun) {
      console.log(`[dry-run] Planned ${provider.name} deployment: ${guarded.report.selected_bytes} startup bytes; no output promoted.`);
      return guarded.report;
    }
    for (const { from, to, before } of mappings) {
      if (!fs.existsSync(to)) {
        if (before.size) fs.rmSync(from, { recursive: true, force: true });
        continue;
      }
      const after = new Set(walk(to).map(file => path.relative(to, file)));
      for (const rel of before.keys()) if (!after.has(rel)) fs.rmSync(path.join(from, rel), { force: true });
      for (const rel of after) {
        const buffer = fs.readFileSync(path.join(to, rel));
        if (before.get(rel)?.equals(buffer)) continue;
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
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
