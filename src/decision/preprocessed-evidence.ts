import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';
import { artifactDigest } from './validate.js';
import type { ArtifactPin } from './types.js';

export const PREPROCESSED_EVIDENCE_KIND = 'PreprocessedEvidence' as const;

export type PreprocessingLocatorClass = 'opaque-id' | 'artifact-ref' | 'local-redacted' | 'remote-url';
export type PreprocessingKind =
  | 'ocr' | 'asr' | 'caption' | 'image-description' | 'normalization'
  | 'redaction' | 'translation' | 'truncation' | 'human-correction'
  | 'summary' | 'concatenation';
export type PreprocessingReviewFlag = 'low-quality' | 'truncated' | 'incomplete' | 'stale' | 'policy-limited' | 'human-corrected';

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
        bbox?: { x: number; y: number; width: number; height: number; unit: 'pixel' | 'ratio' };
      };
      textDigest: `sha256:${string}`;
    }>;
    selectedSegments: Array<{ segmentId: string; outputVersion: number; outputDigest: `sha256:${string}` }>;
    quality: { source: 'preprocessor' | 'human-reviewer'; profile: string; label: string; score: number; flags: PreprocessingReviewFlag[] };
    transformations: Array<{
      id: string;
      kind: Exclude<PreprocessingKind, 'ocr' | 'asr' | 'caption' | 'image-description'>;
      inputDigest: `sha256:${string}`;
      outputDigest: `sha256:${string}`;
      at: string;
      reviewer?: string;
      rationale?: string;
    }>;
    policy: {
      trust: 'verified' | 'untrusted';
      sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
      retention: string;
      residency: string;
      rawEgress: { allowed: boolean; destinations: string[] };
      derivedEgress: { allowed: boolean; destinations: string[] };
    };
  };
}

export interface PreprocessingStep {
  id: string;
  ordinal: number;
  kind: PreprocessingKind;
  tool: { id: string; version: string };
  model?: { id: string; version: string };
  configurationDigest: `sha256:${string}`;
  runtime: 'recorded-fixture' | 'offline' | 'live-observed';
  startedAt: string;
  endedAt: string;
  inputDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  notesDigest?: `sha256:${string}`;
}

export interface PreprocessedEvidenceReference {
  evidence: ArtifactPin;
  sourceAssetId: string;
  sourceDigest: `sha256:${string}`;
  outputId: string;
  outputVersion: number;
  outputDigest: `sha256:${string}`;
  selectedSegments: Array<{ id: string; ordinal: number; locatorDigest: `sha256:${string}` }>;
  quality: { source: string; profile: string; label: string; score: number; flags: PreprocessingReviewFlag[] };
  policy: {
    trust: string;
    sensitivity: string;
    retention: string;
    residency: string;
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
  sourceDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  selectedSegmentCount: number;
  durationMs: number;
  qualityFlags: PreprocessingReviewFlag[];
  policyOutcome: 'allowed' | 'review';
  reasons: PreprocessedEvidenceReviewReason[];
}

export interface PreprocessedEvidenceReceiptEvidence {
  schemaVersion: 'decision-preprocessing-lineage/v1';
  references: PreprocessedEvidenceReference[];
  traces: PreprocessedEvidenceTrace[];
}

export type PreprocessedEvidenceReviewReason =
  | 'low-quality' | 'truncated' | 'incomplete' | 'stale'
  | 'raw-egress-denied' | 'derived-egress-denied' | 'unsupported-locator';

export interface ResolvePreprocessedEvidenceOptions {
  destination: string;
  now?: () => number;
  maxAgeMs?: number;
  minQualityScore?: number;
  allowedLocatorClasses?: PreprocessingLocatorClass[];
  sourceBytes?: Uint8Array;
  requireRawEgress?: boolean;
}

export interface PreprocessedEvidenceResolution {
  status: 'ready' | 'review';
  reasons: PreprocessedEvidenceReviewReason[];
  state: PreprocessedDecisionState;
  receiptEvidence: PreprocessedEvidenceReceiptEvidence;
}

export class PreprocessedEvidenceError extends Error {
  constructor(readonly reason: 'invalid-manifest' | 'digest-mismatch' | 'broken-chain' | 'policy-denied', message: string) {
    super(message);
    this.name = 'PreprocessedEvidenceError';
  }
}

export function preprocessedEvidencePin(manifest: PreprocessedEvidence): ArtifactPin {
  return { id: manifest.metadata.id, version: manifest.metadata.version, digest: artifactDigest(manifest) };
}

export function contentDigest(value: string | Uint8Array): `sha256:${string}` {
  const hash = createHash('sha256');
  hash.update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));
  return `sha256:${hash.digest('hex')}`;
}

