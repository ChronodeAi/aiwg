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
 * `evaluateGates`. `evaluateGates` requires the input (pass
 * `'none-explicit-opt-out'` only for tests or legacy callers with a
 * documented reason); `resolveGateBinding` still accepts an absent input,
 * which skips the check exactly like the pre-floors path.
 */

/** One project floor source: an inline pack or a pin over a registered pack. */
export type ProjectFloorSource =
  | { pack: GatePack }
  | { packRef: GateParentPin };

/**
 * The `gates` section of `.aiwg/aiwg.config`, as stored (as-authored).
 * The operator default integrity-ceiling floor is applied at expansion time
 * (`expandFloorPacks` in `registry.ts`) from the shipped
 * `aiwg:decision-engine/integrity-ceiling` pack, so it needs no entry here.
 */
export interface ProjectFloors {
  /** Floor packs or pack references. Empty or absent means unconfigured. */
  floors?: ProjectFloorSource[];
  /**
   * Outcome ceilings: exact binding `metadata.id` keys, plus the `'*'` key
   * as the project-wide default applied to every binding. A per-study key
   * may only tighten the `'*'` default, never loosen it (rename escapes:
   * `study-a-v2` never inherits `study-a`'s ceiling).
   */
  ceilings?: Record<string, GateOutcome>;
}

const OUTCOME_RANK: Record<GateOutcome, number> = { PROMOTE: 0, HOLD: 1, ROLLBACK: 2 };

const OUTCOMES: readonly GateOutcome[] = ['PROMOTE', 'HOLD', 'ROLLBACK'];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Operator default floor (ADR section 12): every decision study observes the
 * eval-integrity ceiling. This is a reference to the shipped
 * `aiwg:decision-engine/integrity-ceiling` pack — the single source of truth
 * — applied at expansion time (`expandFloorPacks`), never an inline copy.
 * The default is suppressed only by a configured floor gate with id
 * `integrity-ceiling` that is an all-scoped `upstream-ceiling` gate
 * tightening the shipped gate (floor flag included).
 */
export const INTEGRITY_CEILING_FLOOR_PACK_ID = 'aiwg:decision-engine/integrity-ceiling';
export const INTEGRITY_CEILING_FLOOR_PACK_VERSION = '1.0.0';

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
 * Resolves the effective project floors: the configured entries, verbatim.
 * The operator default integrity-ceiling floor is NOT injected here — it is
 * applied at expansion time (`expandFloorPacks`) from the shipped
 * `aiwg:decision-engine/integrity-ceiling` pack, where the registry can prove
 * (via `assertGateTightens`) whether a configured floor genuinely tightens
 * it. A same-id gate that is not an all-scoped `upstream-ceiling` tightening
 * never suppresses the default; it is flagged by `validateGatesConfig` and
 * fails closed at resolution.
 */
export function resolveProjectFloors(gates?: ProjectFloors): ProjectFloors {
  return { floors: [...(gates?.floors ?? [])], ceilings: { ...(gates?.ceilings ?? {}) } };
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
      const star = (gates.ceilings as Record<string, unknown>)['*'];
      if (typeof star === 'string' && (OUTCOMES as readonly string[]).includes(star)) {
        for (const [study, ceiling] of Object.entries(gates.ceilings)) {
          if (study !== '*' && typeof ceiling === 'string'
            && (OUTCOMES as readonly string[]).includes(ceiling)
            && OUTCOME_RANK[ceiling as GateOutcome] < OUTCOME_RANK[star as GateOutcome]) {
            errors.push(`gates.ceilings.${study}: must tighten the project default ceiling ${star}, not loosen it`);
          }
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
  const errors: string[] = [];
  for (const gate of parsed.spec.gates) {
    if (gate.id === 'integrity-ceiling'
      && (gate.kind !== 'upstream-ceiling' || gate.scope.mode !== 'all')) {
      errors.push(`${where}.pack: floor gate 'integrity-ceiling' must be an all-scoped upstream-ceiling gate`
        + ` to govern the default ceiling (a weaker same-id gate never suppresses it;`
        + ` full tightening against the shipped pack is enforced at resolution)`);
    }
  }
  return errors;
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
