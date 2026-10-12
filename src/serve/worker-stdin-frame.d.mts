/** Conductor-side stdin framing shared by the shell renderer and the one-shot launcher. */
export const WORKER_STDIN_FRAME_MAX_BRIEF_BYTES: number;
export const WORKER_STDIN_FRAME_MAX_BYTES: number;
export function recordedWorkerStdinBytes(input: {
  filename: string; workspace: string; cli: string; adapterId: string; scopeDigest: string; briefDigest: string;
  storePath: string; storeDigest: string; policy?: import('../models/types.js').WorkerSelectionPolicy;
}): Promise<Buffer | null>;
export function workerStdinDocument(input: { brief: string | Buffer; model: string; cwd: string }): string;
export function workerStdinBytes(invocation: { stdin: 'closed' | 'brief-text' | 'brief-json' | 'adapter-frame'; cwd?: string;
  selected?: { model?: string } }, brief: string | Buffer, adapter?: { buildWorkerStdinFrame?(brief: string | Buffer): string | Uint8Array }): Buffer | null;
