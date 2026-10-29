// Public demos and private seeds pin current scorer bytes and all newly extracted modules.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { d29ScorerDigest } from '../../../tools/decision/studies/d29.mjs';
import { d29ScorerDigest as checkedScorerDigest } from '../../../tools/decision/studies/d29-provenance.mjs';

const source = new URL('../../../tools/decision/studies/d29.mjs', import.meta.url);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

it.each(['v6', 'v7', 'v8', 'private-synthetic-fixture'])('pins %s to the current entry bytes', async version => {
  expect(await d29ScorerDigest(`d29-study-${version}`)).toBe(digest(await readFile(source)));
});

it.each(['d29-gates.mjs', 'd29-provenance.mjs'])('refuses edited %s bytes behind an unchanged entry pin', async name => {
  const entry = await readFile(source, 'utf8');
  const pin = entry.match(new RegExp(`'\\./${name.replace('.', '\\.')}'\\s*:\\s*'(sha256:[a-f0-9]{64})'`))[1];
  const bytes = await readFile(new URL(`../../../tools/decision/studies/${name}`, import.meta.url));
  expect(pin).toBe(digest(bytes));
  // No filesystem mutation: the injected reader represents changed module bytes.
  vi.resetModules();
  vi.doMock('node:fs/promises', () => ({ readFile: async () => Buffer.concat([bytes, Buffer.from('\n// edited')]) }));
  try {
    const { d29ScorerDigest: changed } = await import('../../../tools/decision/studies/d29-provenance.mjs');
    await expect(changed('d29-study-v8', { [`./${name}`]: pin })).rejects.toThrow('scorer-module-pin');
  } finally { vi.doUnmock('node:fs/promises'); vi.resetModules(); }
});

it('refuses a wrong extracted-module source pin', async () => {
  await expect(checkedScorerDigest('private-synthetic-fixture', { './d29-gates.mjs': `sha256:${'0'.repeat(64)}` }))
    .rejects.toThrow('scorer-module-pin');
});
