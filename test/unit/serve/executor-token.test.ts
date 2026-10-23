import { describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import { executorTokensEqual } from '../../../src/serve/executor-token.mjs';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('executor token comparison', () => {
  it.each([
    ['secret', 'secret', true],
    ['secret', 'wrong!', false],
    ['secret', 'x'.repeat(1000), false],
    ['é', 'e', false],
  ])('compares %j and %j with fixed-size digests', (expected, presented, equal) => {
    expect(executorTokensEqual(expected, presented)).toBe(equal);
    const args = vi.mocked(timingSafeEqual).mock.calls.at(-1)!;
    expect(args[0].byteLength).toBe(32);
    expect(args[1].byteLength).toBe(32);
  });

  it.each([[undefined, 'secret'], ['secret', undefined], ['', ''], ['secret', '']])('rejects absent tokens', (expected, presented) => {
    expect(executorTokensEqual(expected, presented)).toBe(false);
  });
});
