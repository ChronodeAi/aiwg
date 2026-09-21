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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

interface JevAdapterOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  /** Explicitly approved public HTTPS origins for non-default deployments. */
  allowedOrigins?: readonly string[];
  /** DNS check for custom origins; production defaults to the system resolver. */
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  now?: () => number;
}

const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_PARSE_MS = 50;

/** Safe resolver taxonomy; messages are intentionally discarded at this boundary. */
export class JevCredentialError extends Error {
  constructor(readonly category: 'missing' | 'denied' | 'configuration' | 'failed') {
    super('Jev credential resolution failed');
    this.name = 'JevCredentialError';
  }
}

export class JevDecisionAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version = '1.0.0';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowedOrigins: readonly string[];
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  private readonly now: () => number;

  constructor(options: JevAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.resolveAddresses = options.resolveAddresses ?? systemResolveAddresses;
    this.now = options.now ?? Date.now;
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
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    if (this.now() >= request.deadlineEpochMs) return failure('timeout', { termination: 'target-timeout', dispatchCertainty: 'not-sent' });
    try { await authorizeEndpoint(this.endpoint, this.allowedOrigins, this.resolveAddresses); }
    catch { return failure('data-boundary-denied', { dispatchCertainty: 'not-sent' }); }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    let token: string;
    try {
      if (!request.target.credentialRef) return failure('unauthorized', { dispatchCertainty: 'not-sent' });
      const credential = new Uint8Array(await request.resolveCredential(request.target.credentialRef));
      try { token = new TextDecoder('utf-8', { fatal: true }).decode(credential); }
      finally { credential.fill(0); }
      if (!token || /[\r\n\u0000-\u001f\u007f]/.test(token)) return failure('authentication', { dispatchCertainty: 'not-sent' });
    } catch (error) {
      const category = error instanceof JevCredentialError ? error.category : null;
      const reason = category === 'missing' ? 'authentication'
        : category === 'denied' || category === 'configuration' || error instanceof DecisionValidationError ? 'unauthorized'
          : 'executor-unavailable';
      return failure(reason, { dispatchCertainty: 'not-sent' });
    }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    const timeoutMs = Math.max(1, request.deadlineEpochMs - this.now());
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    let body: string;
    try {
      body = JSON.stringify({ state: request.input, model: request.target.model,
        questions: { [request.alias]: toJevQuestion(request) } });
    } catch { return failure('invalid-request', { dispatchCertainty: 'not-sent' }); }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal,
        redirect: 'error',
      });
    } catch (error) {
      return request.signal.aborted ? externalInterruption(request, 'unknown')
        : deadline.aborted ? failure('timeout', { termination: 'target-timeout', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : error instanceof Error && error.name === 'AbortError'
            ? failure('cancelled', { termination: 'backend-cancelled', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : failure('network-transient', { remoteExecution: 'unknown', dispatchCertainty: 'unknown' });
    }
    const correlation = requestId(response.headers);
    let metadata: Partial<AdapterObservation> = { ...correlation, httpStatus: response.status, dispatchCertainty: 'terminal-response' };
    if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
    if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
    if (!headersWithinLimit(response.headers)) {
      await response.body?.cancel().catch(() => undefined);
      return failure('invalid-output', metadata);
    }
    let finalOrigin: string | null = null;
    try { if (response.url) finalOrigin = new URL(response.url).origin; }
    catch { finalOrigin = 'invalid'; }
    if (finalOrigin && finalOrigin !== new URL(this.endpoint).origin) {
      await response.body?.cancel().catch(() => undefined);
      return failure('data-boundary-denied', metadata);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return failure('data-boundary-denied', metadata);
    }
    if (!response.ok) {
      try {
        const errorBody = await readBoundedBody(response, signal);
        if (!metadata.requestId && response.headers.get('content-type')?.includes('json')) {
          const parseStarted = performance.now();
          let parsedError: unknown;
          try { parsedError = JSON.parse(errorBody); }
          catch { parsedError = null; }
          if (performance.now() - parseStarted > MAX_PARSE_MS) throw new Error('response parse exceeded limit');
          if (parsedError && typeof parsedError === 'object' && !Array.isArray(parsedError)) {
            const field = (parsedError as Record<string, unknown>).request_id ?? (parsedError as Record<string, unknown>).requestId;
            const safe = safeRequestId(field);
            if (safe) metadata = { ...metadata, requestId: safe, requestIdSource: 'body' as const };
          }
        }
      } catch {
        if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
        if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
        return failure('invalid-output', metadata);
      }
      const retryAfterMs = parseRetryAfter(response.headers, this.now());
      return failure(mapStatus(response.status), { ...metadata, ...(retryAfterMs === null ? {} : { retryAfterMs }) });
    }

    let parsed: unknown;
    try {
      const encoded = await readBoundedBody(response, signal);
      const parseStarted = performance.now();
      parsed = JSON.parse(encoded);
      if (performance.now() - parseStarted > MAX_PARSE_MS) throw new Error('response parse exceeded limit');
      if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
      if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
      const normalized = normalizeResponse(request, parsed);
      return { ...normalized, ...metadata };
    } catch {
      return request.signal.aborted ? externalInterruption(request, 'terminal-response', metadata)
        : deadline.aborted ? failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' })
          : failure('invalid-output', metadata);
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

function failure(reason: DecisionFailureReason, extra: Partial<AdapterObservation> = {}): AdapterObservation {
  const status = reason === 'unsupported-capability' ? 'unsupported' : reason === 'cancelled' ? 'cancelled' : 'error';
  return { status, reason, uncertainty: null, actualModel: null, usage: emptyUsage(), requestId: null, ...extra };
}

function externalInterruption(request: DecisionAdapterRequest, certainty: NonNullable<AdapterObservation['dispatchCertainty']>,
  metadata: Partial<AdapterObservation> = {}): AdapterObservation {
  const caller = request.callerSignal ? request.callerSignal.aborted : request.signal.aborted;
  const termination = caller ? 'caller-cancelled' : request.totalSignal?.aborted ? 'total-deadline' : 'target-timeout';
  return failure(caller ? 'cancelled' : 'timeout', {
    ...metadata,
    termination,
    dispatchCertainty: certainty,
    ...(certainty === 'not-sent' ? {} : { remoteExecution: 'unknown' as const }),
  });
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

function mapStatus(status: number): DecisionFailureReason {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 404 || status === 422) return 'invalid-request';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'service-error';
  return 'invalid-request';
}

function parseRetryAfter(headers: Headers, now: number): number | null {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && /^\d+(?:\.\d+)?$/.test(milliseconds.trim())) {
    const value = Number(milliseconds);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  const value = headers.get('retry-after');
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(Math.ceil(seconds * 1000)) ? Math.ceil(seconds * 1000) : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : null;
}

function requestId(headers: Headers): Pick<AdapterObservation, 'requestId' | 'requestIdSource'> {
  for (const [name, source] of [['x-typesafe-request-id', 'typesafe'], ['x-request-id', 'legacy']] as const) {
    const value = safeRequestId(headers.get(name));
    if (value) {
      return { requestId: value, requestIdSource: source };
    }
  }
  return { requestId: null };
}

function safeRequestId(value: unknown): string | null {
  // A comma indicates merged duplicate headers; decline ambiguous correlation values.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH
    && /^[\x21-\x7e]+$/.test(value) && !value.includes(',') ? value : null;
}

function headersWithinLimit(headers: Headers): boolean {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += name.length + value.length;
    if (bytes > MAX_HEADER_BYTES) return false;
  }
  return true;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) throw new Error('response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else {
      onAbort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('response too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function systemResolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true })).map(address => address.address);
}

async function authorizeEndpoint(endpoint: string, allowedOrigins: readonly string[], resolveAddresses: (hostname: string) => Promise<readonly string[]>): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw new Error('unsafe endpoint');
  const approved = new Set([new URL(JEV_ENDPOINT).origin, ...allowedOrigins.map(origin => new URL(origin).origin)]);
  if (!approved.has(url.origin)) throw new Error('unapproved endpoint');
  if (url.origin !== new URL(JEV_ENDPOINT).origin) {
    if (isIP(url.hostname)) throw new Error('literal endpoint address');
    const addresses = await resolveAddresses(url.hostname);
    if (!addresses.length || addresses.some(address => !publicIpv4(address))) throw new Error('private endpoint address');
  }
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false; // fail closed on IPv6 until its full range policy is implemented
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31
    || a === 192 && (b === 168 || b === 0)
    || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113) return false;
  return true;
}
