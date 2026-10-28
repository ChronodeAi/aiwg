// Condensed wrapper output remains an existing worker claim and verifier review record.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { decodeWorkerPayload } from '../../../src/mission-protocol/index.js';
import { prepareWorkerAcceptance } from '../../../src/mission-protocol/worker-review-gate.js';
import type { WorkerClaims } from '../../../src/mission-protocol/types.js';
import { workerReviewFixture, reviewArtifact } from '../../fixtures/worker-review.js';

const source = (name: string) => readFileSync(`agentic/code/addons/aiwg-utils/agents/${name}.md`, 'utf8');

describe('condensed wrapper contract', () => {
  it.each(MODEL_WRAPPER_DEFINITIONS)('$name carries criterion/evidence/verdict, budget and explicit stops', wrapper => {
    const text = source(wrapper.name);
    for (const token of ['WorkerClaims', 'WorkerDelegationContract', 'subagent-brief.md', 'claims[].id',
      'claims[].text', 'file:line or URL', 'pass / fail / blocked', 'confidence', 'limitations',
      'delegation.return_budget_tokens', '1000-token', 'Stop rules', 'stop-and-report', 'Never spawn agents']) {
      expect(text).toContain(token);
    }
    const metadata = load(text.split('---')[1]) as Record<string, unknown>;
    expect(metadata['model-tier']).toBe(wrapper.tier);
    expect(metadata['model-role']).toBe(wrapper.role);
    if (wrapper.readOnly) {
      expect(metadata.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
      expect(text).toContain('not a read-only shell capability by itself');
    }
  });

  it('represents a condensed criterion verdict without new worker fields', () => {
    const claims: WorkerClaims = { version: 1, status: 'completed', summary: 'One criterion checked',
      claims: [{ id: 'AC-1', text: 'Criterion: return contract. Verdict: pass. Confidence: high.',
        evidence: [{ ...reviewArtifact, ref: 'file:src/models/wrapper-definitions.ts:1' }] }],
      artifacts: [], checks: [], limitations: ['No open questions'] };
    expect(decodeWorkerPayload('workerClaims', claims)).toEqual(claims);
    expect(() => decodeWorkerPayload('workerClaims', { ...claims, verdict: 'pass' })).toThrow();
  });

  it.each([0, 1, null])('uses existing oracle results and refuses false acceptance for exit %s', exitCode => {
    const value = workerReviewFixture();
    value.brief.verificationOracle = [{ command: 'fixture-check', expectedExitCode: 0 }];
    value.verification.oracleResults = [{ command: 'fixture-check', exitCode, evidence: reviewArtifact }];
    const verify = () => prepareWorkerAcceptance(value.brief, value.execution, value.verification,
      { headSha: value.headSha, reviewLineage: value.reviewLineage });
    if (exitCode === 0) expect(verify().oracleResults?.[0].exitCode).toBe(0);
    else expect(verify).toThrow(/exact verificationOracle/);
  });

  it('verifier runs the supplied oracle and defers trusted acceptance', () => {
    const verifier = source('aiwg-model-verifier');
    for (const token of ['verificationOracle', 'expectedExitCode', 'mustNotRegress', 'WorkerReviewEvidence.oracleResults',
      'WorkerOracleResult', 'prepareWorkerAcceptance', 'head/lineage', 'return blocked']) expect(verifier).toContain(token);
  });
});
