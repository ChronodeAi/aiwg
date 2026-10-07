// Synthetic shared wire data, not a provider profile or live qualification.
import { readFileSync } from 'node:fs';

export const fixtureRevision = 1;
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
