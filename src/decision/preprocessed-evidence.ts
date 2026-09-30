import { canonicalJson, sha256 } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import type { DecisionLifecycleHold, DecisionLifecycleReference, DecisionLifecycleTombstone } from './lifecycle.js';
import {
  artifactDigest, preprocessedEvidenceSchemaErrors, preprocessingLineageSchemaErrors, resolveJsonPointer,
} from './validate.js';
import type { ArtifactPin } from './types.js';

export const PREPROCESSED_EVIDENCE_KIND = 'PreprocessedEvidence' as const;

/**
 * Destination origin for an adapter that declares `egress: { mode: 'none' }` and runs with no
 * D10 projection policy. Manifests authorize local derived-text use by listing
 * `{ provider: <adapter id>, origin: PREPROCESSING_LOCAL_ORIGIN }`.
 */
export const PREPROCESSING_LOCAL_ORIGIN = 'local://no-egress' as const;

export type PreprocessingLocatorClass = 'opaque-id' | 'artifact-ref' | 'local-redacted' | 'remote-url';
export type PreprocessingExtractionKind = 'ocr' | 'asr' | 'caption' | 'image-description';
/** Kinds a recorded preprocessing step may have. Human correction is never a step. */
export type PreprocessingStepKind = PreprocessingExtractionKind
  | 'normalization' | 'redaction' | 'translation' | 'truncation' | 'summary' | 'concatenation';
/** Human correction enters only as a validated, append-only transformation event. */
export type PreprocessingTransformationKind = Exclude<PreprocessingStepKind, PreprocessingExtractionKind> | 'human-correction';
export type PreprocessingKind = PreprocessingStepKind | 'human-correction';
export type PreprocessingReviewFlag = 'low-quality' | 'truncated' | 'incomplete' | 'stale' | 'policy-limited' | 'human-corrected';

const EXTRACTION_KINDS: readonly string[] = ['ocr', 'asr', 'caption', 'image-description'];
const STEP_KINDS: readonly string[] = [...EXTRACTION_KINDS, 'normalization', 'redaction', 'translation', 'truncation', 'summary', 'concatenation'];
const TRANSFORMATION_KINDS: readonly string[] = ['normalization', 'redaction', 'translation', 'truncation', 'human-correction', 'summary', 'concatenation'];
/** Quality flags that block automatic use. `human-corrected` alone does not. */
const REVIEW_FLAGS: ReadonlyArray<Exclude<PreprocessingReviewFlag, 'human-corrected'>> = ['low-quality', 'truncated', 'incomplete', 'stale', 'policy-limited'];

export interface PreprocessedEvidence {
  apiVersion: 'decision.aiwg.io/v1alpha2';
  kind: typeof PREPROCESSED_EVIDENCE_KIND;
  metadata: { id: string; version: string; description: string };
  spec: {
    source: {
      assetId: string;
      contentDigest: `sha256:${string}`;
      mediaType: string;
      sizeBytes: number;
      acquiredAt: string;
      locator: { class: PreprocessingLocatorClass; value: string };
      owner?: string;
      license?: string;
      consent?: string;
      classification: 'public' | 'internal' | 'confidential' | 'restricted';
    };
    preprocessing: PreprocessingStep[];
    output: {
      id: string;
      version: number;
      contentDigest: `sha256:${string}`;
      language: string;
      value: string;
      reference?: { class: PreprocessingLocatorClass; value: string };
    };
    segments: Array<{
      id: string;
      ordinal: number;
      sourceLocator: {
        page?: number;
        startMs?: number;
        endMs?: number;
        frame?: number;
        wholeImage?: boolean;
        bbox?: { x: number; y: number; width: number; height: number; unit: 'pixel' | 'ratio' };
      };
      /** UTF-8 byte range [start, end) of this segment within the digest-verified `output.value`. */
      outputRange: { start: number; end: number };
      text: string;
      textDigest: `sha256:${string}`;
    }>;
    selectedSegments: Array<{ segmentId: string; outputVersion: number; outputDigest: `sha256:${string}` }>;
    quality: { source: 'preprocessor' | 'human-reviewer'; profile: string; label: string; score: number; flags: PreprocessingReviewFlag[] };
    transformations: Array<{
      id: string;
      kind: PreprocessingTransformationKind;
      inputDigest: `sha256:${string}`;
      outputDigest: `sha256:${string}`;
      at: string;
      reviewer?: string;
      rationale?: string;
      previousOutput?: { id: string; version: number; digest: `sha256:${string}` };
    }>;
    policy: {
      trust: 'verified' | 'untrusted';
      sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
      retention: string;
      residency: string;
      rawEgress: { allowed: boolean; destinations: PreprocessingEgressDestination[] };
      derivedEgress: { allowed: boolean; destinations: PreprocessingEgressDestination[] };
    };
  };
}

export interface PreprocessingEgressDestination {
  provider: string;
  origin: string;
}

export interface PreprocessingStep {
  id: string;
  ordinal: number;
  kind: PreprocessingStepKind;
  tool: { id: string; version: string };
  model?: { id: string; version: string };
  configurationDigest: `sha256:${string}`;
  runtime: 'recorded-fixture' | 'offline' | 'live-observed';
  startedAt: string;
  endedAt: string;
  inputDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  /** Required exactly when the step is an identity transform (input digest equals output digest). */
  noOp?: true;
  notesDigest?: `sha256:${string}`;
}

export interface PreprocessedEvidenceReference {
  evidence: ArtifactPin;
  sourceAssetId: string;
  sourceDigest: `sha256:${string}`;
  outputId: string;
  outputVersion: number;
  outputDigest: `sha256:${string}`;
  /** The D10 provider/origin this lineage was resolved (and egress-authorized) for. */
  destination: PreprocessingEgressDestination;
  selectedSegments: Array<{
    id: string;
    ordinal: number;
    locatorDigest: `sha256:${string}`;
    textDigest: `sha256:${string}`;
    preprocessingDigest: `sha256:${string}`;
  }>;
  quality: {
    source: 'preprocessor' | 'human-reviewer';
    profileDigest: `sha256:${string}`;
    labelDigest: `sha256:${string}`;
    score: number;
    flags: PreprocessingReviewFlag[];
  };
  policy: {
    trust: 'verified' | 'untrusted';
    sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
    /** Free-text retention/residency never enter receipts; only their digests do. */
    retentionDigest: `sha256:${string}`;
    residencyDigest: `sha256:${string}`;
    rawEgressAllowed: boolean;
    derivedEgressAllowed: boolean;
  };
}

