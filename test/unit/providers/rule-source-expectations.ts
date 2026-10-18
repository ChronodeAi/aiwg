// Independent corpus expectations: do not reuse the deployment selectors under test.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export function sourceRules(root: string, kind: 'addons' | 'frameworks' | 'extensions', includeExplicit = false) {
  const base = join(root, 'agentic/code', kind);
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const bundle = join(base, entry.name);
    const manifest = existsSync(join(bundle, 'manifest.json'))
      ? JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) : {};
    if (kind === 'addons' && (manifest.devOnly || manifest.explicitInstall && !includeExplicit)) return [];
    const dir = join(bundle, manifest.entry?.rules || 'rules');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'README.md').map(name => {
      const file = join(dir, name);
      const content = readFileSync(file, 'utf8');
      const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const data = parse(header?.[1] || '') || {};
      const level = String(data.enforcement || content.match(/\*\*Enforcement Level\*\*:\s*(\w+)/i)?.[1] || '').toLowerCase();
      const structural = /^RULES-(INDEX|ONDEMAND)\.md$/.test(name);
      // ADR 50–61, 265–272: activation overrides severity; only missing
      // activation uses tier fallback. Indexes are structural exceptions.
      const activation = data.activation ?? (['medium', 'low'].includes(level) ? 'on-demand' : 'kernel');
      return { file, name: name.slice(0, -3), content, data, structural, activation,
        body: content.slice(header?.[0].length || 0).trim(),
        fileDelivered: structural || ['kernel', 'paths'].includes(activation),
        legacyOnDemand: !structural && data.activation === undefined && activation === 'on-demand',
        // Consolidation suppresses only legacy untagged body delivery. An
        // authored activation contract remains authoritative for tagged rules.
        consolidated: data.activation === undefined && kind === 'addons'
          && manifest.consolidation?.deployIndexOnly === true };
    });
  });
}

/** The SDLC deploy selects its framework plus non-explicit, non-dev addons. */
export function sdlcDeploymentRules(root: string) {
  return [...sourceRules(root, 'addons'), ...sourceRules(root, 'frameworks').filter(rule =>
    rule.file.startsWith(join(root, 'agentic/code/frameworks/sdlc-complete') + '/'))]
    .filter(rule => !rule.structural);
}
