/** Shared read-only inventory for pin commands, discovery, status, doctor and show. */
import fs from 'node:fs';
import path from 'node:path';
import { loadRelations } from '../artifacts/relations.js';
import { parseRuleFrontmatter, inferRuleActivation } from './activation.mjs';
import { loadRulePinConfigs, installedRuleCapabilities, resolveRulePins, capabilityId, type PinConfigs, type PinRule } from './pins.mjs';

export function ruleFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? ruleFiles(path.join(dir, entry.name)) : entry.name.endsWith('.md') && !/^RULES-(INDEX|ONDEMAND)/.test(entry.name) ? [path.join(dir, entry.name)] : []);
}
function localRuleSource(cwd: string, localPath: string): string {
  const wrapper = path.resolve(cwd, localPath);
  const manifest = path.join(wrapper, 'manifest.json');
  if (!fs.existsSync(manifest)) return wrapper;
  const payload = JSON.parse(fs.readFileSync(manifest, 'utf8')).pluginConfig?.payloadPath;
  if (!payload) return wrapper;
  const source = path.resolve(wrapper, payload);
  const relative = path.relative(wrapper, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`${manifest}: plugin payload must remain beneath its wrapper`);
  const realRelative = path.relative(fs.realpathSync(wrapper), fs.realpathSync(source));
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`${manifest}: plugin payload escapes its wrapper`);
  return source;
}

export function rulePinState(cwd: string, root: string, configs: PinConfigs = loadRulePinConfigs(cwd), requireInventory = false, cacheSourceDigest = true) {
  const installed = installedRuleCapabilities(configs);
  if (!requireInventory && !configs.project.rules?.always_load?.length && !configs.user.rules?.always_load?.length) {
    return { ...resolveRulePins({ rules: [], configs, installed }), installed, configs, inventory: [] as PinRule[] };
  }
  const relations = loadRelations(cwd, cwd, cacheSourceDigest) ?? loadRelations(root, cwd, cacheSourceDigest);
  const rules: PinRule[] = [];
  const seen = new Set<string>();
  if (relations) for (const [id, rule] of Object.entries(relations.index.rules)) {
    if (!installed.includes(capabilityId(rule.capability) ?? '') || rule.type !== 'rule') continue;
    const file = path.resolve(root, rule.path);
    // A stale sidecar must never retain an uninstalled or removed body.
    if (!fs.existsSync(file)) continue;
    seen.add(file);
    rules.push({ ...rule, id, indexedPath: rule.path, path: file, file });
  }
  for (const capability of installed) {
    const entry = configs.project.installed?.[capability] as { localPath?: string } | undefined;
    const dirs = entry?.localPath ? [localRuleSource(cwd, entry.localPath)]
      : ['frameworks', 'addons', 'extensions', 'plugins'].map(kind => path.join(root, 'agentic/code', kind, capability));
    for (const dir of dirs) for (const file of ruleFiles(path.join(dir, 'rules'))) {
      if (seen.has(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const parsed = parseRuleFrontmatter(content);
      if (!parsed.valid) throw new Error(`${file}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
      const data = parsed.data as Record<string, unknown>;
      const enforcement = String(data.enforcement ?? content.match(/^\*\*Enforcement Level\*\*:\s*([A-Za-z]+)/m)?.[1] ?? '').toLowerCase() || null;
      rules.push({ id: file, name: String(data.name || path.basename(file, '.md')), path: file, file,
        indexedPath: path.relative(root, file), capability, enforcement,
        activation: parsed.rule.tagged ? parsed.rule.activation : inferRuleActivation(enforcement) });
      seen.add(file);
    }
  }
  // The source fallback covers project-local bundles or a fresh install with no sidecar.
  const effective = resolveRulePins({ rules, configs, installed, relations });
  return { ...effective, installed, configs, inventory: rules };
}
