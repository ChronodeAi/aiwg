/**
 * Table-driven tests for the shared strict flag parser (#3062 second
 * review, finding 4): tokenize once, stop at a bare `--`, accept both
 * `--flag value` and `--flag=value`, validate every occurrence (not just
 * the first), reject an empty value only when asked to, and let the
 * caller choose which occurrence wins when a flag repeats.
 */

import { describe, expect, it } from 'vitest';
import {
  collectFlagValues,
  MissingFlagValueError,
  requireFlagValue,
  scanFlagOccurrences,
} from '../../../src/cli/flag-parsing.js';

describe('scanFlagOccurrences / requireFlagValue (#3062 second review, finding 4)', () => {
  it.each([
    ['--flag value form', ['--provider', 'claude'], 'claude'],
    ['--flag=value form', ['--provider=claude'], 'claude'],
  ])('%s', (_label, args, expected) => {
    expect(requireFlagValue(args, {}, '--provider')).toBe(expected);
  });

  it('a value may begin with a single -', () => {
    expect(requireFlagValue(['--effort', '-5'], {}, '--effort')).toBe('-5');
  });

  it('a space-separated value starting with -- is treated as missing', () => {
    expect(() => requireFlagValue(['--prompt', '--other'], {}, '--prompt')).toThrow(MissingFlagValueError);
  });

  it('--flag=--literal accepts a value that must start with --', () => {
    expect(requireFlagValue(['--prompt=--not-a-flag'], {}, '--prompt')).toBe('--not-a-flag');
  });

  it('stops recognizing flags entirely at a bare -- terminator', () => {
    expect(requireFlagValue(['--', '--provider', 'claude'], {}, '--provider')).toBeUndefined();
  });

  it('a flag positioned before -- is still recognized', () => {
    expect(requireFlagValue(['--provider', 'claude', '--', 'positional'], {}, '--provider')).toBe('claude');
  });

  it('a flag never given returns undefined, not an error', () => {
    expect(requireFlagValue(['--other', 'x'], {}, '--provider')).toBeUndefined();
  });

  it('a flag as the very last token with no value throws, naming the flag', () => {
    expect(() => requireFlagValue(['--provider'], {}, '--provider')).toThrow(/--provider requires a value/);
  });

  it.each([
    ['empty string, rejectEmpty: false (default) — accepted', false, undefined],
    ['empty string, rejectEmpty: true — rejected', true, MissingFlagValueError],
  ])('%s', (_label, rejectEmpty, expectedError) => {
    const call = () => requireFlagValue(['--prompt', ''], { rejectEmpty }, '--prompt');
    if (expectedError) expect(call).toThrow(expectedError);
    else expect(call()).toBe('');
  });

  it('an empty value via --flag=  is rejected the same way when rejectEmpty', () => {
    expect(() => requireFlagValue(['--prompt='], { rejectEmpty: true }, '--prompt')).toThrow(MissingFlagValueError);
  });

  describe('every occurrence is validated, not just the first', () => {
    it('a valid first occurrence does not hide a malformed second one', () => {
      expect(() => requireFlagValue(['--provider', 'claude', '--provider'], {}, '--provider')).toThrow(
        MissingFlagValueError,
      );
    });

    it('a malformed first occurrence is still caught even if a later one would be valid', () => {
      expect(() => requireFlagValue(['--provider', '--provider', 'claude'], {}, '--provider')).toThrow(
        MissingFlagValueError,
      );
    });
  });

  describe('precedence when a single-value flag repeats (both occurrences valid)', () => {
    it("'first' (default) resolves to the first occurrence", () => {
      expect(requireFlagValue(['--provider', 'claude', '--provider', 'codex'], {}, '--provider')).toBe('claude');
    });

    it("'last' resolves to the last occurrence", () => {
      expect(
        requireFlagValue(['--provider', 'claude', '--provider', 'codex'], { precedence: 'last' }, '--provider'),
      ).toBe('codex');
    });

    it("'last' also applies across --flag and --flag=value forms mixed", () => {
      expect(
        requireFlagValue(['--provider=claude', '--provider', 'codex'], { precedence: 'last' }, '--provider'),
      ).toBe('codex');
    });
  });

  it('accepts multiple alias names for the same logical flag', () => {
    expect(requireFlagValue(['--set', 'FOO=BAR'], {}, '--param', '--set')).toBe('FOO=BAR');
  });
});

describe('collectFlagValues (repeatable flags)', () => {
  it('collects every occurrence in left-to-right order', () => {
    expect(collectFlagValues(['--script', 'a=1', '--script', 'b=2'], {}, '--script')).toEqual(['a=1', 'b=2']);
  });

  it('returns [] when the flag never appears', () => {
    expect(collectFlagValues(['--other'], {}, '--script')).toEqual([]);
  });

  it('validates every occurrence, including a later malformed one', () => {
    expect(() => collectFlagValues(['--script', 'a=1', '--script'], {}, '--script')).toThrow(MissingFlagValueError);
  });

  it('stops at a bare -- terminator', () => {
    expect(collectFlagValues(['--script', 'a=1', '--', '--script', 'b=2'], {}, '--script')).toEqual(['a=1']);
  });
});

describe('scanFlagOccurrences (low-level)', () => {
  it('reports the matched index, flag, and value for each occurrence', () => {
    const occurrences = scanFlagOccurrences(['x', '--provider', 'claude', 'y'], ['--provider']);
    expect(occurrences).toEqual([{ index: 1, flag: '--provider', value: 'claude' }]);
  });
});
