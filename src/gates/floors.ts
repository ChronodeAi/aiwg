import { validateGateDocument } from './schema.js';
import { splitPackId } from './registry.js';
import type { GateOutcome, GatePack, GateParentPin } from './types.js';

/**
 * Project gate floors (`aiwg.config` `gates`, #2832).
 *
 * Floors are project policy: gate minima that every binding in the project
 * must include and tighten. A floor is either an inline floor pack (project:
 * policy, validated here against the closed GatePack schema) or a reference
 * to a registered pack whose composed (extends-resolved) gates all become
 * floors. The registry verifies pack-reference pins and re-derives
 * composition; the evaluator enforces floors during its internal resolution.
 *
 * Floors are a trusted caller input, in the same trust class as
 * `trustedBindingDigest` and the sealed holdout record: the caller loads them
 * from `.aiwg/aiwg.config` (via `validateGatesConfig` + `resolveProjectFloors`)
 * and passes them to `resolveGateBinding`/`GateRegistry.resolveBinding`/
 * `evaluateGates`. An absent (`undefined`) floors input disables the check
 * entirely, so existing behavior is byte-identical when floors are not used.
 */

/** One project floor source: an inline pack or a pin over a registered pack. */
export type ProjectFloorSource =
  | { pack: GatePack }
  | { packRef: GateParentPin };

/**
 * The `gates` section of `.aiwg/aiwg.config`, as stored (as-authored).
 * `resolveProjectFloors` injects the operator default when the project does
 * not govern the integrity ceiling itself.
 */
export interface ProjectFloors {
  /** Floor packs or pack references. Empty or absent means unconfigured. */
  floors?: ProjectFloorSource[];
  /** Per-study outcome ceilings keyed by binding `metadata.id`. */
  ceilings?: Record<string, GateOutcome>;
}

const OUTCOME_RANK: Record<GateOutcome, number> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };

const OUTCOMES: readonly GateOutcome[] = ['PROMOTE', 'HOLD', 'ROLLBACK'];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Operator default floor (ADR section 12): every decision study observes the
 * eval-integrity ceiling. The gate carries no `floor` flag, so bindings need
 * only match its shape (an `upstream-ceiling` gate over `all` scopes); the
 * floor-ness comes from project policy, not from the binding.
 */
export const DEFAULT_PROJECT_FLOOR_PACK: GatePack = {
  apiVersion: 'gates.aiwg.io/v1alpha1',
  kind: 'GatePack',
  metadata: {
    id: 'project:default-floors',
    version: '1.0.0',
    description: 'Operator default project floor: every decision study observes the eval-integrity ceiling.',
  },
  spec: {
    metrics: {},
    gates: [
      {
        id: 'integrity-ceiling',
        kind: 'upstream-ceiling',
        description: 'Eval-integrity ceiling: compromise rolls back, allowlist problems hold.',
        scope: { mode: 'all' },
        onFail: 'HOLD',
        direction: 'higher-is-stricter',
      },
    ],
  },
};

/**
 * A binding ceiling satisfies the configured per-study ceiling when it is at
 * least as strict. An absent configured ceiling is always satisfied.
 */
export function projectCeilingSatisfied(
  declared: GateOutcome | undefined,
  configured: GateOutcome | undefined,
): boolean {
  if (configured === undefined) return true;
  return OUTCOME_RANK[declared ?? 'PROMOTE'] >= OUTCOME_RANK[configured];
}

/**
 * Resolves the effective project floors: the configured entries plus the
 * operator default integrity-ceiling pack, unless the project already governs
 * a gate with id `integrity-ceiling` in an inline floor pack. Pack references
 * cannot suppress the default (their gates are only known after registry
 * resolution); a redundant ceiling is satisfiable whenever the referenced
 * pack uses the same all-scoped shape, and any conflict fails closed at
 * resolution with a diagnostic.
 */
