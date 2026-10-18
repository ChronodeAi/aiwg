import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../helpers/regexp.js';

describe('literal test regular expressions', () => {
  it.each(['pack:namespace/path\\name.*+?^${}()|[]', 'decision.aiwg.io/v1alpha2'])('matches %s literally', value => {
    const pattern = new RegExp(`^${escapeRegExp(value)}$`);
    expect(pattern.test(value)).toBe(true);
    expect(pattern.test(value.replaceAll('.', 'X'))).toBe(false);
    expect(pattern.test(value.replaceAll('\\', ''))).toBe(value.indexOf('\\') < 0);
  });
});
