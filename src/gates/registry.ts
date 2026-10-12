import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from '../decision/validate.js';
import type { MetricProviderRegistry } from './providers/registry.js';
import { validateGateDocument } from './schema.js';
import type {
  ArtifactPinLike, GateBinding, GateDefinition, GateOutcome, GatePack, GateParameter, GateParamRef, Sha256Digest,
} from './types.js';
import { qualifyGateParameter } from './types.js';
import { INTEGRITY_CEILING_FLOOR_PACK_ID, assertCeilingDefaults, projectCeilingSatisfied } from './floors.js';
import type { ProjectFloors } from './floors.js';

export class GateRegistryError extends Error {
  constructor(message: string) { super(message); this.name = 'GateRegistryError'; }
}

export const GATE_NAMESPACES = ['aiwg', 'framework', 'addon', 'extension', 'project'] as const;
export type GateNamespace = typeof GATE_NAMESPACES[number];

export function splitPackId(id: unknown): { namespace: GateNamespace; rest: string } {
  if (typeof id !== 'string') throw new GateRegistryError('pack id must be a string');
  const separator = id.indexOf(':');
  const namespace = separator < 0 ? '' : id.slice(0, separator);
  const rest = separator < 0 ? '' : id.slice(separator + 1);
  if (!(GATE_NAMESPACES as readonly string[]).includes(namespace) || !rest || /\s/.test(rest)) {
    throw new GateRegistryError(`pack id must be <namespace>:<path> with namespace ${GATE_NAMESPACES.join('/')}: '${id}'`);
  }
  if (namespace === 'project') {
    if (rest.includes(':') || rest.includes('/')) throw new GateRegistryError(`project pack ids are project:<name>: '${id}'`);
  } else if (!/^[^/\s:]+\/[^/\s:]+$/.test(rest)) {
    throw new GateRegistryError(`pack id must be <namespace>:<bundle>/<name>: '${id}'`);
  }
  return { namespace: namespace as GateNamespace, rest };
}

const fail = (message: string): never => { throw new GateRegistryError(message); };

const STATISTICAL_KINDS = ['interval-bound', 'paired-difference', 'bootstrap-bound'] as const;

function checkThresholdBlock(gate: GateDefinition, params: Record<string, GateParameter>): void {
  const needsThreshold = gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound'
    || gate.kind === 'count-max' || gate.kind === 'count-min' || gate.kind === 'value-threshold';
  const threshold = gate.threshold;
  if (threshold === undefined) {
    if (needsThreshold) fail(`gate ${gate.id} of kind ${gate.kind} requires a threshold`);
    return;
  }
  if (!needsThreshold) fail(`gate ${gate.id} of kind ${gate.kind} must not carry a threshold`);
  const param = threshold.param === undefined ? undefined : params[threshold.param];
  if (threshold.param !== undefined && param === undefined) fail(`gate ${gate.id} references unknown parameter '${threshold.param}'`);
  const expectedParamType = gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound' ? 'bps'
    : gate.kind === 'count-max' || gate.kind === 'count-min' ? 'count' : 'value';
  if (param !== undefined && param.type !== expectedParamType) {
    fail(`gate ${gate.id} parameter '${threshold.param}' must have type ${expectedParamType}`);
  }
  if (threshold.value !== undefined) {
    if (!Number.isFinite(threshold.value)) fail(`gate ${gate.id} threshold value must be finite`);
    if (expectedParamType === 'bps' && (threshold.value < 0 || threshold.value > 10000)) {
      fail(`gate ${gate.id} threshold must be within 0..10000 bps`);
    }
    if (expectedParamType === 'count' && (!Number.isSafeInteger(threshold.value) || threshold.value < 0)) {
      fail(`gate ${gate.id} threshold must be a non-negative integer count`);
    }
  }
  const op = gate.kind === 'count-max' ? 'lte' : gate.kind === 'count-min' ? 'gte' : threshold.op;
  if (gate.kind === 'count-max' && threshold.op !== 'lte') fail(`gate ${gate.id} count-max requires op lte`);
  if (gate.kind === 'count-min' && threshold.op !== 'gte') fail(`gate ${gate.id} count-min requires op gte`);
  if (gate.kind === 'interval-bound' && gate.statistic?.bound === 'upper' && threshold.op !== 'lte') {
    fail(`gate ${gate.id} upper-bound gates require op lte`);
  }
  if (gate.kind === 'interval-bound' && gate.statistic?.bound === 'lower' && threshold.op !== 'gte') {
    fail(`gate ${gate.id} lower-bound gates require op gte`);
  }
  if (gate.kind === 'value-threshold') {
    if (threshold.op === 'lte' && gate.direction !== 'lower-is-stricter') fail(`gate ${gate.id} lte requires direction lower-is-stricter`);
    if (threshold.op === 'gte' && gate.direction !== 'higher-is-stricter') fail(`gate ${gate.id} gte requires direction higher-is-stricter`);
  }
  if (gate.kind === 'interval-bound' || gate.kind === 'bootstrap-bound') {
    if (op === 'lte' && gate.direction !== 'lower-is-stricter') fail(`gate ${gate.id} upper-bound gates require direction lower-is-stricter`);
    if (op === 'gte' && gate.direction !== 'higher-is-stricter') fail(`gate ${gate.id} lower-bound gates require direction higher-is-stricter`);
  }
}

const isParamRef = (value: unknown): value is GateParamRef =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && typeof (value as GateParamRef).param === 'string';

/**
 * Resolve a literal-or-parameter number against pack parameter defaults.
 * Returns the default for a `{param}` reference, or null when the reference
 * names an unknown parameter, the type mismatches, or no default pins it.
 */
export function resolveNumberDefault(
  value: number | GateParamRef | undefined,
  params: Record<string, GateParameter>,
  expectedType: GateParameter['type'],
): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value;
  if (!isParamRef(value)) return null;
  const declared = params[value.param];
  if (declared === undefined || declared.type !== expectedType) return null;
  return declared.default ?? null;
}

/** A literal-or-parameter reference names a known parameter of the expected type. */
function checkParamRef(
  gateId: string,
  value: number | GateParamRef | undefined,
  params: Record<string, GateParameter>,
  expectedType: GateParameter['type'],
  what: string,
): void {
  if (value === undefined || typeof value === 'number') return;
  if (!isParamRef(value) || params[value.param] === undefined) {
    fail(`gate ${gateId} ${what} references unknown parameter '${(value as GateParamRef)?.param}'`);
  }
  if (params[value.param]!.type !== expectedType) {
    fail(`gate ${gateId} ${what} parameter '${value.param}' must have type ${expectedType}`);
  }
}

