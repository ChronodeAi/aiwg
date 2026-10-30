/** Operator-local activation overrides. Canonical rule sources are never mutated. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userConfigFile } from '../config/user-config-dir.mjs';
import { validateRulesConfig } from './inline-budget.mjs';

export const RULE_PIN_TIERS = ['critical', 'high', 'medium', 'low'];
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
export function rulePinConfigPath(cwd, source = 'project', userConfigDir) {
  return source === 'user' ? userConfigFile('aiwg.config', { configDir: userConfigDir }) : path.join(cwd, '.aiwg', 'aiwg.config');
}
export function loadRulePinConfigs(cwd, project, userConfigDir) {
  return { project: project ?? read(rulePinConfigPath(cwd)), user: read(rulePinConfigPath(cwd, 'user', userConfigDir)) };
}
export const capabilityId = id => id?.replace(/^(framework|addon|extension|plugin):/, '');
let bundledCapabilities;
function packageCapabilities() {
  if (bundledCapabilities) return bundledCapabilities;
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(root, 'package.json')) && path.dirname(root) !== root) root = path.dirname(root);
  const legacy = { 'sdlc-complete': ['sdlc'], 'media-marketing-kit': ['marketing', 'mmk'] };
  bundledCapabilities = [];
  for (const kind of ['frameworks', 'addons', 'extensions', 'plugins']) {
    const dir = path.join(root, 'agentic/code', kind);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      let manifest;
      try { manifest = read(path.join(dir, entry.name, 'manifest.json')); } catch { manifest = {}; }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = {};
      bundledCapabilities.push({ id: entry.name,
        aliases: [...(Array.isArray(manifest.modeAliases) ? manifest.modeAliases : []), ...(Array.isArray(manifest.aliases) ? manifest.aliases : []), ...(legacy[entry.name] || [])],
        bulk: kind !== 'plugins' && entry.name !== 'aiwg-dev' && !manifest.devOnly && !manifest.explicitInstall });
    }
  }
  return bundledCapabilities;
}
export function installedRuleCapabilities(configs) {
  const registry = read(process.env.AIWG_USER_REGISTRY_PATH || userConfigFile('installed.json'));
  const entries = { ...registry.installed, ...configs.user?.installed, ...configs.project?.installed };
  if (!Object.keys(entries).length) return [];
  const bundled = Object.values(entries).some(entry => entry?.source !== 'project-local') ? packageCapabilities() : [];
  return [...new Set(Object.entries(entries).flatMap(([id, entry]) => {
    if (entry?.source === 'project-local') return [id];
    if (id === 'all') return bundled.filter(capability => capability.bulk).map(capability => capability.id);
    return [bundled.find(capability => capability.id === id || capability.aliases.includes(id))?.id || id];
  }))].sort();
}
export function validateRulePinCapabilities(rules, installed, groups = {}) {
  const errors = validateRulesConfig(rules);
  if (errors.length || !rules) return errors;
  const available = new Set(installed);
  const check = (ids, label) => {
    for (const id of ids || []) if (!available.has(id)) errors.push(`${label}: unknown or uninstalled capability '${id}'. Installed ids: ${installed.join(', ') || '(none)'}`);
  };
  for (const [group, ids] of Object.entries(rules.pin_groups || {})) check(ids, `rules.pin_groups.${group}`);
  for (const selector of rules.always_load || []) {
    check(selector.capabilities, 'rules.always_load');
    if (selector.group) {
      const merged = { ...groups, ...rules.pin_groups };
      if (!Object.hasOwn(merged, selector.group)) errors.push(`rules.always_load: unknown pin group '${selector.group}'`);
      else check(merged[selector.group], `rules.always_load.group.${selector.group}`);
    }
  }
  return errors;
}
export function selectorKey(selector) {
  return JSON.stringify(Object.fromEntries(Object.entries(selector).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : value])));
}

/** OR across selectors, AND within each selector; one result per rule identity.
 * A RelationsReader narrows capability/tier candidates without the full index. */
export function resolveRulePins({ rules, configs, installed = installedRuleCapabilities(configs), relations = null }) {
  const warnings = [];
  const groups = { ...configs.user?.rules?.pin_groups, ...configs.project?.rules?.pin_groups };
  const pins = new Map();
  const available = new Set(installed);
  const indexedPaths = new Set(Object.values(relations?.index.rules || {}).map(rule => rule.path));
  for (const source of ['user', 'project']) {
    const config = configs[source]?.rules;
    const errors = validateRulesConfig(config);
    if (errors.length) throw new Error(errors.join('\n'));
    for (const error of validateRulePinCapabilities(config, installed, groups)) warnings.push(`${source}: ${error}; inactive capability pins ignored`);
    for (const selector of config?.always_load || []) {
      for (const id of selector.rules || []) if (!rules.some(rule => available.has(capabilityId(rule.capability)) && [rule.id, rule.name, rule.path, rule.file].includes(id))) warnings.push(`${source}: pinned rule '${id}' is absent from installed capabilities; ignored`);
      const capabilities = selector.group ? groups[selector.group] || [] : selector.capabilities || installed;
      const selectedCaps = capabilities.filter(id => available.has(id));
      let candidates;
      if (relations && (selector.enforcement || selector.capabilities || selector.group)) {
        candidates = new Set(selectedCaps.flatMap(id => {
          const keys = Object.keys(relations.index.capabilities).filter(key => capabilityId(key) === id);
          return keys.flatMap(key => relations.rulesForCapability(key, selector.enforcement));
        }).map(id => relations.index.rules[id]?.path));
      }
      for (const rule of rules) {
        if (rule.type === 'behavior' || rule.behavior) continue;
        const cap = capabilityId(rule.capability);
        if (!available.has(cap)) continue;
        if (!selectedCaps.includes(cap)) continue;
        if (selector.rules && !selector.rules.some(id => [rule.id, rule.name, rule.path, rule.file].includes(id))) continue;
        if (selector.enforcement && !selector.enforcement.includes(rule.enforcement?.toLowerCase())) continue;
        if (candidates && selector.enforcement && indexedPaths.has(rule.indexedPath || rule.path) && !candidates.has(rule.path) && !candidates.has(rule.indexedPath)) continue;
        const id = rule.id || rule.path || rule.file || rule.name;
        const pin = pins.get(id) || { ...rule, id, canonical_activation: rule.activation, activation: 'kernel', matches: [] };
        if (!pin.matches.some(match => match.source === source && selectorKey(match.selector) === selectorKey(selector))) pin.matches.push({ source, selector });
        pins.set(id, pin);
      }
    }
  }
  return { rules: [...pins.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings: [...new Set(warnings)] };
}
