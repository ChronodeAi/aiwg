import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from '../../helpers/temp-dir.js';
import { streamJsonLines } from '../../../src/sessions/readers.js';

it('preserves multi-chunk UTF-8 lines, retained strings, inclusive ranges and final tails when raw storage is reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-reader-buffer-'));
  const file = join(root, 'source.jsonl');
  const lines = ['prefix\r\n', 'é😀'.repeat(600_000) + '\r\n', 'tail😀'];
  await writeFile(file, lines.join(''));
  const results = [];
  for await (const record of streamJsonLines(file)) results.push(record);
  expect(results).toEqual(lines.map(line => ({ line, byteLength: Buffer.byteLength(line) })));
  const start = Buffer.byteLength(lines[0]);
  const end = start + Buffer.byteLength(lines[1]) - 1;
  const ranged = [];
  for await (const record of streamJsonLines(file, { start, end })) ranged.push(record);
  expect(ranged).toEqual([results[1]]);
  // Breaking an iteration must close its file and leave later reads independent.
  for await (const record of streamJsonLines(file)) { expect(record.line).toBe(lines[0]); break; }
  const again = [];
  for await (const record of streamJsonLines(file, { start: end + 1 })) again.push(record);
  expect(again).toEqual([results[2]]);
});


it.each([{ start: -1 }, { start: 0.5 }, { end: -1 }, { end: 1.5 }, { start: 5, end: 4 }])(
  'rejects invalid byte ranges before opening the source: %j', async (range) => {
    await expect(streamJsonLines('/nonexistent-source', range).next()).rejects.toBeInstanceOf(RangeError);
  },
);
