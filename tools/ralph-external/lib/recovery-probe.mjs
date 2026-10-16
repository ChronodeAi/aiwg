/** A recovery probe is a conductor-owned request, never an uncontained worker. */
export async function runRecoveryProbe({ driver, invocation, timeoutMs = 10_000, maxOutputBytes = 65_536,
  onDispatch, fetchImpl = globalThis.fetch, wallNowMs = Date.now }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 65_536) {
    throw new RangeError('Recovery probe exceeds the 10s/64KiB bounds');
  }
  const failed = (reason, extra = {}) => ({ success: false, relevant: false, termination: 'confirmed', reason, ...extra });
  // These endpoints already passed the installation authority's allowlist and
  // are bound into its qualification digest. Never derive a URL from worker
  // output, task argv, a prompt, or ambient provider configuration.
  const endpoint = driver?.qualification?.installation?.endpoints?.[0];
  if (!['shell', 'mcp'].includes(invocation?.transport) || typeof endpoint !== 'string' || typeof fetchImpl !== 'function') {
    return failed('probe-profile-unavailable', { operatorIntervention: true });
  }
  let url;
  try { url = new URL(endpoint); } catch { return failed('probe-endpoint-unavailable', { operatorIntervention: true }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    return failed('probe-endpoint-unavailable', { operatorIntervention: true });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(timeoutMs)));
  let aborted;
  const timeout = new Promise((_, reject) => {
    aborted = () => reject(new Error('probe-timeout'));
    controller.signal.addEventListener('abort', aborted, { once: true });
  });
  // The rejection can precede a slow allowance debit; attach a handler now
  // while still awaiting that debit's definitive outcome before returning.
  timeout.catch(() => {});
  try {
    await onDispatch?.();
    if (controller.signal.aborted) return failed('probe-timeout');
    try {
      // HEAD has no task, credentials, inference body or worker filesystem.
      // A successful endpoint check permits only one subsequent task canary.
      const response = await Promise.race([fetchImpl(endpoint, { method: 'HEAD', redirect: 'error', signal: controller.signal }), timeout]);
      let headerBytes = 16 + Buffer.byteLength(response.statusText ?? '');
      for (const [name, value] of response.headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      try {
        if (headerBytes > maxOutputBytes) return failed('probe-output-limit');
        if (response.body) return failed('probe-body-unexpected');
        const success = response.status >= 200 && response.status <= 299;
        if (success) return { success: true, relevant: true, termination: 'confirmed', reason: 'probe-succeeded' };
        if (response.status === 429) {
          const after = response.headers.get('retry-after');
          const seconds = after != null && /^\d+(?:\.\d+)?$/.test(after.trim()) ? Number(after) : null;
          const date = seconds === null && after ? Date.parse(after) : NaN;
          const reset = response.headers.get('x-ratelimit-reset');
          const resetEpoch = reset != null && /^\d+(?:\.\d+)?$/.test(reset.trim()) ? Number(reset) * 1000 : NaN;
          const resetDelay = response.headers.get('ratelimit-reset');
          const delays = [seconds, Number.isFinite(date) ? (date - wallNowMs()) / 1000 : null,
            Number.isFinite(resetEpoch) ? (resetEpoch - wallNowMs()) / 1000 : null,
            resetDelay != null && /^\d+(?:\.\d+)?$/.test(resetDelay.trim()) ? Number(resetDelay) : null]
            .filter(value => Number.isFinite(value) && value >= 0);
          return failed('probe-rate-limited', { retryAfterSeconds: delays.length ? Math.max(...delays) : null });
        }
        return failed('probe-failed', { status: response.status });
      } finally {
        // HEAD exposes no response body on the native transport. Cancel an
        // unexpected body without reading it, under the same absolute bound.
        if (response.body) await Promise.race([response.body.cancel(), timeout]);
      }
    } catch {
      return failed(controller.signal.aborted ? 'probe-timeout' : 'probe-unavailable');
    }
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}
