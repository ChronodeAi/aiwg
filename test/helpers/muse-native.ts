import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function museMetadata(sessionId: string, sequence: number, workspace?: string) {
  return {
    schema_version: 1,
    id: `synthetic-${sessionId}-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: 1790222400000000 + sequence,
    record_type: 'runtime.session.metadata',
    durability: 'durable',
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload: { kind: 'metadata', record: workspace ? { workspace_root: workspace } : {} },
  };
}

export async function writeMuseLog(
  root: string,
  sessionId: string,
  count: number,
  workspace?: string,
  evidenceAt = 0,
): Promise<string> {
  const locator = join(root, '2026', '09', '24', sessionId, 'session.jsonl');
  await mkdir(dirname(locator), { recursive: true });
  const lines = Array.from({ length: count }, (_, sequence) => JSON.stringify(
    museMetadata(sessionId, sequence, sequence === evidenceAt ? workspace : undefined),
  ));
  await writeFile(locator, lines.join('\n') + '\n');
  return locator;
}
