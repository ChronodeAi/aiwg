import type { RulePinSelector, RulesConfig } from './inline-budget.mjs';
import type { RelationsReader } from '../artifacts/relations.js';
export interface PinConfig { installed?: Record<string, unknown>; providers?: string[]; rules?: RulesConfig }
export interface PinConfigs { project: PinConfig; user: PinConfig }
export interface PinRule { id: string; name: string; path: string; capability: string | null; activation: string | null; enforcement: string | null; type?: string; file?: string; indexedPath?: string; behavior?: boolean }
export interface PinnedRule extends PinRule { canonical_activation: string | null; activation: 'kernel'; matches: Array<{ source: 'user' | 'project'; selector: RulePinSelector }> }
export const RULE_PIN_TIERS: string[];
export function rulePinConfigPath(cwd: string, source?: 'user' | 'project', userConfigDir?: string): string;
export function loadRulePinConfigs(cwd: string, project?: PinConfig, userConfigDir?: string): PinConfigs;
export function capabilityId(id: string | null): string | null;
export function installedRuleCapabilities(configs: PinConfigs): string[];
export function validateRulePinCapabilities(rules: unknown, installed: string[], groups?: Record<string, string[]>): string[];
export function selectorKey(selector: RulePinSelector): string;
export function resolveRulePins(options: { rules: PinRule[]; configs: PinConfigs; installed?: string[]; relations?: RelationsReader | null }): { rules: PinnedRule[]; warnings: string[] };