export function resolveProjectFloors(gates?: ProjectFloors): ProjectFloors {
  const floors: ProjectFloorSource[] = [...(gates?.floors ?? [])];
  const governsIntegrityCeiling = floors.some(source =>
    'pack' in source && source.pack.spec.gates.some(gate => gate.id === 'integrity-ceiling'));
  if (!governsIntegrityCeiling) floors.push({ pack: DEFAULT_PROJECT_FLOOR_PACK });
  return { floors, ceilings: { ...(gates?.ceilings ?? {}) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates the `gates` section of `.aiwg/aiwg.config`, returning human-readable
 * error strings (empty = valid). Follows the hand-rolled aiwg.config convention
 * (`validateIndexConfig`, `validateExternalLinks`): unknown fields, non-literal
 * shapes and unparseable pins fail closed here, before any binding resolves.
 * Inline floor packs are validated against the closed GatePack schema, and
 * their ids must use the `project:` namespace; pack references may point at
 * any registered pack (typically an `aiwg:` pack such as the integrity-ceiling
 * pack, or a `project:` pack).
 */
export function validateGatesConfig(gates: unknown): string[] {
  if (gates === undefined || gates === null) return [];
  if (!isRecord(gates)) return ['gates: must be an object'];
  const errors: string[] = [];
  for (const field of Object.keys(gates)) {
    if (field !== 'floors' && field !== 'ceilings') errors.push(`gates.${field}: unknown field`);
  }
  if (gates.floors !== undefined) {
    if (!Array.isArray(gates.floors)) {
      errors.push('gates.floors: must be an array');
    } else {
      gates.floors.forEach((entry, index) => {
        errors.push(...validateFloorSource(entry, `gates.floors[${index}]`));
      });
    }
  }
  if (gates.ceilings !== undefined) {
    if (!isRecord(gates.ceilings)) {
      errors.push('gates.ceilings: must be an object mapping study ids to outcome ceilings');
    } else {
      for (const [study, ceiling] of Object.entries(gates.ceilings)) {
        if (!study.trim()) errors.push('gates.ceilings: study id must be a non-empty string');
        else if (typeof ceiling !== 'string' || !(OUTCOMES as readonly string[]).includes(ceiling)) {
          errors.push(`gates.ceilings.${study}: must be PROMOTE, HOLD or ROLLBACK`);
        }
      }
    }
  }
  return errors;
}

function validateFloorSource(entry: unknown, where: string): string[] {
  if (!isRecord(entry)) return [`${where}: must be an object with exactly one of 'pack' or 'packRef'`];
  const keys = Object.keys(entry);
  const unknown = keys.filter(key => key !== 'pack' && key !== 'packRef');
  if (unknown.length) return [`${where}.${unknown[0]}: unknown field`];
  if (entry.pack !== undefined && entry.packRef !== undefined) {
    return [`${where}: must set exactly one of 'pack' or 'packRef'`];
  }
  if (entry.pack !== undefined) return validateInlineFloorPack(entry.pack, where);
  if (entry.packRef !== undefined) return validateFloorPackRef(entry.packRef, where);
  return [`${where}: must set exactly one of 'pack' or 'packRef'`];
}

function validateInlineFloorPack(pack: unknown, where: string): string[] {
  let parsed: GatePack;
  try {
    parsed = validateGateDocument<GatePack>(pack);
  } catch (error) {
    return [`${where}.pack: ${error instanceof Error ? error.message : 'invalid gate pack'}`];
  }
  if (parsed.kind !== 'GatePack') return [`${where}.pack: floor pack must have kind GatePack`];
  try {
    const { namespace } = splitPackId(parsed.metadata.id);
    if (namespace !== 'project') {
      return [`${where}.pack: floor pack id must use the project: namespace (got '${parsed.metadata.id}')`];
    }
  } catch (error) {
    return [`${where}.pack: ${error instanceof Error ? error.message : 'invalid pack id'}`];
  }
  return [];
}

function validateFloorPackRef(packRef: unknown, where: string): string[] {
  if (!isRecord(packRef)) return [`${where}.packRef: must be an object`];
  const errors: string[] = [];
  for (const field of Object.keys(packRef)) {
    if (field !== 'id' && field !== 'version' && field !== 'digest') {
      errors.push(`${where}.packRef.${field}: unknown field`);
    }
  }
  if (typeof packRef.id !== 'string' || !packRef.id) {
    errors.push(`${where}.packRef.id: required, must be a non-empty string`);
  } else {
    try {
      splitPackId(packRef.id);
    } catch (error) {
      errors.push(`${where}.packRef.id: ${error instanceof Error ? error.message : 'invalid pack id'}`);
    }
  }
  if (typeof packRef.version !== 'string' || !VERSION_PATTERN.test(packRef.version)) {
    errors.push(`${where}.packRef.version: required, must be a semantic version (X.Y.Z)`);
  }
  if (typeof packRef.digest !== 'string' || !DIGEST_PATTERN.test(packRef.digest)) {
    errors.push(`${where}.packRef.digest: required, must be a sha256 digest`);
  }
  return errors;
}
