/**
 * Gates capability phase 1 core (epic #2824): declarative gate packs, a pure deterministic
 * evaluator and digest-bound reports. Experimental and default-off: nothing in the
 * decision runtime imports this module, so existing behavior is unchanged.
 */
export { GATES_API_VERSION, qualifyGateParameter } from './types.js';
export type {
  ArtifactPinLike, GateBinding, GateDefinition, GateEvidence, GateFailOutcome, GateHoldoutInputs,
  GateHoldoutRecord, GateKind, GateMetadata, GateMetricsDocument, GateOutcome, GatePack, GatePackPin, GateParameter,
  GateParentPin, GateReference, GateReport, GateScope, GateScopeMode,
  GateStatistic, GateStatus, GateThreshold, MetricKind, MetricObservation, MetricSeries, ParameterType,
  ProviderMetrics, ReferenceKind, Sha256Digest, StatisticEvidenceMethod, StatisticKind, StatisticMethod,
  TighteningDirection, UpstreamCeiling, UpstreamRecord,
} from './types.js';
export { GateSchemaError, validateGateDocument, type GateDocumentKind } from './schema.js';
export {
  GateRegistryError, GATE_NAMESPACES, splitPackId, validateResolvedPack, resolveThresholdDefault,
  assertGateTightens, applyGateExtends, composeGatePack, resolveGateBinding,
  authoredGatePacksOf, gateProvidersOf, GateRegistry,
  type AuthoredGatePackEntry, type AuthoredGatePackMap,
  type GateNamespace, type ResolvedBinding, type ResolvedPack,
} from './registry.js';
export {
  GateEvaluationError, maxOutcome, gateStatusOutcome, sealUpstream, sealGateHoldout,
  evaluateGates, type EvaluateGatesInput,
} from './evaluate.js';
export { validateGateReport, type GateReportValidation } from './report.js';
export { createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider, scalarProvider } from './providers/index.js';
export type { MetricProvider } from './providers/index.js';
export { MetricProviderRegistry } from './providers/index.js';
