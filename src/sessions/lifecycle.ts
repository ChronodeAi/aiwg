import type { Session } from './contracts.js';

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function effectiveSessionLifecycle(session: Session): Session {
  if (session.lifecycle !== 'active' && session.lifecycle !== 'inactive') return session;
  const nativeKey = `native.${session.provider}`;
  const native = objectRecord(session.extensions[nativeKey]);
  const evidence = objectRecord(native.lifecycleEvidence);
  if (evidence.basis !== 'open-provisional-source'
    && evidence.basis !== 'inactivity-threshold') return session;
  const observedAt = session.updatedAt ?? evidence.observedAt;
  const timestamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(timestamp)) return session;
  const thresholdMs = typeof evidence.thresholdMs === 'number'
    && Number.isFinite(evidence.thresholdMs)
    && evidence.thresholdMs >= 0
    ? evidence.thresholdMs : DEFAULT_INACTIVITY_THRESHOLD_MS;
  const inactive = Date.now() - timestamp > thresholdMs;
  const lifecycle = inactive ? 'inactive' : 'active';
  return {
    ...session,
    lifecycle,
    extensions: {
      ...session.extensions,
      [nativeKey]: {
        ...native,
        lifecycleEvidence: {
          ...evidence,
          basis: inactive ? 'inactivity-threshold' : 'open-provisional-source',
          state: lifecycle,
          observedAt,
          confidence: inactive ? 'medium' : 'provisional',
          thresholdMs,
        },
      },
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
