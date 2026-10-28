// Synthetic Mission review data; no installed CLI or external service is contacted.
import { createHash } from 'node:crypto';
import type { WorkerModelObservation } from '../../src/models/types.js';
import { fixtureJson, materialize } from '../conformance/mission-v1/worker-contract-fixtures.js';

const vectors = fixtureJson('mission-vectors.json');
const fixture = (id: string) => materialize(vectors.find((vector: any) => vector.id === id), vectors);
export const reviewArtifact = { ref: 'fixture:review', digest: `sha256:${'a'.repeat(64)}` };
export const reviewHead = 'a'.repeat(40);
export const reviewFinding = (classification = 'A', severity = 'major', status = 'open', round = 1) => ({
  id: 'finding-1', class: classification, severity, status, round, summary: 'Synthetic finding',
});
export function workerReviewFixture(direct = true) {
  const brief = fixture(direct ? 'direct-brief-no-lease' : 'brief-admitted');
  brief.intent.taskClass = 'implementation';
  brief.intent.verification.independentReview = 'required';
  brief.intent.verification.differentFamily = 'require';
  const result = fixture(direct ? 'direct-accepted-no-receipt' : 'managed-accepted');
  const artifactBytes = Buffer.from('Synthetic exact head tree manifest');
  const writer: WorkerModelObservation = structuredClone(fixtureJson('shared-vectors.json').find((vector: any) => vector.id === 'observation-no-effort').value);
  Object.assign(writer, { cliId: brief.selected.cli, family: brief.selected.family, recordId: 'fixture:writer' });
  const reviewer = { ...structuredClone(writer), recordId: 'fixture:reviewer', family: 'other-family' };
  return { brief, execution: result.execution, worker: result.worker,
    verification: { ...result.verification, artifactDigest: `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`,
      reviewRounds: [{ round: 1, headSha: reviewHead, reviewerObservationRef: reviewer.recordId, artifact: reviewArtifact }], findingsLedger: [] },
    artifactBytes, headSha: reviewHead, reviewLineage: { writer, reviewers: [reviewer] } };
}