/** Statistic coherence per kind. Irrelevant statistic fields are rejected so confused authoring fails at load. */
function checkStatisticBlock(gate: GateDefinition, params: Record<string, GateParameter>): void {
  const statistic = gate.statistic;
  if (statistic === undefined) {
    if ((STATISTICAL_KINDS as readonly string[]).includes(gate.kind)) {
      fail(`gate ${gate.id} of kind ${gate.kind} requires a statistic`);
    }
    return;
  }
  if (!(STATISTICAL_KINDS as readonly string[]).includes(gate.kind)) {
    fail(`gate ${gate.id} of kind ${gate.kind} must not carry a statistic`);
  }
  if (statistic.kind !== gate.kind) fail(`gate ${gate.id} statistic kind must match the gate kind`);
  const { method, bound, levelBps, mode, marginBps, seed, resamples, bounds } = statistic;
  if (gate.kind === 'interval-bound') {
    if (method !== undefined && method !== 'wilson' && method !== 'clopper-pearson') {
      fail(`gate ${gate.id} interval-bound method must be wilson or clopper-pearson`);
    }
    if (bound !== 'upper' && bound !== 'lower') fail(`gate ${gate.id} interval-bound requires bound upper|lower`);
    if (levelBps === undefined) fail(`gate ${gate.id} interval-bound requires levelBps`);
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    if (mode !== undefined || marginBps !== undefined || seed !== undefined || resamples !== undefined || bounds !== undefined) {
      fail(`gate ${gate.id} interval-bound must not carry mode, margin, seed, resamples or bounds`);
    }
  } else if (gate.kind === 'paired-difference') {
    if (method !== undefined && method !== 'newcombe' && method !== 'tango') {
      fail(`gate ${gate.id} paired-difference method must be newcombe or tango`);
    }
    if (bound !== undefined) fail(`gate ${gate.id} paired-difference must not carry bound`);
    if (levelBps === undefined) fail(`gate ${gate.id} paired-difference requires levelBps`);
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    const resolvedMode = mode ?? 'non-inferiority';
    if (resolvedMode !== 'non-inferiority' && resolvedMode !== 'superiority') fail(`gate ${gate.id} unknown paired mode`);
    if (resolvedMode === 'non-inferiority' && marginBps === undefined) fail(`gate ${gate.id} non-inferiority requires marginBps`);
    if (resolvedMode === 'non-inferiority' && marginBps !== undefined && marginBps > 0) {
      fail(`gate ${gate.id} non-inferiority marginBps must be non-positive`);
    }
    if (resolvedMode === 'superiority' && marginBps !== undefined && marginBps < 0) {
      fail(`gate ${gate.id} superiority marginBps must be non-negative`);
    }
    if (seed !== undefined || resamples !== undefined || bounds !== undefined) {
      fail(`gate ${gate.id} paired-difference must not carry seed, resamples or bounds`);
    }
  } else {
    if (method !== undefined && method !== 'bootstrap') fail(`gate ${gate.id} bootstrap-bound method must be bootstrap`);
    if (bound !== 'upper' && bound !== 'lower') fail(`gate ${gate.id} bootstrap-bound requires bound upper|lower`);
    if (levelBps === undefined || seed === undefined || resamples === undefined || bounds === undefined) {
      fail(`gate ${gate.id} bootstrap-bound requires levelBps, seed, resamples and bounds`);
    }
    checkParamRef(gate.id, levelBps, params, 'level', 'levelBps');
    if (mode !== undefined || marginBps !== undefined) fail(`gate ${gate.id} bootstrap-bound must not carry mode or margin`);
  }
}

function checkParameter(name: string, parameter: GateParameter): void {
  if (parameter.default !== undefined) {
    if (!Number.isFinite(parameter.default)) fail(`parameter ${name} default must be finite`);
    if (parameter.type === 'bps' && (parameter.default < 0 || parameter.default > 10000)) {
      fail(`parameter ${name} bps default must be within 0..10000`);
    }
    if (parameter.type === 'level' && (!Number.isSafeInteger(parameter.default)
      || parameter.default <= 5000 || parameter.default >= 9999)) {
      fail(`parameter ${name} level default must be an integer strictly between 5000 and 9999`);
    }
    if (parameter.type === 'count' && (!Number.isSafeInteger(parameter.default) || parameter.default < 0)) {
      fail(`parameter ${name} count default must be a non-negative integer`);
    }
  }
}

