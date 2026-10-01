import { canonicalJson } from '../security/artifact-trust.js';
import { artifactDigest } from '../decision/validate.js';
import type { MetricProviderRegistry } from './providers/registry.js';
import { validateGateDocument } from './schema.js';
import type {
  ArtifactPinLike, GateBinding, GateDefinition, GatePack, GateParameter, Sha256Digest,
} from './types.js';

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

/** Statistic coherence per kind. Irrelevant statistic fields are rejected so confused authoring fails at load. */
function checkStatisticBlock(gate: GateDefinition): void {
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
    if (mode !== undefined || marginBps !== undefined || seed !== undefined || resamples !== undefined || bounds !== undefined) {
      fail(`gate ${gate.id} interval-bound must not carry mode, margin, seed, resamples or bounds`);
    }
  } else if (gate.kind === 'paired-difference') {
    if (method !== undefined && method !== 'newcombe' && method !== 'tango') {
      fail(`gate ${gate.id} paired-difference method must be newcombe or tango`);
    }
    if (bound !== undefined) fail(`gate ${gate.id} paired-difference must not carry bound`);
    if (levelBps === undefined) fail(`gate ${gate.id} paired-difference requires levelBps`);
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
    checkStatisticBlock(gate);
    if (gate.kind === 'minimum-n') {
      if (gate.minimumN === undefined || gate.minimumN < 1) fail(`gate ${gate.id} minimum-n requires minimumN >= 1`);
      if (metricKind === 'evidence') fail(`gate ${gate.id} minimum-n cannot observe an evidence metric`);
    } else if (gate.minimumN !== undefined && (!Number.isSafeInteger(gate.minimumN) || gate.minimumN < 0)) {
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
    if (gate.scope.except !== undefined && gate.scope.mode !== 'all' && gate.scope.mode !== 'each') {
      fail(`gate ${gate.id} scope except is only allowed with mode all|each`);
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
  // all -> each checks every slice instead of one pool; listed -> each widens
  // coverage to the whole binding inventory, which always includes the listed set.
  if ((from.mode === 'all' || from.mode === 'listed') && to.mode === 'each') return;
  fail(`gate ${child.id} scope change ${from.mode} -> ${to.mode} is not a monotone tightening`);
}

/**
 * Proves monotone tightening of a child gate over its parent. Any loosening —
 * a relaxed threshold, a lowered minimumN, a demoted severity, a widened scope
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
  if ((childStatistic?.levelBps ?? parentStatistic?.levelBps) !== undefined
    && (childStatistic?.levelBps ?? 0) < (parentStatistic?.levelBps ?? 0)) {
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
  const before = resolveThresholdDefault(parent, params);
  const after = resolveThresholdDefault(child, params);
  if (before === null || after === null) {
    if (canonicalJson(parent.threshold ?? null) !== canonicalJson(child.threshold ?? null)) {
      fail(`gate ${child.id} threshold change is unresolvable without parameter defaults`);
    }
  } else if (child.direction === 'lower-is-stricter' ? after > before : after < before) {
    fail(`gate ${child.id} threshold ${before} -> ${after} loosens direction ${child.direction}`);
  }
  if ((child.minimumN ?? 0) < (parent.minimumN ?? 0)) fail(`gate ${child.id} may only raise minimumN`);
  if (parent.severity === 'blocking' && child.severity !== 'blocking') {
    fail(`gate ${child.id} may not demote severity blocking -> standard`);
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
  resolved: GatePack;
}

export interface ResolvedBinding {
  binding: GateBinding;
  packs: ResolvedPack[];
  parameters: Record<string, number>;
}

const pinLabel = (pin: ArtifactPinLike): string => `${pin.id}@${pin.version}`;

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
    if (!pack.metadata.id.startsWith('aiwg:')) {
      const rest = splitPackId(pack.metadata.id).rest;
      for (const id of this.packs.keys()) {
        if (id.startsWith('aiwg:') && splitPackId(id).rest === rest) {
          throw new GateRegistryError(`pack ${pack.metadata.id} shadows shipped pack ${id}`);
        }
      }
    }
    let resolved = pack;
    if (pack.spec.extends !== undefined) {
      const parent = this.packs.get(pack.spec.extends);
      if (parent === undefined) throw new GateRegistryError(`pack ${pack.metadata.id} extends unknown pack ${pack.spec.extends}`);
      resolved = this.applyExtends(parent, pack);
    }
    validateResolvedPack(resolved, this.providers);
    const { digest } = { digest: artifactDigest(pack) as Sha256Digest };
    this.packs.set(pack.metadata.id, { authored: pack, digest, namespace });
    return pack;
  }

  getPack(id: string): GatePack {
    const entry = this.packs.get(id);
    if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
    return entry.authored;
  }

  resolvePack(id: string): ResolvedPack {
    const entry = this.packs.get(id);
    if (entry === undefined) throw new GateRegistryError(`unknown gate pack: ${id}`);
    return { authored: entry.authored, digest: entry.digest, resolved: this.resolveAuthored(entry.authored) };
  }

  private resolveAuthored(pack: GatePack): GatePack {
    if (pack.spec.extends === undefined) return pack;
    const parent = this.packs.get(pack.spec.extends);
    if (parent === undefined) throw new GateRegistryError(`pack ${pack.metadata.id} extends unknown pack ${pack.spec.extends}`);
    return this.applyExtends(parent, pack);
  }

  private applyExtends(parent: { authored: GatePack }, child: GatePack): GatePack {
    const parentResolved = this.resolveAuthored(parent.authored);
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
        combine: child.spec.combine,
      },
    };
  }

  resolveBinding(doc: unknown): ResolvedBinding {
    const binding = validateGateDocument<GateBinding>(doc);
    if (binding.kind !== 'GateBinding') throw new GateRegistryError('resolveBinding requires a GateBinding document');
    const packs = binding.spec.packs.map(pin => {
      const entry = this.packs.get(pin.id);
      if (entry === undefined) throw new GateRegistryError(`binding ${binding.metadata.id} pins unknown pack ${pinLabel(pin)}`);
      if (entry.authored.metadata.version !== pin.version || entry.digest !== pin.digest) {
        throw new GateRegistryError(`binding ${binding.metadata.id} pack pin mismatch for ${pinLabel(pin)}`);
      }
      return { authored: entry.authored, digest: entry.digest, resolved: this.resolveAuthored(entry.authored) };
    });
    for (const pin of binding.spec.metricProviders) {
      if (!this.providers.has(pin.id)) throw new GateRegistryError(`binding ${binding.metadata.id} pins unknown provider ${pin.id}`);
      const provider = this.providers.get(pin.id);
      if (provider.version !== pin.version || provider.sourceDigest !== pin.sourceDigest) {
        throw new GateRegistryError(`binding ${binding.metadata.id} provider pin mismatch for ${pin.id}`);
      }
    }
    const declared: Record<string, GateParameter> = {};
    for (const pack of packs) Object.assign(declared, pack.resolved.spec.parameters ?? {});
    const parameters: Record<string, number> = {};
    for (const [name, parameter] of Object.entries(declared)) {
      const value = binding.spec.parameters[name] ?? parameter.default;
      if (value === undefined) throw new GateRegistryError(`binding ${binding.metadata.id} is missing required parameter ${name}`);
      checkBindingValue(name, parameter, value);
      parameters[name] = value;
    }
    for (const name of Object.keys(binding.spec.parameters)) {
      if (declared[name] === undefined) throw new GateRegistryError(`binding ${binding.metadata.id} sets undeclared parameter ${name}`);
    }
    const slices = new Set(binding.spec.slices);
    const references = new Set(binding.spec.references.map(reference => reference.name));
    for (const pack of packs) {
      for (const gate of pack.resolved.spec.gates) {
        for (const slice of [...(gate.scope.slices ?? []), ...(gate.scope.except ?? [])]) {
          if (!slices.has(slice)) throw new GateRegistryError(`gate ${gate.id} names slice '${slice}' outside the binding inventory`);
        }
        if (gate.statistic?.vs !== undefined && !references.has(gate.statistic.vs)) {
          throw new GateRegistryError(`gate ${gate.id} contrasts undeclared reference '${gate.statistic.vs}'`);
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
    return { binding, packs, parameters };
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
