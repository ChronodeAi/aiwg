/**
 * Gates capability phase 1 core (epic #2824): declarative gate packs, a pure deterministic
 * evaluator and digest-bound reports. Experimental and default-off: nothing in the
 * decision runtime imports this module, so existing behavior is unchanged.
 */
export { GATES_API_VERSION, qualifyGateParameter } from './types.js';
export type {
  ArtifactPinLike, GateBinding, GateDefinition, GateEvidence, GateFailOutcome, GateHoldoutInputs,
  GateHoldoutRecord, GateKind, GateMetadata, GateMetricsDocument, GateOutcome, GatePack, GatePackPin, GateParameter,
  GateParentPin, GateProviderPin, GateReference, GateReport, GateScope, GateScopeMode,
  GateStatistic, GateStatus, GateThreshold, MetricKind, MetricObservation, MetricSeries, ParameterType,
  ProviderMetrics, ReferenceKind, Sha256Digest, StatisticEvidenceMethod, StatisticKind, StatisticMethod,
  TighteningDirection, UpstreamCeiling, UpstreamRecord,
} from './types.js';
export { GateSchemaError, validateGateDocument, type GateDocumentKind } from './schema.js';
export {
  GateRegistryError, GATE_NAMESPACES, splitPackId, validateResolvedPack, resolveThresholdDefault,
  assertGateTightens, applyGateExtends, composeGatePack, resolveGateBinding,
  expandFloorPacks, enforceProjectFloors,
  authoredGatePacksOf, gateProvidersOf, GateRegistry,
  type AuthoredGatePackEntry, type AuthoredGatePackMap,
  type ExpandedFloorPack, type GateNamespace, type ResolvedBinding, type ResolvedPack,
} from './registry.js';
export {
  DEFAULT_PROJECT_FLOOR_PACK, projectCeilingSatisfied, resolveProjectFloors, validateGatesConfig,
} from './floors.js';
export type { ProjectFloors, ProjectFloorSource } from './floors.js';
export {
  GateEvaluationError, maxOutcome, gateStatusOutcome, sealUpstream, sealGateHoldout,
  evaluateGates, type EvaluateGatesInput,
} from './evaluate.js';
export { validateGateReport, type GateReportValidation } from './report.js';
export { createCoreProviderRegistry, evidenceProvider, pairedProvider, proportionProvider, scalarProvider } from './providers/index.js';
export type { MetricProvider } from './providers/index.js';
export { MetricProviderRegistry } from './providers/index.js';
export {
  GateProviderError, computeProviderCodeDigest, loadGateBundleProviders, invokeBundleProvider, sealProviderSection,
  isBundleProvidersEnabled, GATE_PROVIDER_MAX_FILE_BYTES, GATE_PROVIDER_MAX_FILES, GATE_PROVIDER_MAX_TOTAL_BYTES,
  GATE_PROVIDER_DEFAULT_TIMEOUT_MS, GATE_PROVIDER_MAX_TIMEOUT_MS, GATE_PROVIDER_DEFAULT_MAX_RECORDS,
} from './providers/loader.js';
export type { BundleMetricProvider, BundleProviderOptions, ProviderCodeDigest, ProviderExternalPin, ProviderFileDigest } from './providers/loader.js';