export function resolvePreprocessedEvidence(
  manifests: PreprocessedEvidence[],
  options: ResolvePreprocessedEvidenceOptions,
): PreprocessedEvidenceResolution {
  if (!manifests.length) {
    return { status: 'ready', reasons: [], state: { text: '', lineage: [] }, receiptEvidence: { schemaVersion: 'decision-preprocessing-lineage/v1', references: [], traces: [] } };
  }
  const resolved = manifests.map(manifest => resolveOne(manifest, options));
  const reasons = [...new Set(resolved.flatMap(item => item.reasons))];
  return {
    status: reasons.length ? 'review' : 'ready',
    reasons,
    state: {
      text: resolved.map(item => item.text).join('\n\n'),
      lineage: resolved.map(item => item.reference),
    },
    receiptEvidence: {
      schemaVersion: 'decision-preprocessing-lineage/v1',
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
  if (!locatorClasses.has(manifest.spec.source.locator.class) || manifest.spec.source.locator.class === 'remote-url') {
    throw new PreprocessedEvidenceError('policy-denied', 'source locator class is not authorized');
  }
  if (options.sourceBytes && contentDigest(options.sourceBytes) !== manifest.spec.source.contentDigest) {
    throw new PreprocessedEvidenceError('digest-mismatch', 'source content digest mismatch');
  }
  if (contentDigest(manifest.spec.output.value) !== manifest.spec.output.contentDigest) {
    throw new PreprocessedEvidenceError('digest-mismatch', 'output content digest mismatch');
  }
  assertChain(manifest);
  if (options.requireRawEgress
    && (!manifest.spec.policy.rawEgress.allowed || !manifest.spec.policy.rawEgress.destinations.includes(options.destination))) {
    reasons.push('raw-egress-denied');
  }
  if (!manifest.spec.policy.derivedEgress.allowed || !manifest.spec.policy.derivedEgress.destinations.includes(options.destination)) {
    reasons.push('derived-egress-denied');
  }
  const minQuality = options.minQualityScore ?? 0;
  if (manifest.spec.quality.score < minQuality || manifest.spec.quality.flags.includes('low-quality')) reasons.push('low-quality');
  if (manifest.spec.quality.flags.includes('truncated')) reasons.push('truncated');
  if (manifest.spec.quality.flags.includes('incomplete')) reasons.push('incomplete');
  if (manifest.spec.quality.flags.includes('stale')) reasons.push('stale');
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
  const uniqueReasons = [...new Set(reasons)];
  const reference: PreprocessedEvidenceReference = {
    evidence: pin,
    sourceAssetId: manifest.spec.source.assetId,
    sourceDigest: manifest.spec.source.contentDigest,
    outputId: manifest.spec.output.id,
    outputVersion: manifest.spec.output.version,
    outputDigest: manifest.spec.output.contentDigest,
    selectedSegments: selected.map(item => ({
      id: item.segment.id,
      ordinal: item.segment.ordinal,
      locatorDigest: digestJson(item.segment.sourceLocator),
    })),
    quality: structuredClone(manifest.spec.quality),
    policy: {
      trust: manifest.spec.policy.trust,
      sensitivity: manifest.spec.policy.sensitivity,
      retention: manifest.spec.policy.retention,
      residency: manifest.spec.policy.residency,
      rawEgressAllowed: manifest.spec.policy.rawEgress.allowed && manifest.spec.policy.rawEgress.destinations.includes(options.destination),
      derivedEgressAllowed: manifest.spec.policy.derivedEgress.allowed && manifest.spec.policy.derivedEgress.destinations.includes(options.destination),
    },
  };
  return {
    text: reference.policy.derivedEgressAllowed ? manifest.spec.output.value : '',
    reference,
    trace: {
      evidence: pin,
      stepIds: manifest.spec.preprocessing.map(step => step.id),
      stepCount: manifest.spec.preprocessing.length,
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
  validateSteps(spec.preprocessing);
  validateSegments(spec);
  validateQuality(spec.quality);
  validateTransformations(spec.transformations);
  validatePolicy(spec.policy);
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
    if (seenDigests.has(step.outputDigest)) throw new PreprocessedEvidenceError('broken-chain', 'preprocessing chain contains a digest cycle');
    seenDigests.add(step.outputDigest);
    previous = step.outputDigest;
  });
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

function validateSteps(steps: PreprocessingStep[]): void {
  if (!steps.length) throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing chain is required');
  for (const step of steps) {
    if (!isRecord(step)) throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing step is malformed');
    rejectUnknown(step, ['id', 'ordinal', 'kind', 'tool', 'model', 'configurationDigest', 'runtime', 'startedAt', 'endedAt', 'inputDigest', 'outputDigest', 'notesDigest'], 'preprocessing step');
    if (!nonEmpty(step.id) || !Number.isSafeInteger(step.ordinal) || step.ordinal < 1
      || !['ocr', 'asr', 'caption', 'image-description', 'normalization', 'redaction', 'translation', 'truncation', 'human-correction', 'summary', 'concatenation'].includes(step.kind)
      || !isRecord(step.tool) || !nonEmpty(step.tool.id) || !nonEmpty(step.tool.version)
      || !validDigest(step.configurationDigest) || !validDigest(step.inputDigest) || !validDigest(step.outputDigest)
      || !['recorded-fixture', 'offline', 'live-observed'].includes(step.runtime)
      || !Number.isFinite(Date.parse(step.startedAt)) || !Number.isFinite(Date.parse(step.endedAt))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'preprocessing step identity is malformed');
    }
  }
}

function validateSegments(spec: PreprocessedEvidence['spec']): void {
  if (!spec.segments.length || !spec.selectedSegments.length) throw new PreprocessedEvidenceError('invalid-manifest', 'segments are required');
  for (const segment of spec.segments) {
    if (!isRecord(segment)) throw new PreprocessedEvidenceError('invalid-manifest', 'segment is malformed');
    rejectUnknown(segment, ['id', 'ordinal', 'sourceLocator', 'textDigest'], 'segment');
    if (!nonEmpty(segment.id) || !Number.isSafeInteger(segment.ordinal) || segment.ordinal < 1
      || !validDigest(segment.textDigest) || !isRecord(segment.sourceLocator)) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'segment locator is malformed');
    }
    const locator = segment.sourceLocator;
    const hasPage = Number.isSafeInteger(locator.page);
    const hasTime = Number.isSafeInteger(locator.startMs) && Number.isSafeInteger(locator.endMs)
      && typeof locator.endMs === 'number' && typeof locator.startMs === 'number' && locator.endMs >= locator.startMs;
    const hasFrame = Number.isSafeInteger(locator.frame);
    const hasBox = isRecord(locator.bbox) && typeof locator.bbox.x === 'number' && typeof locator.bbox.y === 'number'
      && typeof locator.bbox.width === 'number' && typeof locator.bbox.height === 'number'
      && ['pixel', 'ratio'].includes(String(locator.bbox.unit));
    if (!hasPage && !hasTime && !hasFrame && !hasBox) throw new PreprocessedEvidenceError('invalid-manifest', 'segment requires a page, time, frame or box locator');
  }
  for (const reference of spec.selectedSegments) {
    if (!isRecord(reference)) throw new PreprocessedEvidenceError('invalid-manifest', 'selected segment is malformed');
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

function validateTransformations(events: PreprocessedEvidence['spec']['transformations']): void {
  for (const event of events) {
    if (!isRecord(event)) throw new PreprocessedEvidenceError('invalid-manifest', 'transformation event is malformed');
    rejectUnknown(event, ['id', 'kind', 'inputDigest', 'outputDigest', 'at', 'reviewer', 'rationale'], 'transformation event');
    if (!nonEmpty(event.id) || !['normalization', 'redaction', 'translation', 'truncation', 'human-correction', 'summary', 'concatenation'].includes(event.kind)
      || !validDigest(event.inputDigest) || !validDigest(event.outputDigest) || !Number.isFinite(Date.parse(event.at))) {
      throw new PreprocessedEvidenceError('invalid-manifest', 'transformation event is malformed');
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

function egress(value: unknown): value is { allowed: boolean; destinations: string[] } {
  return isRecord(value) && typeof value.allowed === 'boolean' && Array.isArray(value.destinations)
    && value.destinations.every(nonEmpty);
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
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
