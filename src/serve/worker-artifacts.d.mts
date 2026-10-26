/** Pure validation shared by the typed renderer and installed execution owner. */
import type { WorkerResolvedInvocation } from '../mission-protocol/types.js';
export function validateWorkerArtifacts(invocation: Pick<WorkerResolvedInvocation,
  'artifacts' | 'invocationId' | 'cwd' | 'briefPath' | 'stdoutPath' | 'stderrPath' | 'finalPath'>): NonNullable<WorkerResolvedInvocation['artifacts']>;
