/** Reproducible build-time binding/configuration projection. No deploy side effects. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRelations } from './relations-builder.js';
import { frameworkSourceDigest } from './framework-source-digest.js';
import { PREBUILT_RELATIONS_DIR, type RelationsIndex, type RelationsStamp, type RelationTargetType } from './relations.js';
import type { MetadataEntry } from './types.js';
import { PROVIDER_IDS } from '../providers/provider-definitions.js';
import { parseRuleFrontmatter, inferRuleActivation } from '../rules/activation.mjs';

export interface ResolvedBindings {
  schema_version: 'aiwg.bindings.resolved.v1';
  rules: Record<string, {
    activation: string;
    tagged: boolean;
    summary: string;
    targets: Record<RelationTargetType, string[]>;
  }>;
  targets: RelationsIndex['targets'];
  providers: Record<string, {
    kernel: string[]; summary: string[]; native_paths: string[];
    discoverable_paths: string[]; bound: string[]; on_demand: string[];
  }>;
}

/** Sets describe the corpus projection before mode selection, tier filters or operator pins. */
export function buildResolvedBindings(root: string, relations: RelationsIndex): ResolvedBindings {
  const table: ResolvedBindings = { schema_version: 'aiwg.bindings.resolved.v1', rules: {}, targets: relations.targets, providers: {} };
  for (const provider of PROVIDER_IDS) table.providers[provider] = { kernel: [], summary: [], native_paths: [], discoverable_paths: [], bound: [], on_demand: [] };
  for (const [id, rule] of Object.entries(relations.rules)) {
    const parsed = parseRuleFrontmatter(fs.readFileSync(path.join(root, rule.path), 'utf8'));
    const tagged = Boolean(parsed.rule?.tagged);
    const activation = tagged ? parsed.rule!.activation : rule.type === 'behavior' ? 'kernel' : inferRuleActivation(rule.enforcement);
    const targets: ResolvedBindings['rules'][string]['targets'] = { skill: [], agent: [], flow: [], command: [] };
    for (const target of rule.targets) targets[target.type].push(target.id);
    table.rules[id] = { activation, tagged, summary: parsed.rule?.summary ?? rule.summary, targets };
    for (const [provider, projection] of Object.entries(table.providers)) {
      if (activation === 'kernel') {
        const hermesDeferred = provider === 'hermes' && tagged && String(parsed.rule?.enforcement ?? '').toLowerCase() !== 'critical';
        projection[hermesDeferred ? 'summary' : 'kernel'].push(id);
      } else if (activation === 'paths') projection[['claude', 'cursor'].includes(provider) ? 'native_paths' : 'discoverable_paths'].push(id);
      else if (activation === 'bound') projection.bound.push(id);
      else if (activation === 'summary') projection.summary.push(id);
      else projection.on_demand.push(id);
    }
  }
  return table;
}

export function buildPrebuiltRelations(root: string, entries: MetadataEntry[]): Record<'relations.json' | 'bindings.json' | 'manifest.json', string> {
  const relations = buildRelations(entries);
  const relationText = JSON.stringify(relations, null, 2);
  const bindingText = JSON.stringify(buildResolvedBindings(root, relations), null, 2) + '\n';
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
  const stamp: RelationsStamp = {
    schema_version: 'aiwg.relationships.prebuilt.v1',
    package_version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    source_digest: frameworkSourceDigest(root, false), generated_at: relations.generatedAt,
    checksums: { 'relations.json': hash(relationText), 'bindings.json': hash(bindingText) },
  };
  return { 'relations.json': relationText, 'bindings.json': bindingText, 'manifest.json': JSON.stringify(stamp, null, 2) + '\n' };
}

export function checkPrebuiltRelations(root: string): string[] {
  const dir = path.join(root, PREBUILT_RELATIONS_DIR);
  const errors: string[] = [];
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RelationsStamp;
    if (stamp.schema_version !== 'aiwg.relationships.prebuilt.v1') errors.push('unsupported relationship manifest schema');
    if (stamp.package_version !== JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version) errors.push('relationship package version differs');
    if (stamp.source_digest !== frameworkSourceDigest(root, false)) errors.push('relationship source digest differs; run npm run release:fortemi-index');
    for (const file of ['relations.json', 'bindings.json'] as const) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (createHash('sha256').update(text).digest('hex') !== stamp.checksums[file]) errors.push(`${file} checksum differs`);
      const table = JSON.parse(text);
      if (file === 'bindings.json' && table.schema_version !== 'aiwg.bindings.resolved.v1') errors.push('unsupported resolved binding table schema');
      if (file === 'relations.json' && (table.version !== 1 || !table.artifacts || !table.rules || !table.targets)) errors.push('unsupported relationship table schema');
    }
  } catch (error) { errors.push(`relationship tables unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  return errors;
}
