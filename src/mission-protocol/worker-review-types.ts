// Optional delegation constraints and verifier-owned review history for Mission v1.
import type { WorkerArtifact } from './types.js';

export interface WorkerRegressionCheck {
  kind: 'command' | 'path';
  target: string;
  expectedStatus: 'passed' | 'failed' | 'present' | 'absent';
}
export interface WorkerOracleCommand {
  command: string;
  expectedExitCode: number;
}
export interface WorkerOracleResult {
  command: string;
  exitCode: number | null;
  evidence: WorkerArtifact;
}
export interface WorkerDelegationContract {
  /** Omission/default follows conductor policy; stop-and-report pauses uncertain work. */
  uncertaintyPolicy?: 'default' | 'stop-and-report';
  mustNotRegress?: WorkerRegressionCheck[];
  verificationOracle?: WorkerOracleCommand[];
  designReviewRequired?: boolean;
  /** Retain the reviewed design before dispatching a non-trivial implementation. */
  designReviewArtifact?: WorkerArtifact;
}
export interface WorkerReviewRound {
  round: number;
  headSha: string;
  reviewerObservationRef: string;
  artifact: WorkerArtifact;
}
export interface WorkerFinding {
  id: string;
  class: 'A' | 'B' | 'C';
  severity: 'blocker' | 'major' | 'minor' | 'info';
  /** First review round that discovered this finding; retained when resolved. */
  round: number;
  status: 'open' | 'resolved' | 'follow-up' | 'out-of-scope';
  summary: string;
  followUp?: WorkerArtifact;
}
export interface WorkerReviewEvidence {
  headSha?: string;
  reviewRounds?: WorkerReviewRound[];
  findingsLedger?: WorkerFinding[];
  /** Computed by trusted result assembly on acceptance, including clean rounds. */
  roundsToClean?: number;
  oracleResults?: WorkerOracleResult[];
}