/** Semantic validation of one fully resolved pack against the provider registry. */
export function validateResolvedPack(pack: GatePack, providers: MetricProviderRegistry): void {
  const ids = pack.spec.gates.map(gate => gate.id);
  if (new Set(ids).size !== ids.length) fail(`pack ${pack.metadata.id} has duplicate gate ids`);
  const params = pack.spec.parameters ?? {};
  for (const [name, parameter] of Object.entries(params)) checkParameter(name, parameter);
  for (const [name, metric] of Object.entries(pack.spec.metrics)) {
    if (!providers.has(metric.provider)) fail(`pack ${pack.metadata.id} metric ${name} names unknown provider ${metric.provider}`);
    const provider = providers.get(metric.provider);
    const declared = provider.metrics[name];
    if (declared === undefined) fail(`pack ${pack.metadata.id} metric ${name} is not computed by ${metric.provider}`);
    if (declared.kind !== metric.kind) {
      fail(`pack ${pack.metadata.id} metric ${name} kind ${metric.kind} does not match provider kind ${declared.kind}`);
    }
  }
  for (const gate of pack.spec.gates) {
    if (gate.onFail !== 'HOLD' && gate.onFail !== 'ROLLBACK') {
      fail(`gate ${gate.id} onFail must be HOLD or ROLLBACK, never PROMOTE`);
    }
    // Insufficient evidence always holds: ROLLBACK needs an observed blocking
    // failure, never a shortfall. Rejected here at load, not just in schema.
    if (gate.onInsufficient !== undefined && gate.onInsufficient !== 'HOLD') {
      fail(`gate ${gate.id} onInsufficient must be HOLD: insufficient evidence never rolls back`);
    }
    if (gate.metric !== undefined) {
      const declared = pack.spec.metrics[gate.metric.name];
      if (declared === undefined || declared.provider !== gate.metric.provider) {
        fail(`gate ${gate.id} references undeclared metric ${gate.metric.provider}:${gate.metric.name}`);
      }
    }
    const metricKind = gate.metric === undefined ? undefined : pack.spec.metrics[gate.metric.name]?.kind;
    const expectedKind = gate.kind === 'interval-bound' || gate.kind === 'count-max' || gate.kind === 'count-min' ? 'proportion'
      : gate.kind === 'paired-difference' ? 'paired' : gate.kind === 'bootstrap-bound' ? 'differences'
      : gate.kind === 'value-threshold' ? 'scalar' : gate.kind === 'evidence' ? 'evidence' : undefined;
    if (expectedKind !== undefined && metricKind !== expectedKind) {
      fail(`gate ${gate.id} of kind ${gate.kind} requires a ${expectedKind} metric`);
    }
    checkThresholdBlock(gate, params);
    checkStatisticBlock(gate, params);
    checkParamRef(gate.id, gate.minimumN, params, 'count', 'minimumN');
    if (gate.kind === 'minimum-n') {
      if (gate.minimumN === undefined) fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      // A default is the enforced minimum, so a defaulted reference must pin
      // at least 1; a defaultless reference is supplied by the binding and an
      // unresolvable value holds at evaluation, never promotes.
      const resolved = resolveNumberDefault(gate.minimumN, params, 'count');
      if (typeof gate.minimumN === 'number' && gate.minimumN < 1) {
        fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      }
      if (isParamRef(gate.minimumN) && params[gate.minimumN.param]?.default !== undefined && (resolved ?? 0) < 1) {
        fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      }
      if (metricKind === 'evidence') fail(`gate ${gate.id} minimum-n cannot observe an evidence metric`);
    } else if (gate.minimumN !== undefined && typeof gate.minimumN === 'number'
      && (!Number.isSafeInteger(gate.minimumN) || gate.minimumN < 0)) {
      fail(`gate ${gate.id} minimumN must be a non-negative integer`);
    }
    if (gate.kind === 'evidence' && (gate.evidence === undefined || !gate.evidence.required.length)) {
      fail(`gate ${gate.id} evidence requires a nonempty required list`);
    }
    if (gate.kind !== 'evidence' && gate.evidence !== undefined) fail(`gate ${gate.id} of kind ${gate.kind} must not carry evidence`);
    if (gate.kind !== 'predicate' && gate.predicate !== undefined) fail(`gate ${gate.id} of kind ${gate.kind} must not carry a predicate`);
    if ((gate.scope.mode === 'listed' || gate.scope.mode === 'pooled')
      && (gate.scope.slices === undefined || !gate.scope.slices.length)) {
      fail(`gate ${gate.id} scope ${gate.scope.mode} requires a nonempty slices list`);
    }
    // `except` is honoured only by `each` (per-slice minus exclusions). Any other
    // mode silently ignoring it would be a fail-open scoping bug, so it is a load error.
    if (gate.scope.except !== undefined && gate.scope.mode !== 'each') {
      fail(`gate ${gate.id} scope except is only allowed with mode each`);
    }
  }
}

/** Resolve a `$param` threshold against pack parameter defaults. Null when no default pins it. */
export function resolveThresholdDefault(gate: GateDefinition, params: Record<string, GateParameter>): number | null {
  if (gate.threshold === undefined) return null;
  if (gate.threshold.value !== undefined) return gate.threshold.value;
  if (gate.threshold.param === undefined) return null;
  return params[gate.threshold.param]?.default ?? null;
}

/**
 * Scope-tightening rules per gate kind. A scope change is a tightening only when
 * the child observes every slice the parent observes under every possible
 * binding inventory (so a breach the parent sees can never go unobserved)
 * and every world that fails the child also fails the parent:
 * - `listed` may only widen (more slices fail in a superset of worlds);
 * - `pooled` sets are fixed;
 * - `listed -> each` widens coverage to the whole binding inventory, so the
 *   child's `except` must exclude none of the parent's listed slices;
 * - `all -> each` covers the whole inventory only with no exceptions, and is a
 *   tightening only when per-slice checks are strictly harder than the pooled
 *   check (`count-min`, `minimum-n`); for `count-max` the pooled bound is
 *   strictly harder (pooled<=2 implies per-slice<=2, not vice versa), and for
 *   interval/paired/bootstrap/value gates pooled and per-slice bounds are
 *   incomparable — so the change is rejected for every other kind.
 * Every other cross-mode change crosses aggregation or drops coverage and is
 * rejected for every kind.
 */
function assertScopeTightens(parent: GateDefinition, child: GateDefinition): void {
  const from = parent.scope;
  const to = child.scope;
  if (from.mode === to.mode) {
    if (to.mode === 'listed' || to.mode === 'pooled') {
      const before = new Set(from.slices ?? []);
      const after = new Set(to.slices ?? []);
      if (to.mode === 'listed') {
        // A wider listed set fails in a superset of worlds, so it tightens.
        for (const slice of before) {
          if (!after.has(slice)) fail(`gate ${child.id} scope listed may not drop inherited slices`);
        }
      } else if (after.size !== before.size || [...after].some(slice => !before.has(slice))) {
        fail(`gate ${child.id} scope pooled may not change its slice set`);
      }
    }
    const beforeExcept = new Set(from.except ?? []);
    for (const slice of to.except ?? []) {
      if (!beforeExcept.has(slice)) fail(`gate ${child.id} scope may only narrow inherited exceptions`);
    }
    return;
  }
  if (from.mode === 'listed' && to.mode === 'each') {
    const excluded = new Set(to.except ?? []);
    for (const slice of from.slices ?? []) {
      if (excluded.has(slice)) fail(`gate ${child.id} scope listed -> each may not except inherited slice '${slice}'`);
    }
    return;
  }
  if (from.mode === 'all' && to.mode === 'each'
    && (child.kind === 'count-min' || child.kind === 'minimum-n')) {
    // `all` watches the whole inventory: any exception drops a watched slice.
    if ((to.except ?? []).length) fail(`gate ${child.id} scope all -> each may not except slices`);
    return;
  }
  fail(`gate ${child.id} scope change ${from.mode} -> ${to.mode} is not a monotone tightening`);
}

/**
 * Proves monotone tightening of a child gate over its parent. Any loosening —
 * a relaxed threshold, a literal rewritten as a bindable parameter, a renamed
 * parameter, a lowered minimumN, a demoted outcome, a widened scope
 * or a changed statistic — is a load error.
 */
