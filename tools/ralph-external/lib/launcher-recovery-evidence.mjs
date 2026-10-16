import { runRecoveryProbe } from './recovery-probe.mjs';

/** Recovery evidence observed outside worker output by the launch owner. */
const observations = new WeakMap();
const failureHints = new WeakMap();

export function recordLauncherRecoveryHint(result, reasonCode) {
  failureHints.set(result, reasonCode);
}
const HOST_ERRORS = new Set(['ENOMEM', 'ENOSPC', 'EAGAIN', 'EMFILE', 'ENFILE']);
const HOST_RESULTS = new Set(['oom-kill', 'resources']);

export function launcherRecoveryEvidence(result) {
  return observations.get(result) ?? null;
}

/**
 * A failed task's transcript cannot attest an upstream outage. Independently
 * check only an endpoint already authorized by installation qualification.
 * HEAD sends no task, credentials or response body and never follows redirects.
 * Only upstream failure hints warrant this check; hints never attest an outage.
 * beforeRequest checks the remaining task deadline; refusal sends no request.
 */
export async function observeLauncherRecoveryOutcome({ invocation, result, installation, breaker,
  failureHint = '', beforeRequest, fetchImpl = globalThis.fetch, wallNowMs = Date.now, timeoutMs = 10_000 } = {}) {
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
  if (!['RATE_LIMIT', 'NETWORK'].includes(failureHints.get(result) ?? result.health?.reasonCode)
    && !/\b429\b|rate.limit|quota.exceeded|\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|50[234])\b/i.test(String(failureHint).slice(0, 8192))) return;
  const endpoint = installation?.endpoints?.[0];
  if (typeof endpoint !== 'string' || typeof beforeRequest !== 'function' || typeof fetchImpl !== 'function') return;
  const remaining = () => typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  if (!Number.isFinite(remaining()) || remaining() <= 0) return;
  try {
    if (!await beforeRequest()) return;
    const requestTimeoutMs = remaining();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) return;
    const observed = await runRecoveryProbe({ driver: { qualification: { installation } }, invocation: invocation ?? { transport: 'shell' },
      timeoutMs: Math.min(10_000, requestTimeoutMs), maxOutputBytes: 65_536, fetchImpl, wallNowMs });
    if (observed.reason === 'probe-rate-limited') {
      observations.set(result, { reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
        retryAfterSeconds: observed.retryAfterSeconds });
    } else if (observed.status >= 500 && observed.status <= 599) {
      observations.set(result, { reasonCode: 'NETWORK', evidenceSource: 'launcher' });
    }
  } catch { /* A failed diagnostic is not evidence of a provider-wide outage. */ }
}
