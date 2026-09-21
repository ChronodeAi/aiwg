import type {
  AdapterCapabilities,
  AdapterObservation,
  DecisionAdapterRequest,
  DecisionAdapter,
  DecisionFailureReason,
  DecisionUsage,
} from '../types.js';
import { DecisionValidationError, validateDecisionValue, validateDistribution } from '../validate.js';
import { canonicalJson } from '../../security/artifact-trust.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

interface JevAdapterOptions {
  endpoint?: string;
  fetch?: typeof fetch;
}

export class JevDecisionAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version = '1.0.0';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['typed-output', 'probability-distribution', 'structured-entries'],
      maxOptions: 255,
      maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      executable: true,
    };
  }

  async evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation> {
    const credential = new Uint8Array(await request.resolveCredential(requireCredentialRef(request)));
    const token = new TextDecoder().decode(credential);
    credential.fill(0);
    if (!token) return failure('authentication');
    const timeoutMs = Math.max(1, request.deadlineEpochMs - Date.now());
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          state: request.input,
          model: request.target.model,
          questions: { [request.alias]: toJevQuestion(request) },
        }),
        signal,
      });
    } catch (error) {
      return failure(signal.aborted || isAbort(error) ? 'timeout' : 'network-transient');
    }
    if (!response.ok) {
      const failed = failure(mapStatus(response.status));
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return retryAfterMs === null ? failed : { ...failed, retryAfterMs };
    }

    let body: unknown;
    try {
      body = await response.json();
      const normalized = normalizeResponse(request, body);
      return { ...normalized, requestId: response.headers.get('x-request-id') };
    } catch {
      return failure('invalid-output');
    }
  }
}

function toJevQuestion(request: DecisionAdapterRequest): Record<string, unknown> {
  const { answer } = request.definition.spec;
  if (answer.kind === 'choice') {
    return {
      type: 'choice',
      instructions: request.definition.spec.question,
      criteria: Object.fromEntries(answer.options.map(option => [option.id, option.description])),
    };
  }
  if (answer.kind === 'ordinal-score') {
    return { type: 'score', instructions: request.definition.spec.question, criteria: answer.levels };
  }
  return {
    type: 'noul',
    instructions: request.definition.spec.question,
    criteria: { true: answer.trueDescription, false: answer.falseDescription },
  };
}

function normalizeResponse(request: DecisionAdapterRequest, value: unknown): AdapterObservation {
  const body = asRecord(value);
  const answers = asRecord(body.answers);
  if (Object.keys(answers).length !== 1 || !Object.prototype.hasOwnProperty.call(answers, request.alias)) {
    throw new DecisionValidationError('Jev response must contain exactly the requested answer key');
  }
  const answer = asRecord(answers[request.alias]);
  const model = typeof body.model === 'string' && body.model ? body.model : null;
  const usage = normalizeUsage(body.usage);
  const kind = request.definition.spec.answer.kind;
  if (kind === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') throw new DecisionValidationError('invalid Choice response');
    const distribution = numericRecord(answer.probabilities);
    validateDistribution(request.definition, distribution);
    validateDecisionValue(request.definition, answer.choice);
    const maximum = Math.max(...Object.values(distribution));
    if (distribution[answer.choice] !== maximum) throw new DecisionValidationError('Choice value must have maximal probability');
    return success(answer.choice, model, usage, uncertainty(answer.confidence, distribution, 'typesafe-distribution-v1'));
  }
  if (kind === 'ordinal-score') {
    if (answer.type !== 'score' || typeof answer.score !== 'number') throw new DecisionValidationError('invalid Score response');
    const distribution = numericRecord(answer.probabilities);
    validateDistribution(request.definition, distribution);
    const legend = asRecord(answer.legend);
    request.definition.spec.answer.levels.forEach((level, index) => {
      if (canonicalJson(legend[String(index)]) !== canonicalJson(level)) throw new DecisionValidationError('Score legend does not match declared levels');
    });
    const mean = Object.entries(distribution).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
    if (Math.abs(mean - answer.score) > 0.02) throw new DecisionValidationError('Score is not the distribution weighted mean');
    validateDecisionValue(request.definition, answer.score);
    return success(answer.score, model, usage, uncertainty(answer.confidence, distribution, 'typesafe-distribution-v1'));
  }
  if (answer.type !== 'noul' || typeof answer.noul !== 'number') throw new DecisionValidationError('invalid Noul response');
  validateDecisionValue(request.definition, answer.noul);
  return success(answer.noul, model, usage, {
    source: 'provider', profile: 'typesafe-truth-v1', calibration: 'vendor-claimed',
    confidence: null, distribution: null, calibrationRef: null,
  });
}

function success(value: string | number, actualModel: string | null, usage: DecisionUsage, uncertaintyValue: AdapterObservation['uncertainty']): AdapterObservation {
  return { status: 'success', reason: 'none', value, uncertainty: uncertaintyValue, actualModel, usage, requestId: null };
}

function failure(reason: DecisionFailureReason): AdapterObservation {
  const status = reason === 'unsupported-capability' ? 'unsupported' : reason === 'cancelled' ? 'cancelled' : 'error';
  return { status, reason, uncertainty: null, actualModel: null, usage: emptyUsage(), requestId: null };
}

function uncertainty(confidence: unknown, distribution: Record<string, number>, profile: string): AdapterObservation['uncertainty'] {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new DecisionValidationError('confidence must be a finite probability');
  }
  return { source: 'provider', profile, calibration: 'vendor-claimed', confidence, distribution, calibrationRef: null };
}

function normalizeUsage(value: unknown): DecisionUsage {
  const usage = asRecord(value);
  return {
    inputTokens: integerOrNull(usage.input_tokens),
    outputTokens: integerOrNull(usage.output_tokens),
    costUsd: null,
  };
}

function emptyUsage(): DecisionUsage {
  return { inputTokens: null, outputTokens: null, costUsd: null };
}

function integerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function numericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (Object.values(record).some(entry => typeof entry !== 'number')) throw new DecisionValidationError('probability map must be numeric');
  return record as Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionValidationError('expected object');
  return value as Record<string, unknown>;
}

function requireCredentialRef(request: DecisionAdapterRequest): string {
  if (!request.target.credentialRef) throw new DecisionValidationError('Jev target requires credentialRef');
  return request.target.credentialRef;
}

function mapStatus(status: number): DecisionFailureReason {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 404 || status === 422) return 'invalid-request';
  if (status === 429) return 'rate-limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'service-error';
  return 'invalid-request';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