export function assertGateTightens(parent: GateDefinition, child: GateDefinition,
  params: Record<string, GateParameter>): void {
  if (parent.kind !== child.kind) fail(`gate ${child.id} may not change kind ${parent.kind} -> ${child.kind}`);
  if (canonicalJson(parent.metric ?? null) !== canonicalJson(child.metric ?? null)) {
    fail(`gate ${child.id} may not change its metric reference`);
  }
  if (parent.direction !== child.direction) fail(`gate ${child.id} may not change its tightening direction`);
  const parentStatistic = parent.statistic;
  const childStatistic = child.statistic;
  if (canonicalJson({ ...parentStatistic, levelBps: 0 }) !== canonicalJson({ ...childStatistic, levelBps: 0 })) {
    fail(`gate ${child.id} may not change its statistic (levelBps aside)`);
  }
  // A literal level is a pinned bound: rewriting it as a parameter hands the
  // bound to the binding, whose allowed range is wider than the literal.
  const parentLevel = parentStatistic?.levelBps;
  const childLevel = childStatistic?.levelBps;
  if (typeof parentLevel === 'number' && isParamRef(childLevel)) {
    fail(`gate ${child.id} may not convert a literal levelBps into a parameter`);
  }
  if (isParamRef(parentLevel) && isParamRef(childLevel) && parentLevel.param !== childLevel.param) {
    fail(`gate ${child.id} may not rename its levelBps parameter`);
  }
  const levelBefore = parentLevel === undefined ? undefined : resolveNumberDefault(parentLevel, params, 'level');
  const levelAfter = childLevel === undefined ? undefined : resolveNumberDefault(childLevel, params, 'level');
  if (levelBefore === null || levelAfter === null) {
    if (canonicalJson(parentLevel ?? null) !== canonicalJson(childLevel ?? null)) {
      fail(`gate ${child.id} levelBps change is unresolvable without parameter defaults`);
    }
  } else if ((levelAfter ?? levelBefore) !== undefined && (levelAfter ?? 0) < (levelBefore ?? 0)) {
    fail(`gate ${child.id} may only raise levelBps`);
  }
  if ((parentStatistic?.mode ?? 'non-inferiority') !== (childStatistic?.mode ?? 'non-inferiority')) {
    fail(`gate ${child.id} may not change its paired mode`);
  }
  const marginBefore = parentStatistic?.marginBps;
  const marginAfter = childStatistic?.marginBps;
  if (marginBefore !== undefined && marginAfter !== undefined && marginAfter < marginBefore) {
    fail(`gate ${child.id} may only raise marginBps`);
  }
  // A literal threshold is a pinned bound. Rewriting it as a parameter hands the
  // bound to the binding, whose allowed range (e.g. 0..10000 bps) is wider than
  // the literal — a loosening no default-equality check can see. Forbid it.
  if (parent.threshold?.value !== undefined && child.threshold?.param !== undefined) {
    fail(`gate ${child.id} may not convert a literal threshold into a parameter`);
  }
  // Renaming a parameter rebinds the gate to a fresh default and range. Params
  // may only keep their name with a tighter-or-equal default.
  if (parent.threshold?.param !== undefined && child.threshold?.param !== undefined
    && parent.threshold.param !== child.threshold.param) {
    fail(`gate ${child.id} may not rename its threshold parameter`);
  }
  const before = resolveThresholdDefault(parent, params);
  const after = resolveThresholdDefault(child, params);
  if (before === null || after === null) {
    if (canonicalJson(parent.threshold ?? null) !== canonicalJson(child.threshold ?? null)) {
      fail(`gate ${child.id} threshold change is unresolvable without parameter defaults`);
    }
  } else if (child.direction === 'lower-is-stricter' ? after > before : after < before) {
    fail(`gate ${child.id} threshold ${before} -> ${after} loosens direction ${child.direction}`);
  }
  if (typeof parent.minimumN === 'number' && isParamRef(child.minimumN)) {
    fail(`gate ${child.id} may not convert a literal minimumN into a parameter`);
  }
  if (isParamRef(parent.minimumN) && isParamRef(child.minimumN) && parent.minimumN.param !== child.minimumN.param) {
    fail(`gate ${child.id} may not rename its minimumN parameter`);
  }
  const minimumBefore = parent.minimumN === undefined ? 0 : resolveNumberDefault(parent.minimumN, params, 'count');
  const minimumAfter = child.minimumN === undefined ? 0 : resolveNumberDefault(child.minimumN, params, 'count');
  if (minimumBefore === null || minimumAfter === null) {
    if (canonicalJson(parent.minimumN ?? null) !== canonicalJson(child.minimumN ?? null)) {
      fail(`gate ${child.id} minimumN change is unresolvable without parameter defaults`);
    }
  } else if (minimumAfter < minimumBefore) {
    fail(`gate ${child.id} may only raise minimumN`);
  }
  if (parent.onFail === 'ROLLBACK' && child.onFail !== 'ROLLBACK') {
    fail(`gate ${child.id} may not demote onFail ROLLBACK -> HOLD`);
  }
  // Insufficient evidence always holds: ROLLBACK needs an observed blocking
  // failure, so neither side may name it. Checked here as well as in schema
  // and pack validation because this pure function is the tightening gate.
  if ((parent.onInsufficient ?? 'HOLD') !== 'HOLD' || (child.onInsufficient ?? 'HOLD') !== 'HOLD') {
    fail(`gate ${child.id} onInsufficient must be HOLD: insufficient evidence never rolls back`);
  }
  if (parent.floor === true && child.floor !== true) fail(`gate ${child.id} is a floor gate and cannot be un-floored`);
  assertScopeTightens(parent, child);
  const afterEvidence = new Set(child.evidence?.required ?? []);
  for (const id of parent.evidence?.required ?? []) {
    if (!afterEvidence.has(id)) fail(`gate ${child.id} may not drop required evidence ${id}`);
  }
  if (canonicalJson(parent.predicate ?? null) !== canonicalJson(child.predicate ?? null)) {
    fail(`gate ${child.id} may not change its predicate`);
  }
}

export interface ResolvedPack {
  authored: GatePack;
  digest: Sha256Digest;
  /** Digest of the composed (extends-resolved) pack. Pinned in bindings and reports. */
  resolvedDigest: Sha256Digest;
  resolved: GatePack;
}

export interface ResolvedBinding {
  binding: GateBinding;
  packs: ResolvedPack[];
  /** Parameter values keyed by qualified name `<packId>.<param>`. */
  parameters: Record<string, number>;
}

const pinLabel = (pin: ArtifactPinLike): string => `${pin.id}@${pin.version}`;

/**
 * Pure `extends` composition: merges a child's declarations over its already
 * resolved parent. No registry state is read, so a `GateRegistry` subclass
 * cannot change tightening semantics by overriding an instance method. The
 * evaluator calls this (via `composeGatePack`/`resolveGateBinding`) instead of
 * any overridable `GateRegistry` method for security-relevant resolution.
 */
