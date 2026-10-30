/** Read rule sources and report declared gate coverage without executing gates. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildGatesRegistry, installedAiwgRoot, type GatesDriverOptions } from '../gates/driver.js';
import { parseRuleFrontmatter } from './activation.mjs';
import { ruleFiles } from './pin-state.js';
import { ruleGateReferenceErrors } from './gate-references.js';

export interface RuleGateCoverage {
  id: string;
  name: string;
  file: string;
  enforcedBy: string[];
  status: 'gate-backed' | 'guidance-only';
}

function bundleRuleDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'rules'));
}

export function listRuleGateCoverage(options: GatesDriverOptions = {}, ruleId?: string): RuleGateCoverage[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const root = path.resolve(options.aiwgRoot ?? installedAiwgRoot());
  const dirs = [path.join(cwd, 'rules'), path.join(cwd, '.aiwg/rules')];
  for (const group of ['frameworks', 'addons', 'extensions']) {
    dirs.push(...bundleRuleDirs(path.join(root, 'agentic/code', group)), ...bundleRuleDirs(path.join(cwd, '.aiwg', group)));
  }
  for (const candidate of options.packDirs ?? []) {
    const dir = path.resolve(cwd, candidate);
    if (statSync(dir).isDirectory()) dirs.push(path.join(dir, 'rules'));
  }
  const files = [...new Set(dirs.flatMap(ruleFiles))].sort().filter(file =>
    !/^(?:README|RULES-INDEX|RULES-ONDEMAND)\.md$/.test(path.basename(file)) && !file.endsWith('.core.md'));
  const { registry } = buildGatesRegistry(options);
  const rules: RuleGateCoverage[] = [];
  for (const file of files) {
    const name = path.basename(file, '.md');
    const id = path.relative(file.startsWith(`${root}${path.sep}`) ? root : cwd, file).split(path.sep).join('/');
    // Match exact names or source identities; suffix guesses can select another rule.
    if (ruleId && ![name, id, file].includes(ruleId)) continue;
    const parsed = parseRuleFrontmatter(readFileSync(file, 'utf8'));
    if (!parsed.valid) throw new Error(`${file}: ${parsed.diagnostics.map(item => item.message).join('; ')}`);
    const enforcedBy = parsed.rule.enforcedBy ?? [];
    const errors = ruleGateReferenceErrors(enforcedBy, registry);
    if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
    rules.push({ id, name, file, enforcedBy, status: enforcedBy.length ? 'gate-backed' : 'guidance-only' });
  }
  return rules;
}

export function formatRuleGateCoverage(rules: RuleGateCoverage[]): string {
  if (!rules.length) return 'No rules found.';
  return rules.map(rule => `${rule.id}: ${rule.status}${rule.enforcedBy.length ? `\n${rule.enforcedBy.map(gate => `  ${gate}`).join('\n')}` : ''}`).join('\n');
}
