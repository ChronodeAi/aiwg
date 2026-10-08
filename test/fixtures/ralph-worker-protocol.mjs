// Synthetic shared wire data, not a provider profile or live qualification.
import { readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';

export const fixtureRevision = 2;
export const scenarios = ['success', 'exit-zero-error', 'hang', 'missing-final', 'double-final', 'truncated-final'];
export const workerInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['invocationId', 'workspace', 'selection', 'brief'],
  properties: {
    invocationId: { type: 'string', minLength: 1 },
    workspace: { type: 'string', minLength: 1 },
    selection: {
      type: 'object', additionalProperties: false, required: ['provider', 'model', 'effort'],
      properties: {
        provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 },
        effort: { type: ['string', 'null'] },
      },
    },
    brief: { type: 'string' },
  },
};

export function config() {
  if (!process.env.AIWG_FAKE_WORKER_CONFIG) throw new Error('AIWG_FAKE_WORKER_CONFIG must name a synthetic fixture config');
  return JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8'));
}

export function claims(worker) {
  return {
    version: 1, status: 'completed', summary: worker ? JSON.stringify(worker) : 'Synthetic fixture only',
    claims: [], artifacts: [], checks: [], limitations: [],
  };
}

// Writes exercise Node's permission runner. Endpoint decisions are mapping-only.
// Separately attempt a real connection to a closed/blocked loopback endpoint;
// record socket events, never infer network enforcement from the allowlist.
export async function permissionChecks(settings) {
  const writes = settings.writes.map(target => {
    try { writeFileSync(target, 'synthetic effect'); return 'allowed'; }
    catch (error) { return error.code === 'ERR_ACCESS_DENIED' ? 'denied' : 'unexpected-error'; }
  });
  const endpointDecisions = settings.endpoints.map(endpoint => settings.allowedEndpoints.includes(endpoint) ? 'allowed' : 'denied');
  const socketAttempts = [];
  let connectionsEstablished = 0;
  const socket = new Socket();
  await new Promise(resolve => {
    const attempt = { endpoint: 'tcp://127.0.0.1:1', outcome: 'pending' };
    const finish = outcome => {
      attempt.outcome = outcome;
      socket.destroy();
      resolve();
    };
    socket.once('connect', () => { connectionsEstablished += 1; finish('connected'); });
    socket.once('error', error => finish(error.code ?? 'unexpected-error'));
    socket.setTimeout(250, () => finish('timeout'));
    socketAttempts.push(attempt);
    try { socket.connect({ host: '127.0.0.1', port: 1 }); }
    catch (error) { finish(error.code ?? 'unexpected-error'); }
  });
  return { writes, endpointDecisions, socketAttempts, connectionsEstablished };
}