export function applyGateExtends(parentResolved: GatePack, child: GatePack): GatePack {
  const mergedParams: Record<string, GateParameter> = { ...(parentResolved.spec.parameters ?? {}) };
  for (const [name, parameter] of Object.entries(child.spec.parameters ?? {})) {
    const before = mergedParams[name];
    if (before === undefined) {
      mergedParams[name] = parameter;
      continue;
    }
    if (before.type !== parameter.type || before.direction !== parameter.direction) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not change parameter ${name} type or direction`);
    }
    if (before.default === undefined && parameter.default !== undefined) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not add a default to required parameter ${name}`);
    }
    if (before.default !== undefined && parameter.default === undefined) {
      mergedParams[name] = parameter;
      continue;
    }
    if (before.default !== undefined && parameter.default !== undefined) {
      const tightens = parameter.direction === 'lower-is-stricter'
        ? parameter.default <= before.default : parameter.default >= before.default;
      if (!tightens) throw new GateRegistryError(`pack ${child.metadata.id} parameter ${name} default loosens`);
      mergedParams[name] = parameter;
    }
  }
  const parentGates = new Map(parentResolved.spec.gates.map(gate => [gate.id, gate]));
  const merged: GateDefinition[] = [];
  const seen = new Set<string>();
  for (const gate of parentResolved.spec.gates) {
    const override = (child.spec.gates ?? []).find(candidate => candidate.id === gate.id);
    if (override === undefined) {
      // Removing a non-floor gate is allowed; floor gates pin the minimum.
      if (gate.floor === true) throw new GateRegistryError(`pack ${child.metadata.id} may not remove floor gate ${gate.id}`);
      continue;
    }
    seen.add(gate.id);
    assertGateTightens(gate, override, mergedParams);
    merged.push(override);
  }
  for (const gate of child.spec.gates ?? []) {
    if (!seen.has(gate.id) && !parentGates.has(gate.id)) merged.push(gate);
    else if (!seen.has(gate.id)) fail(`pack ${child.metadata.id} duplicates gate ${gate.id}`);
  }
  const mergedMetrics = { ...parentResolved.spec.metrics };
  for (const [name, metric] of Object.entries(child.spec.metrics ?? {})) {
    const before = mergedMetrics[name];
    if (before !== undefined && (before.provider !== metric.provider || before.kind !== metric.kind)) {
      throw new GateRegistryError(`pack ${child.metadata.id} may not change inherited metric ${name}`);
    }
    mergedMetrics[name] = metric;
  }
  return {
    apiVersion: child.apiVersion, kind: child.kind, metadata: child.metadata,
    spec: {
      extends: child.spec.extends, parameters: mergedParams, metrics: mergedMetrics, gates: merged,
      // Omit `combine` when the child leaves it unset: a present-but-undefined
      // key is not JSON and would poison the composed-pack digest.
      ...(child.spec.combine === undefined ? {} : { combine: child.spec.combine }),
    },
  };
}

/**
 * Pure extends-chain composition. The lookup returns authored packs by full id;
 * parent pins (version + authored digest) are enforced here, so a loosened
 * parent always moves the composed digest.
 */
export function composeGatePack(
  pack: GatePack,
  lookupAuthored: (id: string) => GatePack,
): GatePack {
  if (pack.spec.extends === undefined) return pack;
  const parentAuthored = lookupAuthored(pack.spec.extends.id);
  const parentPin = pack.spec.extends;
  if (parentAuthored.metadata.version !== parentPin.version
    || (artifactDigest(parentAuthored) as Sha256Digest) !== parentPin.digest) {
    throw new GateRegistryError(`pack ${pack.metadata.id} parent pin mismatch for ${pinLabel(parentPin)}`);
  }
  return applyGateExtends(composeGatePack(parentAuthored, lookupAuthored), pack);
}

export type AuthoredGatePackEntry = { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace };
export type AuthoredGatePackMap = Map<string, AuthoredGatePackEntry>;

/** One floor pack expanded to its composed gates and parameter defaults. */
export interface ExpandedFloorPack {
  packId: string;
  gates: GateDefinition[];
  params: Record<string, GateParameter>;
}

/**
 * Whether one expanded floor's `integrity-ceiling` gate genuinely governs the
 * default ceiling: it must be an all-scoped `upstream-ceiling` gate that
 * tightens the shipped default gate (floor flag included). A same-id gate of
 * any other kind or scope never suppresses the default.
 */