export interface PreprocessedDecisionState {
  text: string;
  lineage: PreprocessedEvidenceReference[];
}

export interface PreprocessedEvidenceTrace {
  evidence: ArtifactPin;
  stepIds: string[];
  stepCount: number;
  /** Identity steps, declared `noOp: true` in the manifest, recorded explicitly. */
  noOpStepIds: string[];
  sourceDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  selectedSegmentCount: number;
  durationMs: number;
  qualityFlags: PreprocessingReviewFlag[];
  policyOutcome: 'allowed' | 'review';
  reasons: PreprocessedEvidenceReviewReason[];
}

export type PreprocessingDispatchGateReason = PreprocessedEvidenceReviewReason
  | 'unverified' | 'unavailable' | 'destination-mismatch' | 'destination-unbound' | 'malformed-lineage'
  | 'input-unbound' | 'input-mismatch' | 'input-undeclared' | 'lineage-missing';

/** Evaluator-written pre-dispatch verdict. Anything but `allowed` means no credential or transport call. */
export interface PreprocessingDispatchGate {
  outcome: 'allowed' | 'review' | 'refused';
  reasons: PreprocessingDispatchGateReason[];
}

export interface PreprocessedEvidenceReceiptEvidence {
  schemaVersion: 'decision-preprocessing-lineage/v1';
  status: 'ready' | 'review';
  references: PreprocessedEvidenceReference[];
  traces: PreprocessedEvidenceTrace[];
  /** Present only in a RulesetResult: the evaluator's pre-dispatch gate verdict. */
  dispatchGate?: PreprocessingDispatchGate;
}

export type PreprocessedEvidenceReviewReason =
  | 'low-quality' | 'truncated' | 'incomplete' | 'stale' | 'policy-limited' | 'untrusted'
  | 'raw-egress-denied' | 'derived-egress-denied' | 'unsupported-locator'
  | 'lifecycle-unavailable' | 'legal-hold';

/** Host-resolved D10 lifecycle state for the subject that owns the lineage records. */
export interface PreprocessingLifecycleState {
  subject: string;
  now: number;
  tombstones: ReadonlyArray<DecisionLifecycleTombstone>;
  holds: ReadonlyArray<DecisionLifecycleHold>;
}

export interface ResolvePreprocessedEvidenceOptions {
  destination: PreprocessingEgressDestination;
  now?: () => number;
  maxAgeMs?: number;
  minQualityScore?: number;
  allowedLocatorClasses?: PreprocessingLocatorClass[];
  sourceBytes?: Uint8Array;
  requireRawEgress?: boolean;
  /** Tombstoned lineage records withhold text; held records route to review. */
  lifecycle?: PreprocessingLifecycleState;
}

export interface PreprocessedEvidenceResolution {
  status: 'ready' | 'review';
  reasons: PreprocessedEvidenceReviewReason[];
  state: PreprocessedDecisionState;
  receiptEvidence: PreprocessedEvidenceReceiptEvidence;
}

/**
 * Host-controlled verification for a stored lineage. Nothing here comes from the lineage itself:
 * the evaluator re-derives every review reason and the expected input text from these records.
 */
export interface PreprocessingVerification {
  /** Current host-stored manifests, looked up by the lineage reference IDs. */
  manifests: PreprocessedEvidence[];
  /** Required D10 lifecycle state; omitting it routes lineage to review (`lifecycle-unavailable`). */
  lifecycle: PreprocessingLifecycleState;
  /** Required finite acceptance thresholds re-applied to the current manifests. */
  minQualityScore: number;
  maxAgeMs: number;
  now?: () => number;
  /**
   * Which decision input field carries which manifests' verified text, in order. The expected
   * value is recomputed from the verified manifests' selected output slices and compared exactly.
   */
  inputBindings: Array<{ pointer: string; manifestIds: string[] }>;
  /** Every other string field in the decision input must be declared here as non-lineage text. */
  nonLineagePointers?: string[];
}

export class PreprocessedEvidenceError extends Error {
  constructor(readonly reason: 'invalid-manifest' | 'digest-mismatch' | 'broken-chain' | 'policy-denied', message: string) {
    super(message);
    this.name = 'PreprocessedEvidenceError';
  }
}

export interface PreprocessedEvidenceReferenceCheck {
  status: 'current' | 'stale';
  reasons: Array<'manifest-pin' | 'source' | 'output' | 'segments' | 'quality' | 'policy'>;
}

export function preprocessedEvidencePin(manifest: PreprocessedEvidence): ArtifactPin {
  return { id: manifest.metadata.id, version: manifest.metadata.version, digest: artifactDigest(manifest) };
}

