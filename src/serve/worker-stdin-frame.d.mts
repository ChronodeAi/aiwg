/** Conductor-side stdin framing shared by the shell renderer and the one-shot launcher. */
export const WORKER_STDIN_FRAME_MAX_BRIEF_BYTES: number;
export function workerStdinDocument(input: { brief: string | Buffer; model: string; cwd: string }): string;
export function workerStdinBytes(invocation: { stdin: 'closed' | 'brief-text' | 'brief-json'; cwd: string;
  selected?: { model?: string } }, brief: string | Buffer): Buffer | null;