function governsDefaultCeiling(floor: ExpandedFloorPack, defaultGate: GateDefinition): boolean {
  return floor.gates.some(gate => {
    if (gate.id !== 'integrity-ceiling' || gate.kind !== 'upstream-ceiling' || gate.scope.mode !== 'all') {
      return false;
    }
    try {
      assertGateTightens(defaultGate, gate, floor.params);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Expands project floors over an explicit authored-pack map: inline packs are
 * schema-checked again (direct registry callers bypass config validation) and
 * semantically validated, pack references are verified by version and authored
 * digest and composed through the pure `composeGatePack` (so `extends` floors
 * enforce their composed minima). Every floor gate that binds a threshold
 * parameter must declare a default for it: the default is the enforced
 * minimum, and a required (default-less) floor parameter is a load error.
 *
 * The operator default floor — the composed gates of the shipped
 * `aiwg:decision-engine/integrity-ceiling` pack, the single source of truth —
 * is appended unless a configured floor governs it via `governsDefaultCeiling`
 * above. An inline gate that merely reuses the id (any other kind or scope)
 * never suppresses the default; the binding must then satisfy both, which
 * fails closed with a diagnostic.
 */
export function expandFloorPacks(
  floors: ProjectFloors,
  lookupAuthored: (id: string) => GatePack,
  providers: MetricProviderRegistry,
): ExpandedFloorPack[] {
  const expanded: ExpandedFloorPack[] = (floors.floors ?? []).map(source => {
    if ('packRef' in source) {
      const pin = source.packRef;
      const authored = lookupAuthored(pin.id);
      if (authored.metadata.version !== pin.version
        || (artifactDigest(authored) as Sha256Digest) !== pin.digest) {
        throw new GateRegistryError(`project floor pack pin mismatch for ${pinLabel(pin)}`);
      }
      const composed = composeGatePack(authored, lookupAuthored);
      validateResolvedPack(composed, providers);
      return {
        packId: authored.metadata.id,
        gates: composed.spec.gates,
        params: { ...(composed.spec.parameters ?? {}) },
      };
    }
    const pack = validateGateDocument<GatePack>(source.pack);
    if (pack.kind !== 'GatePack') throw new GateRegistryError('project floor pack requires a GatePack document');
    const composed = pack.spec.extends === undefined ? pack : composeGatePack(pack, lookupAuthored);
    validateResolvedPack(composed, providers);
    for (const gate of composed.spec.gates) {
      const level = gate.statistic?.levelBps;
      const refs = [gate.threshold?.param, isParamRef(gate.minimumN) ? gate.minimumN.param : undefined,
        isParamRef(level) ? level.param : undefined];
      for (const name of refs) {
        if (name !== undefined && composed.spec.parameters?.[name]?.default === undefined) {
          throw new GateRegistryError(
            `project floor gate '${gate.id}' parameter '${name}' requires a default: it is the enforced minimum`);
        }
      }
    }
    return {
      packId: pack.metadata.id,
      gates: composed.spec.gates,
      params: { ...(composed.spec.parameters ?? {}) },
    };
  });
  const defaultAuthored = lookupAuthored(INTEGRITY_CEILING_FLOOR_PACK_ID);
  const defaultComposed = composeGatePack(defaultAuthored, lookupAuthored);
  validateResolvedPack(defaultComposed, providers);
  const defaultGate = defaultComposed.spec.gates.find(gate => gate.id === 'integrity-ceiling');
  if (defaultGate === undefined) {
    throw new GateRegistryError(`shipped default floor ${INTEGRITY_CEILING_FLOOR_PACK_ID} has no integrity-ceiling gate`);
  }
  if (!expanded.some(floor => governsDefaultCeiling(floor, defaultGate))) {
    expanded.push({
      packId: defaultAuthored.metadata.id,
      gates: defaultComposed.spec.gates,
      params: { ...(defaultComposed.spec.parameters ?? {}) },
    });
  }
  return expanded;
}

/**
 * Resolves a binding gate's threshold parameter to its preregistered binding
 * value, so floor comparison is always value-against-minimum in the gate's
 * declared direction. A binding may parameterize a floor literal: the value,
 * not the spelling, must tighten.
 */
function synthesizeFloorCandidate(
  gate: GateDefinition,
  packId: string,
  parameters: Record<string, number>,
): GateDefinition {
  const materialize = (ref: { param: string }): number => {
    const value = parameters[qualifyGateParameter(packId, ref.param)];
    if (value === undefined) {
      throw new GateRegistryError(`binding gate '${gate.id}' parameter '${ref.param}' has no resolved value`);
    }
    return value;
  };
  let candidate = gate;
  if (gate.threshold !== undefined && gate.threshold.param !== undefined) {
    const { op, param } = gate.threshold;
    candidate = { ...candidate, threshold: { op, value: materialize({ param }) } };
  }
  if (isParamRef(gate.minimumN)) candidate = { ...candidate, minimumN: materialize(gate.minimumN) };
  const statistic = gate.statistic;
  if (statistic !== undefined && isParamRef(statistic.levelBps)) {
    candidate = { ...candidate, statistic: { ...statistic, levelBps: materialize(statistic.levelBps) } };
  }
  return candidate;
}

/**
 * Enforces project floors over already-resolved binding packs. Project policy
 * outranks addon and framework packs: a binding that omits a floor gate, or
 * whose gate loosens any floor gate's threshold, parameter value, scope or
 * outcome (via the shared per-kind `assertGateTightens` and the scope-superset
 * rule), is refused with a diagnostic naming the binding, the gate and the
 * floor pack. Every binding gate sharing a floor gate id must tighten it, so
 * a loosened duplicate cannot evade the floor.
 */
export function enforceProjectFloors(
  binding: GateBinding,
  packs: ResolvedPack[],
  parameters: Record<string, number>,
  expanded: ExpandedFloorPack[],
  ceilings: Record<string, GateOutcome>,
): void {
  // The '*' key is the project-wide default ceiling for every binding; a
  // per-study key overrides it for that study only (exact match — renames
  // never inherit). The star rule is re-checked here (C6): floors handed in
  // directly, bypassing `validateGatesConfig`/`resolveProjectFloors`, still
  // cannot carry starless or loosening per-study ceilings.
  try {
    assertCeilingDefaults(ceilings);
  } catch (error) {
    throw new GateRegistryError(error instanceof Error ? error.message : 'invalid project ceilings');
  }
  const configured = ceilings[binding.metadata.id] ?? ceilings['*'];
  if (!projectCeilingSatisfied(binding.spec.ceiling, configured)) {
    throw new GateRegistryError(
      `binding '${binding.metadata.id}' declares ceiling ${binding.spec.ceiling ?? 'PROMOTE'}`
      + ` below the project ceiling ${configured} for this study`);
  }
  const union: Array<{ gate: GateDefinition; packId: string }> = [];
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) union.push({ gate, packId: pack.authored.metadata.id });
  }
  for (const floor of expanded) {
    for (const floorGate of floor.gates) {
      const matches = union.filter(candidate => candidate.gate.id === floorGate.id);
      if (!matches.length) {
        throw new GateRegistryError(
          `binding '${binding.metadata.id}' omits project floor gate '${floorGate.id}'`
          + ` (floor pack '${floor.packId}'): every binding in this project must include and tighten it`);
      }
      for (const match of matches) {
        try {
          assertGateTightens(floorGate, synthesizeFloorCandidate(match.gate, match.packId, parameters), floor.params);
        } catch (error) {
          throw new GateRegistryError(
            `binding '${binding.metadata.id}' loosens project floor gate '${floorGate.id}'`
            + ` (floor pack '${floor.packId}'): ${error instanceof Error ? error.message : 'invalid tightening'}`);
        }
      }
    }
  }
}

/**
 * Standalone snapshot readers. These are module functions, not `GateRegistry`
 * methods, so a subclass override of `resolveBinding`/`resolvePack`/`getPack`
 * cannot intercept them. The evaluator reads registry state only through these
 * and recomposes through the pure functions above.
 */
export function authoredGatePacksOf(registry: GateRegistry): AuthoredGatePackMap {
  const packs = (registry as unknown as { packs?: unknown }).packs;
  if (!(packs instanceof Map)) throw new GateRegistryError('gate registry packs are unavailable');
  return packs as AuthoredGatePackMap;
}

export function gateProvidersOf(registry: GateRegistry): MetricProviderRegistry {
  const providers = (registry as unknown as { providers?: unknown }).providers;
  if (providers === undefined || providers === null) throw new GateRegistryError('gate registry providers are unavailable');
  return providers as MetricProviderRegistry;
}

/**
 * Pure binding resolution over an explicit authored-pack map and provider registry.
 * Project floors (`floors`, loaded from `aiwg.config` by the caller via
 * `resolveProjectFloors`) are an optional trusted input: when present, the
 * binding must include and tighten every floor gate and respect its per-study
 * ceiling. When absent the check is skipped entirely and resolution is
 * byte-identical to the floors-unaware path.
 */
export function resolveGateBinding(
  doc: unknown,
  authoredById: AuthoredGatePackMap,
  providers: MetricProviderRegistry,
  floors?: ProjectFloors,
): ResolvedBinding {
  const binding = validateGateDocument<GateBinding>(doc);
  if (binding.kind !== 'GateBinding') throw new GateRegistryError('resolveBinding requires a GateBinding document');
  const seenPins = new Set<string>();
  for (const pin of binding.spec.packs) {
    if (seenPins.has(pin.id)) throw new GateRegistryError(`binding ${binding.metadata.id} pins pack ${pin.id} twice`);
    seenPins.add(pin.id);
  }
  const lookupAuthored = (id: string): GatePack => {
    if (id.includes(':')) {
      const entry = authoredById.get(id);
      if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
      return entry.authored;
    }
    const matches = [...authoredById.keys()].filter(key => splitPackId(key).rest === id);
    if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${id}`);
    if (matches.length > 1) {
      throw new GateRegistryError(`ambiguous gate pack '${id}': ${matches.sort().join(', ')} (pin the full id)`);
    }
    return authoredById.get(matches[0] as string)!.authored;
  };
  const packs = binding.spec.packs.map(pin => {
    const entry = pin.id.includes(':') ? authoredById.get(pin.id) : (() => {
      const matches = [...authoredById.keys()].filter(key => splitPackId(key).rest === pin.id);
      if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${pin.id}`);
      if (matches.length > 1) {
        throw new GateRegistryError(`ambiguous gate pack '${pin.id}': ${matches.sort().join(', ')} (pin the full id)`);
      }
      return authoredById.get(matches[0] as string)!;
    })();
    if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${pin.id}`);
    if (entry.authored.metadata.id !== pin.id) {
      throw new GateRegistryError(`binding ${binding.metadata.id} must pin the full pack id (got '${pin.id}')`);
    }
    if ((artifactDigest(entry.authored) as Sha256Digest) !== entry.digest
      || entry.authored.metadata.version !== pin.version || entry.digest !== pin.digest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} pack pin mismatch for ${pinLabel(pin)}`);
    }
    const resolved = composeGatePack(entry.authored, lookupAuthored);
    if ((artifactDigest(resolved) as Sha256Digest) !== pin.resolvedDigest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} composed-pack pin mismatch for ${pinLabel(pin)}`);
    }
    return {
      authored: entry.authored, digest: entry.digest,
      resolvedDigest: pin.resolvedDigest, resolved,
    };
  });
  for (const pin of binding.spec.metricProviders) {
    if (!providers.has(pin.id)) throw new GateRegistryError(`binding ${binding.metadata.id} pins unknown provider ${pin.id}`);
    const provider = providers.get(pin.id);
    if (provider.version !== pin.version || provider.sourceDigest !== pin.sourceDigest) {
      throw new GateRegistryError(`binding ${binding.metadata.id} provider pin mismatch for ${pin.id}`);
    }
    // Bundle providers (#2831 rework): the pin must carry the loader-computed
    // code digest, verified here against the loaded provider, plus the
    // records digest the evaluator reproduces (records binding, P4). A byte
    // change moves the code digest, so an old pin refuses until re-pinned.
    // Null never verifies. Core pins carry neither digest.
    const expectedCode = (provider as { codeDigest?: unknown }).codeDigest;
    const pinnedCode = (pin as { codeDigest?: unknown }).codeDigest;
    const pinnedRecords = (pin as { recordsDigest?: unknown }).recordsDigest;
    if (typeof expectedCode === 'string') {
      if (typeof pinnedCode !== 'string' || pinnedCode !== expectedCode) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider code pin mismatch for ${pin.id}`);
      }
      if (typeof pinnedRecords !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pinnedRecords)) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider records pin mismatch for ${pin.id}`);
      }
    } else {
      if (pinnedCode !== undefined) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider code pin mismatch for ${pin.id}`);
      }
      if (pinnedRecords !== undefined) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider records pin mismatch for ${pin.id}`);
      }
    }
  }
  const requiredProviders = new Set<string>();
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      if (gate.metric !== undefined) requiredProviders.add(gate.metric.provider);
    }
  }
  const pinnedProviders = new Set(binding.spec.metricProviders.map(pin => pin.id));
  for (const id of requiredProviders) {
    if (!pinnedProviders.has(id)) {
      throw new GateRegistryError(`binding ${binding.metadata.id} leaves provider ${id} used by a gate unpinned`);
    }
  }
  const declared = new Map<string, GateParameter>();
  for (const pack of packs) {
    for (const [name, parameter] of Object.entries(pack.resolved.spec.parameters ?? {})) {
      declared.set(qualifyGateParameter(pack.authored.metadata.id, name), parameter);
    }
  }
  const parameters: Record<string, number> = {};
  for (const [qualified, parameter] of declared) {
    const value = binding.spec.parameters[qualified] ?? parameter.default;
    if (value === undefined) throw new GateRegistryError(`binding ${binding.metadata.id} is missing required parameter ${qualified}`);
    checkBindingValue(qualified, parameter, value);
    parameters[qualified] = value;
  }
  for (const name of Object.keys(binding.spec.parameters)) {
    if (!declared.has(name)) throw new GateRegistryError(`binding ${binding.metadata.id} sets undeclared parameter ${name}`);
  }
  const slices = new Set(binding.spec.slices);
  for (const [group, members] of Object.entries(binding.spec.sliceGroups ?? {})) {
    for (const slice of members) {
      if (!slices.has(slice)) {
        throw new GateRegistryError(`binding ${binding.metadata.id} sliceGroup '${group}' names slice '${slice}' outside the binding inventory`);
      }
    }
  }
  const references = new Set(binding.spec.references.map(reference => reference.name));
  for (const pack of packs) {
    for (const gate of pack.resolved.spec.gates) {
      for (const slice of [...(gate.scope.slices ?? []), ...(gate.scope.except ?? [])]) {
        if (!slices.has(slice)) throw new GateRegistryError(`gate ${gate.id} names slice '${slice}' outside the binding inventory`);
      }
      if (gate.statistic?.vs !== undefined && !references.has(gate.statistic.vs)) {
        throw new GateRegistryError(`gate ${gate.id} contrasts undeclared reference '${gate.statistic.vs}'`);
      }
      if (gate.scope.mode === 'each') {
        const excluded = new Set(gate.scope.except ?? []);
        if (binding.spec.slices.every(slice => excluded.has(slice))) {
          throw new GateRegistryError(`gate ${gate.id} each-scope excludes every binding slice`);
        }
      }
    }
  }
  const registeredAt = Date.parse(binding.spec.registeredAt);
  const frozenAt = Date.parse(binding.spec.frozenAt);
  if (!Number.isFinite(registeredAt) || !Number.isFinite(frozenAt)) {
    throw new GateRegistryError(`binding ${binding.metadata.id} has unparseable preregistration timestamps`);
  }
  if (registeredAt > frozenAt) {
    throw new GateRegistryError(`binding ${binding.metadata.id} registers after it freezes`);
  }
  // Project floors run after every legacy check, so floors-unaware diagnostics
  // keep their exact messages and order. Floor expansion reuses the same pure
  // lookup the binding pins above, never registry instance state.
  if (floors !== undefined) {
    enforceProjectFloors(binding, packs, parameters,
      expandFloorPacks(floors, lookupAuthored, providers), floors.ceilings ?? {});
  }
  return { binding, packs, parameters };
}

export class GateRegistry {
  private readonly packs = new Map<string, { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace }>();

  constructor(private readonly providers: MetricProviderRegistry) {}

  registerPack(doc: unknown, origin: { namespace: GateNamespace; bundle?: string }): GatePack {
    const pack = validateGateDocument<GatePack>(doc);
    if (pack.kind !== 'GatePack') throw new GateRegistryError('registerPack requires a GatePack document');
    const { namespace, rest } = splitPackId(pack.metadata.id);
    if (namespace !== origin.namespace) {
      throw new GateRegistryError(`pack ${pack.metadata.id} namespace does not match contribution origin ${origin.namespace}`);
    }
    if (namespace !== 'project') {
      if (origin.bundle === undefined || !origin.bundle.trim()) throw new GateRegistryError('bundle origin is required outside project:');
      if (rest !== `${origin.bundle}/${rest.slice(origin.bundle.length + 1)}` || !rest.startsWith(`${origin.bundle}/`)) {
        throw new GateRegistryError(`pack ${pack.metadata.id} does not belong to bundle ${origin.bundle}`);
      }
    }
    if (this.packs.has(pack.metadata.id)) throw new GateRegistryError(`duplicate gate pack: ${pack.metadata.id}`);
    // Shipped-name protection, order-independent: an aiwg: rest-path can never
    // coexist with the same rest-path from any other namespace, whichever
    // registers first.
    for (const id of this.packs.keys()) {
      if (splitPackId(id).rest !== rest) continue;
      const otherShipped = id.startsWith('aiwg:');
      const nextShipped = pack.metadata.id.startsWith('aiwg:');
      if (otherShipped || nextShipped) {
        const shipped = nextShipped ? pack.metadata.id : id;
        const shadow = nextShipped ? id : pack.metadata.id;
        throw new GateRegistryError(`pack ${shadow} shadows shipped pack ${shipped}`);
      }
    }
    if (pack.spec.extends !== undefined) {
      this.requireParent(pack.metadata.id, pack.spec.extends);
    }
    const resolved = this.composeAuthored(pack);
    validateResolvedPack(resolved, this.providers);
    const { digest } = { digest: artifactDigest(pack) as Sha256Digest };
    this.packs.set(pack.metadata.id, { authored: pack, digest, namespace });
    return pack;
  }

  getPack(id: string): GatePack {
    return this.lookupPack(id).authored;
  }

  resolvePack(id: string): ResolvedPack {
    const entry = this.lookupPack(id);
    const resolved = this.composeAuthored(entry.authored);
    return {
      authored: entry.authored, digest: entry.digest,
      resolvedDigest: artifactDigest(resolved) as Sha256Digest, resolved,
    };
  }

  /**
   * Full-id lookup, or rest-path lookup when the id carries no namespace.
   * A rest-path shared by two namespaces is `ambiguous`: callers must pin the
   * full id. Bindings always pin full ids, so they never hit ambiguity.
   */
  private lookupPack(id: string): { authored: GatePack; digest: Sha256Digest; namespace: GateNamespace } {
    if (id.includes(':')) {
      const entry = this.packs.get(id);
      if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
      return entry;
    }
    const matches = [...this.packs.keys()].filter(key => splitPackId(key).rest === id);
    if (!matches.length) throw new GateRegistryError(`unknown gate pack: ${id}`);
    if (matches.length > 1) {
      throw new GateRegistryError(`ambiguous gate pack '${id}': ${matches.sort().join(', ')} (pin the full id)`);
    }
    return this.packs.get(matches[0] as string)!;
  }

  private requireParent(childId: string, pin: GatePack['spec']['extends'] & object): {
    authored: GatePack; digest: Sha256Digest;
  } {
    const entry = this.packs.get(pin.id);
    if (entry === undefined) throw new GateRegistryError(`pack ${childId} extends unknown pack ${pin.id}`);
    if (entry.authored.metadata.version !== pin.version || entry.digest !== pin.digest) {
      throw new GateRegistryError(`pack ${childId} parent pin mismatch for ${pinLabel(pin)}`);
    }
    return entry;
  }

  private composeAuthored(pack: GatePack): GatePack {
    return composeGatePack(pack, id => {
      const parent = this.packs.get(id);
      if (parent === undefined) throw new GateRegistryError(`pack ${pack.metadata.id} extends unknown pack ${id}`);
      return parent.authored;
    });
  }

  resolveBinding(doc: unknown, floors?: ProjectFloors): ResolvedBinding {
    return resolveGateBinding(doc, this.packs, this.providers, floors);
  }
}

function checkBindingValue(name: string, parameter: GateParameter, value: number): void {
  if (!Number.isFinite(value)) throw new GateRegistryError(`binding parameter ${name} must be finite`);
  if (parameter.type === 'bps' && (value < 0 || value > 10000)) {
    throw new GateRegistryError(`binding parameter ${name} must be within 0..10000 bps`);
  }
  if (parameter.type === 'level' && (!Number.isSafeInteger(value) || value <= 5000 || value >= 9999)) {
    throw new GateRegistryError(`binding parameter ${name} must be an integer strictly between 5000 and 9999`);
  }
  if (parameter.type === 'count' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new GateRegistryError(`binding parameter ${name} must be a non-negative integer`);
  }
}
