import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseYamlSimple } from './user-config.js';
import { resolveUserConfigDir } from './user-config-dir.mjs';

/** Project decision settings. No credentials or provider setup lives here. */
export interface DecisionConfig {
  /** Persistent runtime opt-in; environment overrides project, then user config. */
  enabled?: boolean;
  /** Ask sampling: product default 5 passes, escalating to twice that. */
  ask?: {
    passes?: number;
    escalation_passes?: number;
    /** Omit to disable agreement acceptance. */
    min_agreement?: number;
    agreement_confidence_floor?: number;
  };
}

export interface DecisionEnablementOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface DecisionEnablement {
  enabled: boolean;
  source: 'env' | 'project' | 'user' | 'default';
}

export function validateDecisionConfig(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['decision must be an object'];
  const errors: string[] = [];
  const { enabled, ask } = value as DecisionConfig;
  if (enabled !== undefined && typeof enabled !== 'boolean') errors.push('decision.enabled must be a boolean');
  if (ask === undefined) return errors;
  if (!ask || typeof ask !== 'object' || Array.isArray(ask)) return [...errors, 'decision.ask must be an object'];
  const sampling: string[] = [];
  for (const key of ['passes', 'escalation_passes'] as const) {
    if (ask[key] !== undefined && (!Number.isSafeInteger(ask[key]) || ask[key]! <= 0)) {
      sampling.push(`decision.ask.${key} must be a positive safe integer`);
    }
  }
  if (!sampling.length && ask.escalation_passes !== undefined && ask.escalation_passes < (ask.passes ?? 5)) {
    sampling.push('decision.ask.escalation_passes must be >= decision.ask.passes');
  }
  for (const key of ['min_agreement', 'agreement_confidence_floor'] as const) {
    if (ask[key] !== undefined && (typeof ask[key] !== 'number' || !Number.isFinite(ask[key]) || ask[key]! < 0 || ask[key]! > 1)) {
      sampling.push(`decision.ask.${key} must be a probability from 0 to 1`);
    }
  }
  return [...errors, ...sampling];
}

function readEnabled(filePath: string, yaml = false): boolean | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const config = (yaml ? parseYamlSimple(content) : JSON.parse(content)) as { decision?: unknown };
  const errors = validateDecisionConfig(config.decision);
  if (errors.length) throw new Error(`${filePath}: ${errors.join('; ')}`);
  return (config.decision as DecisionConfig | undefined)?.enabled;
}

/** Resolve only enablement; never read credentials or probe a backend. */
export function resolveDecisionEnablement(options: DecisionEnablementOptions = {}): DecisionEnablement {
  const env = options.env ?? process.env;
  if (env.AIWG_DECISION_ENABLED === '0' || env.AIWG_DECISION_ENABLED === '1') {
    return { enabled: env.AIWG_DECISION_ENABLED === '1', source: 'env' };
  }
  const project = readEnabled(path.join(options.cwd ?? process.cwd(), '.aiwg', 'aiwg.config'));
  if (project !== undefined) return { enabled: project, source: 'project' };
  const user = readEnabled(path.join(resolveUserConfigDir({ env, homeDir: options.homeDir }), 'config.yaml'), true);
  if (user !== undefined) return { enabled: user, source: 'user' };
  return { enabled: false, source: 'default' };
}
