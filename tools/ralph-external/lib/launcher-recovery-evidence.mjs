/** Recovery evidence observed outside worker output by the launch owner. */
const observations = new WeakMap();
const HOST_ERRORS = new Set(['ENOMEM', 'ENOSPC', 'EAGAIN', 'EMFILE', 'ENFILE']);
const HOST_RESULTS = new Set(['oom-kill', 'resources']);

export function launcherRecoveryEvidence(result) {
  return observations.get(result) ?? null;
}

/**
 * A failed task's transcript cannot attest an upstream outage. Independently
 * check only an endpoint already authorized by installation qualification.
 * HEAD sends no task, credentials or response body and never follows redirects.
 * beforeRequest owns allowance accounting; refusal means no request is sent.
 */
export async function observeLauncherRecoveryOutcome({ invocation, result, installation, breaker,
  beforeRequest, fetchImpl = globalThis.fetch, wallNowMs = Date.now, timeoutMs = 10_000 } = {}) {
  if (!result || result.attemptOutcome !== 'failed' || result.cancelled) return;
  const backend = invocation?.selected?.inferenceProvider;
  if (HOST_ERRORS.has(result.errorCode) || HOST_RESULTS.has(result.nativeResult)) {
    const corroboratedBackends = breaker?.observeHostFailure({ invocationId: result.invocationId,
      inferenceProvider: backend, reasonCode: 'RESOURCE' }) ?? [];
    if (corroboratedBackends.length >= 2) observations.set(result, {
      reasonCode: 'RESOURCE', evidenceSource: 'launcher', hostId: 'local', corroboratedBackends,
    });
    return;
  }
  const endpoint = installation?.endpoints?.[0];
  if (typeof endpoint !== 'string' || typeof beforeRequest !== 'function' || typeof fetchImpl !== 'function') return;
  let url;
  try { url = new URL(endpoint); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return;
  const remaining = () => typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  if (!Number.isFinite(remaining()) || remaining() <= 0) return;
  try {
    if (!await beforeRequest()) return;
    const requestTimeoutMs = remaining();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) return;
    const response = await fetchImpl(endpoint, { method: 'HEAD', redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, Math.floor(requestTimeoutMs)))) });
    try {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter != null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
        const retryDate = seconds === null && retryAfter ? Date.parse(retryAfter) : NaN;
        // Reset headers are epoch seconds; convert to a duration so the breaker
        // can use its own monotonic clock rather than comparing clock domains.
        const resetHeader = response.headers.get('x-ratelimit-reset');
        const resetEpoch = resetHeader != null && /^\d+(?:\.\d+)?$/.test(resetHeader.trim()) ? Number(resetHeader) * 1000 : NaN;
        const resetDelay = response.headers.get('ratelimit-reset');
        const delays = [seconds, Number.isFinite(retryDate) ? (retryDate - wallNowMs()) / 1000 : null,
          Number.isFinite(resetEpoch) ? (resetEpoch - wallNowMs()) / 1000 : null,
          resetDelay != null && /^\d+(?:\.\d+)?$/.test(resetDelay.trim()) ? Number(resetDelay) : null]
          .filter(value => Number.isFinite(value) && value >= 0);
        observations.set(result, { reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
          retryAfterSeconds: delays.length ? Math.max(...delays) : null });
      } else if (response.status >= 500 && response.status <= 599) {
        observations.set(result, { reasonCode: 'NETWORK', evidenceSource: 'launcher' });
      }
    } finally { await response.body?.cancel(); }
  } catch { /* A failed diagnostic is not evidence of a provider-wide outage. */ }
}
