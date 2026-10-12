// Desktop panel (#2547): manages a guest desktop session through the Bridge
// control API. Effective capabilities are the backend `policy`; there is no
// renderer, observer simulation, or terminal replay in this build.
import { useDesktopSession, STATUS_TEXT, requestedMode, type DesktopStatus } from '../useDesktopSession';
import type { DesktopPolicy } from '../../../bridge/src/desktop-contract.mjs';
import { fmtId } from '../util';

const NO_TRANSPORT = 'Display transport is not available in this build';
const STATUS_LABEL: Record<DesktopStatus, string> = {
  loading: 'loading', not_ready: 'not ready', unavailable: 'unavailable', idle: 'ready', live: 'live',
  reconnecting: 'reconnecting', disconnected: 'disconnected', expired: 'expired', denied: 'denied',
  'guest-ended': 'guest ended', failed: 'failed', stale: 'stale', handoff_waiting: 'handoff waiting', closing: 'closing',
};

const POLICY_ROWS: Array<[keyof DesktopPolicy, string]> = [
  ['observe', 'Observe'], ['control', 'Control'], ['sharing', 'Sharing'], ['clipboard_copy', 'Clipboard copy'],
  ['clipboard_paste', 'Clipboard paste'], ['file_transfer', 'File transfer'], ['audio', 'Audio'], ['recording', 'Recording'],
  ['isolation_tier', 'Isolation tier'], ['generation', 'Policy generation'],
];

function policyValue(value: DesktopPolicy[keyof DesktopPolicy]): string {
  if (typeof value === 'boolean') return value ? 'granted' : 'not granted';
  return String(value);
}

export function Desktop({ instanceId, onBack, pollMs, backoffMs }: { instanceId: string; onBack: () => void; pollMs?: number; backoffMs?: number }) {
  const { state, connect, disconnect, reconnect, close, retry } = useDesktopSession(instanceId, pollMs, backoffMs);
  const { status, reason, capability, session, cleanup } = state;
  const policy = session?.policy ?? capability?.policy ?? null;
  const mode = requestedMode(capability);
  const hasSession = session !== null;
  const sessionOpen = hasSession && !['guest-ended', 'expired', 'stale', 'denied', 'failed'].includes(status) && session?.state !== 'closed';

  return (
    <section className="card desktop-panel" aria-label={`Desktop for ${fmtId(instanceId)}`}>
      <div className="section-toolbar">
        <div>
          <h2>Desktop <code title={instanceId}>{fmtId(instanceId)}</code></h2>
          <p className="hint">Guest desktop session managed through the Bridge control API. {NO_TRANSPORT}.</p>
        </div>
        <button onClick={onBack} aria-label="Back to inventory">Back</button>
      </div>

      <p role="status" className="desktop-status">
        <span className={`badge desktop-${status}`}>{STATUS_LABEL[status]}</span>{' '}
        {STATUS_TEXT[status]}{reason ? ` ${reason}` : ''}
      </p>

      {session && (
        <dl className="desktop-session">
          <dt>Session</dt><dd><code title={session.id}>{fmtId(session.id)}</code></dd>
          <dt>Guest state</dt><dd>{session.state}</dd>
          <dt>Cleanup</dt><dd className={`desktop-cleanup-${cleanup ?? 'none'}`}>{cleanup ?? 'none'}</dd>
          <dt>VM incarnation</dt><dd><code>{session.incarnation}</code></dd>
          <dt>Expires</dt><dd>{new Date(session.absolute_expires_at).toLocaleString()}</dd>
          {session.retained_until && <><dt>Retained until</dt><dd>{new Date(session.retained_until).toLocaleString()}</dd></>}
        </dl>
      )}

      {policy && (
        <div className="desktop-policy">
          <h3>Effective capabilities (from backend)</h3>
          <ul>
            {POLICY_ROWS.map(([key, label]) => (
              <li key={key}><span className="muted">{label}:</span> {policyValue(policy[key])}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="controls desktop-actions">
        {status === 'not_ready' && <button onClick={() => { void retry(); }}>Retry</button>}
        {status === 'idle' && (
          <button
            className="cta"
            disabled={!mode}
            title={mode ? undefined : 'Backend grants neither observe nor control for this instance'}
            onClick={() => { void connect(); }}
          >
            Connect
          </button>
        )}
        {policy?.observe && (
          <button disabled title={NO_TRANSPORT} aria-label="Observe (unavailable)">Observe</button>
        )}
        {policy?.control && (
          <button disabled title={NO_TRANSPORT} aria-label="Take control (unavailable)">Take Control</button>
        )}
        {sessionOpen && (status === 'live' || status === 'reconnecting' || status === 'handoff_waiting' || status === 'loading') && (
          <button onClick={disconnect} title="Stop following this session; the guest desktop keeps running.">Disconnect</button>
        )}
        {sessionOpen && status === 'disconnected' && (
          <button onClick={reconnect}>Reconnect</button>
        )}
        {sessionOpen && status !== 'closing' && (
          <>
            <button onClick={() => { void close('revoke_access'); }} title="Remove your access to this desktop; the guest session is retained.">Revoke access</button>
            <button
              onClick={() => { if (window.confirm('Sign the guest out? This ends the guest desktop session and its unsaved work.')) void close('sign_out'); }}
              title="End the guest session; distinct from disconnecting or revoking access."
            >
              Sign out guest
            </button>
          </>
        )}
        {status === 'stale' && <button onClick={() => { void retry(); }}>Refresh</button>}
      </div>
    </section>
  );
}