export function preprocessedEvidenceContentDigest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${sha256(typeof value === 'string' ? Buffer.from(value, 'utf8') : value)}`;
}

/** True when a lineage carries no references and no traces: it is treated exactly as absent. */
export function isEmptyPreprocessingLineage(lineage: PreprocessedEvidenceReceiptEvidence | undefined): boolean {
  if (lineage === undefined) return true;
  const record = lineage as unknown;
  return isRecord(record) && Array.isArray(record.references) && record.references.length === 0
    && Array.isArray(record.traces) && record.traces.length === 0;
}

/**
 * A host-supplied lineage the evaluator can gate: it matches the closed result schema, has at
 * least one reference, and carries no pre-filled evaluator verdict.
 */
export function isWellFormedPreprocessingLineage(lineage: unknown): lineage is PreprocessedEvidenceReceiptEvidence {
  return preprocessingLineageSchemaErrors(lineage) === null
    && (lineage as PreprocessedEvidenceReceiptEvidence).dispatchGate === undefined
    && (lineage as PreprocessedEvidenceReceiptEvidence).references.length > 0;
}

export function checkPreprocessedEvidenceReference(
  reference: PreprocessedEvidenceReference,
  manifest: PreprocessedEvidence,
): PreprocessedEvidenceReferenceCheck {
  assertPreprocessedEvidence(manifest);
  assertChain(manifest);
  const current = referenceFor(manifest, preprocessedEvidencePin(manifest), selectedSegments(manifest), reference.destination);
  const reasons: PreprocessedEvidenceReferenceCheck['reasons'] = [];
  if (canonicalJson(reference.evidence) !== canonicalJson(current.evidence)) reasons.push('manifest-pin');
  if (reference.sourceAssetId !== current.sourceAssetId || reference.sourceDigest !== current.sourceDigest) reasons.push('source');
  if (reference.outputId !== current.outputId || reference.outputVersion !== current.outputVersion
    || reference.outputDigest !== current.outputDigest) reasons.push('output');
  if (canonicalJson(reference.selectedSegments) !== canonicalJson(current.selectedSegments)) reasons.push('segments');
  if (canonicalJson(reference.quality) !== canonicalJson(current.quality)) reasons.push('quality');
  if (canonicalJson(reference.policy) !== canonicalJson(current.policy)) reasons.push('policy');
  return { status: reasons.length ? 'stale' : 'current', reasons };
}

export function resolvePreprocessedEvidence(
  manifests: PreprocessedEvidence[],
  options: ResolvePreprocessedEvidenceOptions,
): PreprocessedEvidenceResolution {
  if (!manifests.length) {
    return { status: 'ready', reasons: [], state: { text: '', lineage: [] },
      receiptEvidence: { schemaVersion: 'decision-preprocessing-lineage/v1', status: 'ready', references: [], traces: [] } };
  }
  const resolved = manifests.map(manifest => resolveOne(manifest, options));
  const reasons = [...new Set(resolved.flatMap(item => item.reasons))];
  const status = reasons.length ? 'review' : 'ready';
  const text = resolved.map(item => item.text).join(MANIFEST_TEXT_SEPARATOR);
  return {
    status,
    reasons,
    state: {
      text,
      lineage: resolved.map(item => item.reference),
    },
    receiptEvidence: {
      schemaVersion: 'decision-preprocessing-lineage/v1',
      status,
      references: resolved.map(item => item.reference),
      traces: resolved.map(item => item.trace),
    },
  };
}

function resolveOne(manifest: PreprocessedEvidence, options: ResolvePreprocessedEvidenceOptions): {
  text: string;
  reference: PreprocessedEvidenceReference;
  trace: PreprocessedEvidenceTrace;
  reasons: PreprocessedEvidenceReviewReason[];
} {
  assertPreprocessedEvidence(manifest);
  const pin = preprocessedEvidencePin(manifest);
  const reasons: PreprocessedEvidenceReviewReason[] = [];
  const locatorClasses = new Set(options.allowedLocatorClasses ?? ['opaque-id', 'artifact-ref', 'local-redacted']);
  assertLocatorAuthorized(manifest.spec.source.locator, locatorClasses, 'source');
  if (manifest.spec.output.reference) assertLocatorAuthorized(manifest.spec.output.reference, locatorClasses, 'output');
  if (options.sourceBytes && preprocessedEvidenceContentDigest(options.sourceBytes) !== manifest.spec.source.contentDigest) {
    throw new PreprocessedEvidenceError('digest-mismatch', 'source content digest mismatch');
  }
  assertChain(manifest);
  if (options.requireRawEgress
    && !egressAllowed(manifest.spec.policy.rawEgress, options.destination)) {
    reasons.push('raw-egress-denied');
  }
  if (!egressAllowed(manifest.spec.policy.derivedEgress, options.destination)) {
    reasons.push('derived-egress-denied');
  }
  const minQuality = options.minQualityScore ?? 0;
  if (manifest.spec.quality.score < minQuality) reasons.push('low-quality');
  reasons.push(...qualityFlagReasons(manifest.spec.quality.flags));
  if (manifest.spec.policy.trust !== 'verified') reasons.push('untrusted');
  if (options.maxAgeMs !== undefined) {
    const acquired = Date.parse(manifest.spec.source.acquiredAt);
    const now = options.now?.() ?? Date.now();
    if (!Number.isFinite(acquired) || now - acquired > options.maxAgeMs) reasons.push('stale');
  }
  const selected = selectedSegments(manifest);
  if (selected.some(item => item.reference.outputVersion !== manifest.spec.output.version
    || item.reference.outputDigest !== manifest.spec.output.contentDigest)) {
    reasons.push('stale');
  }
  const lifecycle = options.lifecycle ? preprocessingLifecycleReasons(manifest, options.lifecycle) : [];
  reasons.push(...lifecycle);
  const uniqueReasons = [...new Set(reasons)];
  const reference = referenceFor(manifest, pin, selected, options.destination);
  const releasable = reference.policy.derivedEgressAllowed && !lifecycle.includes('lifecycle-unavailable');
  return {
    text: releasable ? verifiedSelectedText(manifest) : '',
    reference,
    trace: {
      evidence: pin,
      stepIds: manifest.spec.preprocessing.map(step => step.id),
      stepCount: manifest.spec.preprocessing.length,
      noOpStepIds: manifest.spec.preprocessing.filter(step => step.noOp === true).map(step => step.id),
      sourceDigest: manifest.spec.source.contentDigest,
      outputDigest: manifest.spec.output.contentDigest,
      selectedSegmentCount: selected.length,
      durationMs: manifest.spec.preprocessing.reduce((sum, step) =>
        sum + Math.max(0, Date.parse(step.endedAt) - Date.parse(step.startedAt)), 0),
      qualityFlags: [...manifest.spec.quality.flags],
      policyOutcome: uniqueReasons.length ? 'review' : 'allowed',
      reasons: uniqueReasons,
    },
    reasons: uniqueReasons,
  };
}

const MANIFEST_TEXT_SEPARATOR = '\n\n';

/** Selected segment text cut from the digest-verified output by byte range, in source order. */
function verifiedSelectedText(manifest: PreprocessedEvidence): string {
  const output = Buffer.from(manifest.spec.output.value, 'utf8');
  return selectedSegments(manifest).map(item => output.subarray(item.segment.outputRange.start, item.segment.outputRange.end)
    .toString('utf8')).join('\n');
}

function qualityFlagReasons(flags: readonly string[]): PreprocessedEvidenceReviewReason[] {
  return REVIEW_FLAGS.filter(flag => flags.includes(flag)) as PreprocessedEvidenceReviewReason[];
}

/**
 * D10 lifecycle records for one manifest. Hosts register these as `links()` of the owning subject,
 * so cascading erasure tombstones the source, every transformation, the output and the manifest.
 * Identical sources or transformations in other manifests map to the same opaque IDs, so one
 * tombstone invalidates every dependent manifest and reference.
 */
export function preprocessingLifecycleReferences(manifest: PreprocessedEvidence): Array<{
  role: 'manifest' | 'source' | 'transformation' | 'output';
  reference: DecisionLifecycleReference;
}> {
  assertPreprocessedEvidence(manifest);
  const opaque = (role: string, value: unknown): DecisionLifecycleReference => ({
    surface: 'preprocessing-lineage', opaqueId: `preprocessing:${role}:${digestJson(value).slice('sha256:'.length)}`,
  });
  const pin = preprocessedEvidencePin(manifest);
  return [
    { role: 'manifest', reference: opaque('manifest', pin) },
    { role: 'source', reference: opaque('source', { assetId: manifest.spec.source.assetId, digest: manifest.spec.source.contentDigest }) },
    ...manifest.spec.preprocessing.map(step => ({ role: 'transformation' as const, reference: opaque('transformation', {
      kind: step.kind, tool: step.tool, model: step.model ?? null, configurationDigest: step.configurationDigest,
      inputDigest: step.inputDigest, outputDigest: step.outputDigest,
    }) })),
    ...manifest.spec.transformations.map(event => ({ role: 'transformation' as const, reference: opaque('transformation', {
      kind: event.kind, inputDigest: event.inputDigest, outputDigest: event.outputDigest, previousOutput: event.previousOutput ?? null,
    }) })),
    { role: 'output', reference: opaque('output', { id: manifest.spec.output.id, version: manifest.spec.output.version,
      digest: manifest.spec.output.contentDigest }) },
  ];
}

/** Lifecycle reasons that stop automatic use of a manifest's derived text. */
export function preprocessingLifecycleReasons(
  manifest: PreprocessedEvidence, state: PreprocessingLifecycleState,
): Array<'lifecycle-unavailable' | 'legal-hold'> {
  const references = preprocessingLifecycleReferences(manifest).map(item => item.reference);
  const reasons: Array<'lifecycle-unavailable' | 'legal-hold'> = [];
  if (!isRecord(state) || !Array.isArray(state.tombstones) || !Array.isArray(state.holds) || !nonEmpty(state.subject)
    || !Number.isSafeInteger(state.now)) {
    return ['lifecycle-unavailable'];
  }
  if (state.tombstones.some(tombstone => references.some(reference =>
    tombstone?.reference?.surface === reference.surface && tombstone.reference.opaqueId === reference.opaqueId))) {
    reasons.push('lifecycle-unavailable');
  }
  if (state.holds.some(hold => hold?.subject === state.subject && hold.expiresAt > state.now
    && Array.isArray(hold.scope) && hold.scope.includes('preprocessing-lineage'))) {
    reasons.push('legal-hold');
  }
  return reasons;
}

/**
 * Pre-dispatch gate for a stored lineage. Runs before credential resolution and transport.
 * `destinations` are the D10 provider/origin of every target the evaluator could dispatch to
 * (`null` when a destination cannot be bound); `input` is the decision input the evaluator
 * projects and dispatches; `dispatchPointers` are the ruleset evaluation input pointers.
 * Stored trace status, reasons and digests are never trusted to allow dispatch.
 */
export function gatePreprocessedEvidenceDispatch(
  lineage: PreprocessedEvidenceReceiptEvidence | undefined,
  verification: PreprocessingVerification | undefined,
  destinations: Array<PreprocessingEgressDestination | null>,
  input: unknown,
  dispatchPointers: readonly string[],
): PreprocessingDispatchGate {
  // The host expects lineage (it supplied verification) but none arrived: never fall back to text-native.
  if (isEmptyPreprocessingLineage(lineage)) return { outcome: 'review', reasons: ['lineage-missing'] };
  if (!isWellFormedPreprocessingLineage(lineage)) return { outcome: 'refused', reasons: ['malformed-lineage'] };
  const refused = new Set<PreprocessingDispatchGateReason>();
  for (const destination of destinations) {
    if (!destination) { refused.add('destination-unbound'); continue; }
    for (const reference of lineage.references) {
      if (!sameDestination(reference.destination, destination)) refused.add('destination-mismatch');
      else if (!reference.policy.derivedEgressAllowed) refused.add('derived-egress-denied');
    }
  }
  if (refused.size) return { outcome: 'refused', reasons: [...refused] };

  // Stored evidence can only add review reasons.
  const review = new Set<PreprocessingDispatchGateReason>();
  for (const trace of lineage.traces) {
    trace.reasons.forEach(reason => review.add(reason));
    qualityFlagReasons(trace.qualityFlags).forEach(reason => review.add(reason));
  }
  for (const reference of lineage.references) {
    qualityFlagReasons(reference.quality.flags).forEach(reason => review.add(reason));
    if (reference.policy.trust !== 'verified') review.add('untrusted');
  }
  if (lineage.status !== 'ready' || lineage.traces.some(trace => trace.policyOutcome !== 'allowed')) {
    if (!review.size) review.add('incomplete');
  }
  if (lineage.traces.length !== lineage.references.length || lineage.references.some((reference, index) =>
    canonicalJson(lineage.traces[index]!.evidence) !== canonicalJson(reference.evidence))) review.add('incomplete');

  if (!isRecord(verification) || !Array.isArray(verification.manifests)) {
    review.add('unverified');
    return { outcome: 'review', reasons: [...review] };
  }
  const thresholds = validThresholds(verification);
  if (!thresholds) review.add('unverified');
  const lifecycle = validLifecycle(verification.lifecycle) ? verification.lifecycle : null;
  if (!lifecycle) review.add('lifecycle-unavailable');

  // Re-derive every reason from the current, host-stored manifests.
  const current = new Map<string, PreprocessedEvidence>();
  let allCurrent = true;
  for (const reference of lineage.references) {
    const matches = verification.manifests.filter(manifest => manifest?.metadata?.id === reference.evidence.id);
    if (matches.length !== 1) { review.add('unavailable'); allCurrent = false; continue; }
    try {
      if (checkPreprocessedEvidenceReference(reference, matches[0]!).status !== 'current') {
        review.add('stale');
        allCurrent = false;
        continue;
      }
      resolveOne(matches[0]!, { destination: reference.destination,
        ...(thresholds ?? {}), ...(lifecycle ? { lifecycle } : {}) }).reasons.forEach(reason => review.add(reason));
      current.set(reference.evidence.id, matches[0]!);
    } catch {
      review.add('stale');
      allCurrent = false;
    }
  }
  // The dispatched text must be exactly the verified text at host-bound pointers.
  if (allCurrent) {
    const binding = inputBindingReasons(verification, current, input, dispatchPointers);
    if (binding === null) review.add('unverified');
    else if (binding.length) return { outcome: 'refused', reasons: binding };
  }
  return review.size ? { outcome: 'review', reasons: [...review] } : { outcome: 'allowed', reasons: [] };
}

function validThresholds(verification: PreprocessingVerification): Pick<ResolvePreprocessedEvidenceOptions,
  'minQualityScore' | 'maxAgeMs' | 'now'> | null {
  const { minQualityScore, maxAgeMs, now } = verification;
  if (typeof minQualityScore !== 'number' || !Number.isFinite(minQualityScore) || minQualityScore < 0 || minQualityScore > 1
    || typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || (now !== undefined && typeof now !== 'function')) return null;
  const clock = now ?? Date.now;
  const at = clock();
  if (!Number.isFinite(at)) return null;
  return { minQualityScore, maxAgeMs, now: () => at };
}

function validLifecycle(value: unknown): value is PreprocessingLifecycleState {
  return isRecord(value) && nonEmpty(value.subject) && Number.isSafeInteger(value.now)
    && Array.isArray(value.tombstones) && Array.isArray(value.holds);
}

/**
 * Binding reasons (empty when every check passes), or null when the host bindings are malformed.
 * Every lineage reference must be bound; every bound pointer must be inside a dispatched evaluation
 * input and hold exactly the recomputed verified text; every other string field must be declared
 * non-lineage by the host.
 */
function inputBindingReasons(verification: PreprocessingVerification, current: Map<string, PreprocessedEvidence>,
  input: unknown, dispatchPointers: readonly string[]): PreprocessingDispatchGateReason[] | null {
  const bindings = verification.inputBindings as unknown;
  const declared = verification.nonLineagePointers ?? [];
  if (!Array.isArray(bindings) || !Array.isArray(declared) || !declared.every(isJsonPointer)
    || bindings.some(binding => !isRecord(binding) || !isJsonPointer(binding.pointer) || binding.pointer === ''
      || !Array.isArray(binding.manifestIds) || !binding.manifestIds.length
      || new Set(binding.manifestIds).size !== binding.manifestIds.length
      || binding.manifestIds.some(id => typeof id !== 'string'))
    || new Set(bindings.map(binding => (binding as { pointer: string }).pointer)).size !== bindings.length) return null;
  const typed = bindings as PreprocessingVerification['inputBindings'];
  const reasons = new Set<PreprocessingDispatchGateReason>();
  const boundIds = new Set(typed.flatMap(binding => binding.manifestIds));
  if ([...current.keys()].some(id => !boundIds.has(id)) || [...boundIds].some(id => !current.has(id))) reasons.add('input-unbound');
  for (const binding of typed) {
    const dispatched = dispatchPointers.some(pointer => pointer === '' || binding.pointer === pointer
      || binding.pointer.startsWith(`${pointer}/`));
    if (!dispatched) { reasons.add('input-unbound'); continue; }
    if (binding.manifestIds.some(id => !current.has(id))) continue;
    const expected = binding.manifestIds.map(id => verifiedSelectedText(current.get(id)!)).join(MANIFEST_TEXT_SEPARATOR);
    const actual = resolveJsonPointer(input, binding.pointer);
    if (!actual.found || actual.value !== expected) reasons.add('input-mismatch');
  }
  // A bound pointer covers exactly its string; a non-lineage declaration covers its whole subtree.
  const bound = new Set(typed.map(binding => binding.pointer));
  const covered = (pointer: string) => bound.has(pointer)
    || declared.some(prefix => prefix === '' || pointer === prefix || pointer.startsWith(`${prefix}/`));
  if (textLeafPointers(input).some(pointer => !covered(pointer))) reasons.add('input-undeclared');
  return [...reasons];
}

function isJsonPointer(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || value.startsWith('/'));
}

/**
 * JSON pointers of every text-bearing position in the input: each string value and each object key.
 * A key is reported at its member's pointer, so it is text that must be bound or declared too.
 */
function textLeafPointers(value: unknown, pointer = ''): string[] {
  if (typeof value === 'string') return [pointer];
  if (Array.isArray(value)) return value.flatMap((item, index) => textLeafPointers(item, `${pointer}/${index}`));
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => {
      const member = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      return [member, ...textLeafPointers(item, member)];
    });
  }
  return [];
}

export function assertPreprocessedEvidence(value: unknown): asserts value is PreprocessedEvidence {
  try { admitEntry(value); } catch (error) { throw invalid('manifest is not admissible', error); }
  if (!isRecord(value) || value.apiVersion !== 'decision.aiwg.io/v1alpha2' || value.kind !== PREPROCESSED_EVIDENCE_KIND) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'unsupported preprocessing manifest kind/version');
  }
  rejectUnknown(value, ['apiVersion', 'kind', 'metadata', 'spec'], 'manifest');
  if (!isRecord(value.metadata) || !isRecord(value.spec)) throw new PreprocessedEvidenceError('invalid-manifest', 'manifest metadata/spec are required');
  rejectUnknown(value.metadata, ['id', 'version', 'description'], 'metadata');
  rejectUnknown(value.spec, ['source', 'preprocessing', 'output', 'segments', 'selectedSegments', 'quality', 'transformations', 'policy'], 'spec');
  if (![value.metadata.id, value.metadata.version, value.metadata.description].every(nonEmpty)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'metadata identity is incomplete');
  }
  const spec = value.spec as PreprocessedEvidence['spec'];
  if (!isRecord(spec.source) || !isRecord(spec.output) || !isRecord(spec.quality) || !isRecord(spec.policy)
    || !Array.isArray(spec.preprocessing) || !Array.isArray(spec.segments) || !Array.isArray(spec.selectedSegments)
    || !Array.isArray(spec.transformations)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'manifest sections are malformed');
  }
  rejectUnknown(spec.source, ['assetId', 'contentDigest', 'mediaType', 'sizeBytes', 'acquiredAt', 'locator', 'owner', 'license', 'consent', 'classification'], 'source');
  if (![spec.source.assetId, spec.source.contentDigest, spec.source.mediaType, spec.source.acquiredAt, spec.source.classification].every(nonEmpty)
    || !Number.isSafeInteger(spec.source.sizeBytes) || spec.source.sizeBytes < 0 || !validDigest(spec.source.contentDigest)
    || !isRecord(spec.source.locator) || !['opaque-id', 'artifact-ref', 'local-redacted', 'remote-url'].includes(String(spec.source.locator.class))
    || !nonEmpty(spec.source.locator.value)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'source identity is malformed');
  }
  rejectUnknown(spec.output, ['id', 'version', 'contentDigest', 'language', 'value', 'reference'], 'output');
  if (![spec.output.id, spec.output.contentDigest, spec.output.language].every(nonEmpty) || typeof spec.output.value !== 'string'
    || !Number.isSafeInteger(spec.output.version) || spec.output.version < 1 || !validDigest(spec.output.contentDigest)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'output identity is malformed');
  }
  if (preprocessedEvidenceContentDigest(spec.output.value) !== spec.output.contentDigest) {
    throw new PreprocessedEvidenceError('digest-mismatch', 'output content digest mismatch');
  }
  validateSteps(spec.preprocessing);
  validateMediaCompatibility(spec);
  validateSegments(spec);
  validateQuality(spec.quality);
  validateTransformations(spec);
  validatePolicy(spec.policy);
  // The closed schema is the final gate: the runtime never accepts what the schema rejects.
  const schemaErrors = preprocessedEvidenceSchemaErrors(value);
  if (schemaErrors !== null) throw new PreprocessedEvidenceError('invalid-manifest', `manifest violates the closed schema: ${schemaErrors}`);
}

function assertLocatorAuthorized(locator: { class: PreprocessingLocatorClass }, classes: Set<string>, label: string): void {
  if (!classes.has(locator.class) || locator.class === 'remote-url') {
    throw new PreprocessedEvidenceError('policy-denied', `${label} locator class is not authorized`);
  }
}

function assertChain(manifest: PreprocessedEvidence): void {
  const seenStepIds = new Set<string>();
  const seenDigests = new Set<string>([manifest.spec.source.contentDigest]);
  let previous = manifest.spec.source.contentDigest;
  manifest.spec.preprocessing.forEach((step, index) => {
    if (seenStepIds.has(step.id)) throw new PreprocessedEvidenceError('broken-chain', 'preprocessing chain contains duplicate step IDs');
    seenStepIds.add(step.id);
    if (step.ordinal !== index + 1 || step.inputDigest !== previous) {
      throw new PreprocessedEvidenceError('broken-chain', 'preprocessing chain continuity is broken');
    }
    const identity = step.outputDigest === step.inputDigest;
    if (identity !== (step.noOp === true)) {
      throw new PreprocessedEvidenceError('broken-chain', identity
        ? 'identity step must be declared as an explicit no-op' : 'declared no-op step changes content');
    }
    if (!identity && seenDigests.has(step.outputDigest)) {
      throw new PreprocessedEvidenceError('broken-chain', 'preprocessing chain contains a digest cycle');
    }
    seenDigests.add(step.outputDigest);
    previous = step.outputDigest;
  });
  // Human corrections are append-only: each takes the current output as input and bumps the version.
  let correctedFrom: { version: number; at: number } | null = null;
  for (const event of manifest.spec.transformations.filter(item => item.kind === 'human-correction')) {
    const previousOutput = event.previousOutput!;
    const at = Date.parse(event.at);
    if (event.inputDigest !== previous || previousOutput.digest !== previous || previousOutput.id !== manifest.spec.output.id
      || event.outputDigest === previous || seenDigests.has(event.outputDigest)
      || (correctedFrom && (previousOutput.version <= correctedFrom.version || at < correctedFrom.at))) {
      throw new PreprocessedEvidenceError('broken-chain', 'human correction must append a newer linked output version');
    }
    correctedFrom = { version: previousOutput.version, at };
    seenDigests.add(event.outputDigest);
    previous = event.outputDigest;
  }
  if (correctedFrom && manifest.spec.output.version <= correctedFrom.version) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'human correction must create a newer linked output version');
  }
  if (previous !== manifest.spec.output.contentDigest) {
    throw new PreprocessedEvidenceError('digest-mismatch', 'final preprocessing output does not match output identity');
  }
  for (const event of manifest.spec.transformations) {
    if (!seenDigests.has(event.inputDigest) || !seenDigests.has(event.outputDigest)) {
      throw new PreprocessedEvidenceError('broken-chain', 'transformation event is not linked to the preprocessing chain');
    }
  }
}

function selectedSegments(manifest: PreprocessedEvidence) {
  const segments = new Map(manifest.spec.segments.map(segment => [segment.id, segment]));
  return manifest.spec.selectedSegments.map(reference => {
    const segment = segments.get(reference.segmentId);
    if (!segment) throw new PreprocessedEvidenceError('broken-chain', 'selected segment is missing');
    return { segment, reference };
  }).sort((left, right) => left.segment.ordinal - right.segment.ordinal);
}

function referenceFor(
  manifest: PreprocessedEvidence,
  pin: ArtifactPin,
  selected: ReturnType<typeof selectedSegments>,
  destination: PreprocessingEgressDestination,
): PreprocessedEvidenceReference {
  const preprocessingDigest = digestJson({
    steps: manifest.spec.preprocessing.map(step => ({
      id: step.id, ordinal: step.ordinal, kind: step.kind, tool: step.tool, model: step.model ?? null,
      configurationDigest: step.configurationDigest, noOp: step.noOp === true,
    })),
    transformations: manifest.spec.transformations.map(event => ({
      id: event.id, kind: event.kind, inputDigest: event.inputDigest, outputDigest: event.outputDigest,
      reviewer: event.reviewer ?? null, rationale: event.rationale ?? null, previousOutput: event.previousOutput ?? null,
    })),
  });
  return {
    evidence: pin,
    sourceAssetId: manifest.spec.source.assetId,
    sourceDigest: manifest.spec.source.contentDigest,
    outputId: manifest.spec.output.id,
    outputVersion: manifest.spec.output.version,
    outputDigest: manifest.spec.output.contentDigest,
    destination: { provider: destination.provider, origin: destination.origin },
    selectedSegments: selected.map(item => ({
      id: item.segment.id,
      ordinal: item.segment.ordinal,
      locatorDigest: digestJson({ source: item.segment.sourceLocator, output: item.segment.outputRange }),
      textDigest: item.segment.textDigest,
      preprocessingDigest,
    })),
    quality: {
      source: manifest.spec.quality.source,
      profileDigest: preprocessedEvidenceContentDigest(manifest.spec.quality.profile),
      labelDigest: preprocessedEvidenceContentDigest(manifest.spec.quality.label),
      score: manifest.spec.quality.score,
      flags: [...manifest.spec.quality.flags],
    },
    policy: {
      trust: manifest.spec.policy.trust,
      sensitivity: manifest.spec.policy.sensitivity,
      retentionDigest: preprocessedEvidenceContentDigest(manifest.spec.policy.retention),
      residencyDigest: preprocessedEvidenceContentDigest(manifest.spec.policy.residency),
      rawEgressAllowed: egressAllowed(manifest.spec.policy.rawEgress, destination),
      derivedEgressAllowed: egressAllowed(manifest.spec.policy.derivedEgress, destination),
    },
  };
}

function validateSteps(steps: PreprocessingStep[]): void {
  if (!steps.length) throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing chain is required');
  for (const step of steps) {
    if (!isRecord(step)) throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing step is malformed');
    rejectUnknown(step, ['id', 'ordinal', 'kind', 'tool', 'model', 'configurationDigest', 'runtime', 'startedAt', 'endedAt', 'inputDigest', 'outputDigest', 'noOp', 'notesDigest'], 'preprocessing step');
    if (!nonEmpty(step.id) || !Number.isSafeInteger(step.ordinal) || step.ordinal < 1
      || !STEP_KINDS.includes(step.kind)
      || !isRecord(step.tool) || !nonEmpty(step.tool.id) || !nonEmpty(step.tool.version)
      || !validDigest(step.configurationDigest) || !validDigest(step.inputDigest) || !validDigest(step.outputDigest)
      || !['recorded-fixture', 'offline', 'live-observed'].includes(step.runtime)
      || !Number.isFinite(Date.parse(step.startedAt)) || !Number.isFinite(Date.parse(step.endedAt))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing step identity is malformed');
    }
    if (step.noOp !== undefined && (step.noOp !== true || EXTRACTION_KINDS.includes(step.kind))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'only a non-extraction step can be declared no-op');
    }
  }
}

function validateSegments(spec: PreprocessedEvidence['spec']): void {
  if (!spec.segments.length || !spec.selectedSegments.length) throw new PreprocessedEvidenceError('invalid-manifest', 'segments are required');
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const output = Buffer.from(spec.output.value, 'utf8');
  for (const segment of spec.segments) {
    if (!isRecord(segment)) throw new PreprocessedEvidenceError('invalid-manifest', 'segment is malformed');
    rejectUnknown(segment, ['id', 'ordinal', 'sourceLocator', 'outputRange', 'text', 'textDigest'], 'segment');
    if (!nonEmpty(segment.id) || !Number.isSafeInteger(segment.ordinal) || segment.ordinal < 1
      || typeof segment.text !== 'string' || !validDigest(segment.textDigest) || !isRecord(segment.sourceLocator)) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'segment locator is malformed');
    }
    if (ids.has(segment.id) || ordinals.has(segment.ordinal)) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'segments contain duplicate IDs or ordinals');
    }
    ids.add(segment.id);
    ordinals.add(segment.ordinal);
    if (preprocessedEvidenceContentDigest(segment.text) !== segment.textDigest) {
      throw new PreprocessedEvidenceError('digest-mismatch', 'segment text digest mismatch');
    }
    const range = segment.outputRange;
    if (!isRecord(range) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end > output.length) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'segment output range is outside the verified output');
    }
    if (!output.subarray(range.start, range.end).equals(Buffer.from(segment.text, 'utf8'))) {
      throw new PreprocessedEvidenceError('digest-mismatch', 'segment text is not the verified output slice');
    }
    const locator = segment.sourceLocator;
    const hasPage = Number.isSafeInteger(locator.page);
    const hasTime = Number.isSafeInteger(locator.startMs) && Number.isSafeInteger(locator.endMs)
      && typeof locator.endMs === 'number' && typeof locator.startMs === 'number' && locator.endMs >= locator.startMs;
    const hasFrame = Number.isSafeInteger(locator.frame);
    const hasWholeImage = locator.wholeImage === true;
    const hasBox = isRecord(locator.bbox) && typeof locator.bbox.x === 'number' && typeof locator.bbox.y === 'number'
      && typeof locator.bbox.width === 'number' && typeof locator.bbox.height === 'number'
      && ['pixel', 'ratio'].includes(String(locator.bbox.unit));
    if (!hasPage && !hasTime && !hasFrame && !hasBox && !hasWholeImage) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'segment requires a page, time, frame, box or whole-image locator');
    }
    validateLocatorForMedia(spec.source.mediaType, locator, primaryExtractionKind(spec.preprocessing));
  }
  // Source order is preserved: ordinal order is also output order.
  const ordered = [...spec.segments].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((segment, index) => index > 0 && segment.outputRange.start < ordered[index - 1]!.outputRange.end)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'segment output ranges must follow ordinal order without overlap');
  }
  const selectedIds = new Set<string>();
  for (const reference of spec.selectedSegments) {
    if (!isRecord(reference)) throw new PreprocessedEvidenceError('invalid-manifest', 'selected segment is malformed');
    if (selectedIds.has(String(reference.segmentId))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'selected segments contain duplicate segment IDs');
    }
    selectedIds.add(String(reference.segmentId));
    rejectUnknown(reference, ['segmentId', 'outputVersion', 'outputDigest'], 'selected segment');
    if (!nonEmpty(reference.segmentId) || !Number.isSafeInteger(reference.outputVersion)
      || reference.outputVersion < 1 || !validDigest(reference.outputDigest)) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'selected segment identity is malformed');
    }
  }
}

function validateQuality(quality: PreprocessedEvidence['spec']['quality']): void {
  rejectUnknown(quality, ['source', 'profile', 'label', 'score', 'flags'], 'quality');
  if (!['preprocessor', 'human-reviewer'].includes(quality.source) || !nonEmpty(quality.profile)
    || !nonEmpty(quality.label) || typeof quality.score !== 'number' || quality.score < 0 || quality.score > 1
    || !Array.isArray(quality.flags) || quality.flags.some(flag => !['low-quality', 'truncated', 'incomplete', 'stale', 'policy-limited', 'human-corrected'].includes(flag))) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'quality evidence is malformed');
  }
}

function validateTransformations(spec: PreprocessedEvidence['spec']): void {
  for (const event of spec.transformations) {
    if (!isRecord(event)) throw new PreprocessedEvidenceError('invalid-manifest', 'transformation event is malformed');
    rejectUnknown(event, ['id', 'kind', 'inputDigest', 'outputDigest', 'at', 'reviewer', 'rationale', 'previousOutput'], 'transformation event');
    if (!nonEmpty(event.id) || !TRANSFORMATION_KINDS.includes(event.kind)
      || !validDigest(event.inputDigest) || !validDigest(event.outputDigest) || !Number.isFinite(Date.parse(event.at))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'transformation event is malformed');
    }
    if (event.kind === 'human-correction' && (!nonEmpty(event.reviewer) || !nonEmpty(event.rationale) || !isRecord(event.previousOutput)
      || !nonEmpty(event.previousOutput.id) || !Number.isSafeInteger(event.previousOutput.version)
      || event.previousOutput.version < 1 || !validDigest(event.previousOutput.digest))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'human correction requires reviewer, rationale and previous output link');
    }
  }
}

function validatePolicy(policy: PreprocessedEvidence['spec']['policy']): void {
  rejectUnknown(policy, ['trust', 'sensitivity', 'retention', 'residency', 'rawEgress', 'derivedEgress'], 'policy');
  if (!['verified', 'untrusted'].includes(policy.trust) || !['public', 'internal', 'confidential', 'restricted'].includes(policy.sensitivity)
    || !nonEmpty(policy.retention) || !nonEmpty(policy.residency) || !egress(policy.rawEgress) || !egress(policy.derivedEgress)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'lineage policy is malformed');
  }
}

function egress(value: unknown): value is { allowed: boolean; destinations: PreprocessingEgressDestination[] } {
  return isRecord(value) && typeof value.allowed === 'boolean' && Array.isArray(value.destinations)
    && value.destinations.every(destination => isRecord(destination) && nonEmpty(destination.provider) && nonEmpty(destination.origin));
}

function egressAllowed(value: { allowed: boolean; destinations: PreprocessingEgressDestination[] },
  destination: PreprocessingEgressDestination): boolean {
  return value.allowed && value.destinations.some(item => sameDestination(item, destination));
}

function sameDestination(left: PreprocessingEgressDestination, right: PreprocessingEgressDestination): boolean {
  return left.provider === right.provider && normalizeOrigin(left.origin) === normalizeOrigin(right.origin);
}

function validateMediaCompatibility(spec: PreprocessedEvidence['spec']): void {
  const kind = primaryExtractionKind(spec.preprocessing);
  if (!kind) throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing chain requires an extraction step');
  if (kind === 'ocr' && !(spec.source.mediaType.startsWith('image/') || spec.source.mediaType === 'application/pdf')) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'OCR source media type must be image or PDF');
  }
  if (kind === 'asr' && !(spec.source.mediaType.startsWith('audio/') || spec.source.mediaType.startsWith('video/'))) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'transcription source media type must be audio or video');
  }
  if (kind === 'caption' && !spec.source.mediaType.startsWith('video/')) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'caption source media type must be video');
  }
  if (kind === 'image-description' && !spec.source.mediaType.startsWith('image/')) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'image description source media type must be image');
  }
}

function primaryExtractionKind(steps: PreprocessingStep[]): PreprocessingExtractionKind | null {
  return steps.find((step): step is PreprocessingStep & { kind: PreprocessingExtractionKind } =>
    EXTRACTION_KINDS.includes(step.kind))?.kind ?? null;
}

function validateLocatorForMedia(
  mediaType: string,
  locator: PreprocessedEvidence['spec']['segments'][number]['sourceLocator'],
  kind: ReturnType<typeof primaryExtractionKind>,
): void {
  const hasPage = Number.isSafeInteger(locator.page);
  const hasTime = Number.isSafeInteger(locator.startMs) && Number.isSafeInteger(locator.endMs)
    && typeof locator.endMs === 'number' && typeof locator.startMs === 'number' && locator.endMs >= locator.startMs;
  const hasFrame = Number.isSafeInteger(locator.frame);
  const hasBox = isRecord(locator.bbox);
  const hasWholeImage = locator.wholeImage === true;
  if (mediaType.startsWith('audio/') && (!hasTime || hasPage || hasFrame || hasBox || hasWholeImage)) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'audio segments require a time range locator');
  }
  if (mediaType.startsWith('video/') && !hasTime && !hasFrame) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'video segments require time or frame locators');
  }
  if (kind === 'ocr' && (mediaType === 'application/pdf' || mediaType.startsWith('image/')) && !hasPage) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'scanned document OCR segments require a page locator');
  }
  if (kind === 'image-description' && mediaType.startsWith('image/') && !hasBox && !hasWholeImage) {
    throw new PreprocessedEvidenceError('invalid-manifest', 'image description segments require a box or whole-image locator');
  }
}

/** HTTP(S) origins compare by URL origin; any other scheme (for example `local://`) compares exactly. */
function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : value;
  } catch { return value; }
}

function invalid(message: string, _error: unknown): PreprocessedEvidenceError {
  return new PreprocessedEvidenceError('invalid-manifest', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new PreprocessedEvidenceError('invalid-manifest', `${label} contains unsupported fields`);
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${sha256(Buffer.from(canonicalJson(value), 'utf8'))}`;
}
