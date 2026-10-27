/** Activation checks within the existing lint runner, not a delivery selector. */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_GRAPH_CONFIGS, type MetadataEntry } from '../artifacts/types.js';
import { resolveRuleBindingTarget } from '../artifacts/query-engine.js';
import { collectRuleBindingEntries } from '../artifacts/index-builder.js';
import { resolveFrameworkIndexRoot } from '../artifacts/framework-index-paths.js';
import { parseRuleFrontmatter, RULE_BINDING_TYPES, coreBodyPath, validateCoreBody } from '../rules/activation.mjs';
import type { LintDiagnostic, LintRuleset } from './types.js';

export const ruleActivationRuleset: LintRuleset = {
  id: 'rule-activation', name: 'Rule activation', framework: 'core', version: '1.0.0',
  description: 'Validate rule and behavior activation contracts and exact source bindings',
  rules: [{
    id: 'rules/activation', name: 'Rule activation contract', severity: 'error',
    description: 'Validate activation, summaries, paths, bindings, and migration fallback',
    appliesTo: { glob: '**/{rules/**/*.md,behaviors/**/BEHAVIOR.md}' },
    checks: [{ type: 'rule-activation' }],
  }],
};

/** Load the index builder's canonical binding metadata without reading or writing an index. */
export async function loadRuleActivationEntries(projectRoot: string): Promise<MetadataEntry[]> {
  const root = resolveFrameworkIndexRoot(projectRoot);
  const snapshots = await Promise.all(BUILTIN_GRAPH_CONFIGS.framework.scanDirs.map(scope => collectRuleBindingEntries(root, scope)));
  return snapshots.flat();
}

/** Validate one rule against the source snapshot supplied by the lint runner. */
export function lintRuleActivation(
  content: string, file: string, projectRoot: string, entries: MetadataEntry[] = [], absolutePath?: string,
): LintDiagnostic[] {
  // Directory documentation and generated indexes are not authored rules.
  if (/^(?:README|RULES-INDEX|RULES-ONDEMAND)\.md$/.test(file.split('/').pop()!)) return [];
  // <rule>.core.md is a delivery body (#3450), validated through its owning rule.
  if (/\.core\.md$/.test(file)) return [];
  const shipped = /(?:^|\/)agentic\/code\//.test((absolutePath ?? path.resolve(projectRoot, file)).replaceAll('\\', '/'));
  const result = parseRuleFrontmatter(content);
  const diagnostics = result.diagnostics.map(item => ({
    ruleId: 'rules/activation', ruleName: 'Rule activation contract',
    file, severity: item.code === 'missing-activation' && shipped ? 'error' as const : item.severity, message: item.message,
  }));
  if (!result.rule) return diagnostics;
  if (result.rule.activation === 'core') {
    const body = coreBodyPath(absolutePath ?? (path.isAbsolute(file) ? file : path.resolve(projectRoot, file)));
    const problems = fs.existsSync(body)
      ? validateCoreBody(fs.readFileSync(body, 'utf8').trim(), path.basename(body))
      : [`${path.basename(body)}: activation core requires a compact body file beside the rule`];
    for (const message of problems) diagnostics.push({ ruleId: 'rules/activation', ruleName: 'Rule activation contract', file, severity: 'error', message });
  }
  const bindings = result.rule.bound_to;
  if (!Object.values(bindings).some(list => list.length > 0)) return diagnostics;
  // Preserve exact identities and show precedence using current source metadata.
  for (const key of Object.keys(RULE_BINDING_TYPES) as Array<keyof typeof RULE_BINDING_TYPES>) {
    for (const id of bindings[key]) {
      try {
        resolveRuleBindingTarget(entries, RULE_BINDING_TYPES[key], id);
      } catch (error) {
        diagnostics.push({ ruleId: 'rules/activation', ruleName: 'Rule activation contract',
          file, severity: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return diagnostics;
}
