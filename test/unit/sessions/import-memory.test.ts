import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;
const REQUIRED_SPACE = BigInt(Math.ceil(1.2 * GIB));
const TMPFS_MAGIC = 0x01021994n;

it('reports Codex import memory results from a child process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-import-memory-smoke-'));
  try {
    const path = join(root, 'rollout.jsonl');
    const file = await open(path, 'wx');
    const content = '{"type":"session_meta","payload":{"id":"synthetic-session"}}\n'
      + '{"type":"event_msg","payload":{"text":"synthetic"}}\n';
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    const probe = fileURLToPath(new URL('../../fixtures/sessions/import-peak-memory.ts', import.meta.url));
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', probe, path, root],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    expect(stdout, stderr || 'import memory probe exited without a result').not.toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      eventsImported: 2,
      recordsRead: 2,
      sourceSize: Buffer.byteLength(content),
      peakRssGrowthBytes: expect.any(Number),
      peakHeapGrowthBytes: expect.any(Number),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('imports a 1 GiB Codex source with bounded peak RSS and heap growth', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-import-gib-'));
  try {
    const filesystem = await statfs(root, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    const capacity = filesystem.blocks * filesystem.bsize;
    if (filesystem.type === TMPFS_MAGIC && capacity < REQUIRED_SPACE) {
      context.skip(`1 GiB import needs a tmpfs capacity of at least 1.2 GiB; temp filesystem has ${capacity} bytes`);
    }
    if (available < REQUIRED_SPACE) {
      context.skip(`1 GiB import needs at least 1.2 GiB free in the test temp directory; available: ${available} bytes`);
    }

    const path = join(root, 'rollout.jsonl');
    const file = await open(path, 'wx');
    const recordBytes = 64 * 1024;
    const envelope = { type: 'event_msg', payload: { text: '' } };
    envelope.payload.text = 'x'.repeat(recordBytes - Buffer.byteLength(JSON.stringify(envelope) + '\n'));
    const line = JSON.stringify(envelope) + '\n';
    expect(Buffer.byteLength(line)).toBe(recordBytes);
    // Keep writes at 1 MiB regardless of the final fixture size.
    const chunk = Buffer.from(line.repeat(16));
    try {
      await file.writeFile('{"type":"session_meta","payload":{"id":"synthetic-session"}}\n');
      for (let bytes = 0; bytes < GIB; bytes += chunk.length) {
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    const size = (await stat(path)).size;
    expect(size).toBeGreaterThan(GIB);

    const probe = fileURLToPath(new URL('../../fixtures/sessions/import-peak-memory.ts', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', probe, path, root],
      { timeout: 180_000, maxBuffer: 64 * 1024,
        // The fixture is just over the 1 GiB default, so run it with no source cap (0 = unlimited, still streamed).
        env: { ...process.env, AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES: '0' } },
    );
    const result = JSON.parse(stdout) as {
      eventsImported: number;
      recordsRead: number;
      sourceSize: number;
      peakRssGrowthBytes: number;
      peakHeapGrowthBytes: number;
    };
    expect(result).toMatchObject({
      eventsImported: GIB / recordBytes + 1,
      recordsRead: GIB / recordBytes + 1,
      sourceSize: size,
    });
    expect(result.peakRssGrowthBytes).toBeLessThan(256 * 1024 * 1024);
    expect(result.peakHeapGrowthBytes).toBeLessThan(256 * 1024 * 1024);
    console.info('1 GiB import memory:', result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
