/**
 * Discovers registered analysis outputs (#2003's `output-registration`
 * primitive) associated with a selected set of sessions (#2566). This is a
 * discovery/selection layer on top of the existing registration index --
 * not a second registration store, per the issue's own framing.
 *
 * Lineage strength is reported explicitly: `registered` means a
 * `kind: 'session'` source in the output's own recorded context pack
 * matched the session by an exact, known reference convention (never
 * inferred from a filename or path). `manual` is reserved for a future
 * operator-asserted inclusion path and is not produced by discovery.
 */
import type { DerivedOutputRegistration, OutputSourceReferenceSchema } from './output-registration.js';
import type { Session } from './contracts.js';
import { sessionRecordLocator } from './fortemi-export-mapping.js';
import type { z } from 'zod';

export type OutputSourceReference = z.infer<typeof OutputSourceReferenceSchema>;

export interface SessionOutputCandidate {
  registration: DerivedOutputRegistration;
  sessionId: string;
  lineage: 'registered';
  matchReason: string;
}

/** Known, exact conventions a `kind: 'session'` source ref may use to name a session. Order is the preference used to report `matchReason`. */
function sessionRefCandidates(session: Pick<Session, 'sessionId' | 'nativeSessionId' | 'provider'>): Array<{ ref: string; reason: string }> {
  return [
    { ref: session.sessionId, reason: 'ref equals the stable session id' },
    { ref: `session:${session.sessionId}`, reason: "ref equals 'session:<stable session id>'" },
    { ref: sessionRecordLocator(session), reason: 'ref equals the aiwg-session:// export locator' },
    { ref: session.nativeSessionId, reason: 'ref equals the native session id' },
    { ref: `session:${session.nativeSessionId}`, reason: "ref equals 'session:<native session id>'" },
  ];
}

function matchSource(
  source: OutputSourceReference,
  session: Pick<Session, 'sessionId' | 'nativeSessionId' | 'provider'>,
): string | null {
  if (source.kind !== 'session') return null;
  for (const candidate of sessionRefCandidates(session)) {
    if (source.ref === candidate.ref) return candidate.reason;
  }
  return null;
}

/**
 * Registrations are scanned once and matched against every selected session
 * -- bounded by the selection, not an unbounded corpus walk, satisfying
 * "bound any file discovery to an explicit workspace/source scope."
 */
export function discoverSessionOutputCandidates(
  registrations: readonly DerivedOutputRegistration[],
  sessions: readonly Pick<Session, 'sessionId' | 'nativeSessionId' | 'provider'>[],
): SessionOutputCandidate[] {
  const candidates: SessionOutputCandidate[] = [];
  for (const registration of registrations) {
    for (const session of sessions) {
      for (const source of registration.contextPack.sources) {
        const reason = matchSource(source, session);
        if (reason) {
          candidates.push({
            registration, sessionId: session.sessionId, lineage: 'registered', matchReason: reason,
          });
          break;
        }
      }
    }
  }
  return candidates;
}
