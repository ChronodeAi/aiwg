import { open } from 'node:fs/promises';
import { SessionContractError } from '../contracts.js';
import { authorizeSourceFile, type SourceAuthorization } from '../policy.js';
import type { ReaderLimits } from '../readers.js';

// Discovery inspects metadata, not an entire import. Bound allocation before
// assembling a line (readline would buffer an arbitrarily large single line).
export const MUSE_WORKSPACE_SCAN_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  maxRecords: 10_000,
  maxRecordBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxNestingDepth: 64,
});

export interface MuseScanProgress {
  recordsInspected: number;
  bytesInspected: number;
}

export async function* museWorkspaceScanLines(
  authorization: SourceAuthorization,
  limits: ReaderLimits,
  progress: MuseScanProgress,
): AsyncGenerator<unknown> {
  const allowed = await authorizeSourceFile(authorization);
  const handle = await open(allowed.canonicalPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let parts: Buffer[] = [];
    let length = 0;
    while (position < allowed.size) {
      const remaining = limits.maxTotalBytes - progress.bytesInspected;
      if (remaining <= 0) throw scanLimit();
      const { bytesRead } = await handle.read(
        buffer, 0, Math.min(buffer.length, allowed.size - position, remaining), position,
      );
      if (bytesRead === 0) {
        throw new SessionContractError('TRUNCATED_SOURCE', 'Muse source changed during inspection');
      }
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
        const segment = buffer.subarray(start, end);
        if (length + segment.length > limits.maxRecordBytes) throw scanLimit();
        parts.push(Buffer.from(segment));
        length += segment.length;
        progress.bytesInspected += segment.length;
        start = end;
        if (newline >= 0 && newline < bytesRead) {
          const line = Buffer.concat(parts, length).toString('utf8');
          parts = [];
          length = 0;
          if (line.trim() !== '') {
            if (progress.recordsInspected >= limits.maxRecords) throw scanLimit();
            const value = parseMuseScanJson(line, limits.maxNestingDepth);
            progress.recordsInspected += 1;
            yield value;
          }
        }
      }
    }
    if (length > 0) {
      const line = Buffer.concat(parts, length).toString('utf8');
      if (line.trim() !== '') {
        if (progress.recordsInspected >= limits.maxRecords) throw scanLimit();
        let value;
        try {
          value = parseMuseScanJson(line, limits.maxNestingDepth);
        } catch (error) {
          if (error instanceof SessionContractError && error.code === 'MALFORMED_SOURCE') {
            throw new SessionContractError('TRUNCATED_SOURCE', 'Muse source has an incomplete JSONL tail');
          }
          throw error;
        }
        progress.recordsInspected += 1;
        yield value;
      }
    }
    const after = await handle.stat();
    if (after.size !== allowed.size || after.mtimeMs !== allowed.mtimeMs) {
      throw new SessionContractError('TRUNCATED_SOURCE', 'Muse source changed during inspection');
    }
  } finally {
    await handle.close();
  }
}

export function parseMuseScanJson(line: string, maxDepth: number): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new SessionContractError('MALFORMED_SOURCE', 'Muse inspection encountered malformed JSON');
  }
  // Check depth iteratively, including decoded retained children, before zod
  // validation. Deep input must produce a limit diagnostic, not stack overflow.
  const pending = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > maxDepth) throw scanLimit();
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

function scanLimit(): SessionContractError {
  return new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'bounded Muse workspace inspection limit exceeded');
}
