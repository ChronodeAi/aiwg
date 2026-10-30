import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dateTime, integer, url, number } from '../../../src/schema/zod-validation.mjs';

describe('persisted schema compatibility', () => {
  it('preserves infinite measurements while rejecting NaN and nonnumeric input', () => {
    expect(number().parse(Infinity)).toBe(Infinity);
    expect(number().parse(-Infinity)).toBe(-Infinity);
    expect(number().safeParse(NaN).success).toBe(false);
    expect(number().safeParse('1').success).toBe(false);
    const bounded = number().check(z.gte(0)).meta({ minimum: 0 });
    expect(bounded.safeParse(Infinity).success).toBe(true);
    expect(bounded.safeParse(-Infinity).success).toBe(false);
    expect(z.toJSONSchema(bounded)).toMatchObject({ type: 'number', minimum: 0 });
  });

  it('preserves valid URL input spelling and URI JSON Schema', () => {
    const value = '  https://example.test/a\tpath\n  ';
    expect(url().parse(value)).toBe(value);
    expect(url().parse('mailto:synthetic@example.test')).toBe('mailto:synthetic@example.test');
    expect(url().safeParse('relative/path').success).toBe(false);
    expect(z.toJSONSchema(url())).toMatchObject({ type: 'string', format: 'uri' });
  });

  it('accepts existing integer values outside the safe integer range and retains integer JSON Schema', () => {
    expect(integer().safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(true);
    expect(integer().safeParse(-Number.MAX_SAFE_INTEGER - 1).success).toBe(true);
    const result = integer().safeParse(1.5);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ code: 'invalid_type', expected: 'int' });
    expect(integer().positive().safeParse(-1).success).toBe(false);
    const combined = integer().positive().safeParse(-1.5);
    if (!combined.success) expect(combined.error.issues.map(issue => issue.code)).toEqual(['invalid_type', 'too_small']);
    else throw new Error('fractional negative number must be rejected');
    expect(z.toJSONSchema(integer())).toMatchObject({ type: 'integer' });
  });

  it.each(['2024-02-29T12:30Z', '2024-02-29T12:30:45Z', '2024-02-29T12:30:45.123Z'])(
    'accepts existing timestamp precision: %s', value => expect(dateTime().safeParse(value).success).toBe(true),
  );

  it.each(['+0530', '+05:30', '-9900'])(
    'preserves previously accepted numeric offset syntax: %s', offset => {
      const value = `2024-02-29T12:30${offset}`;
      expect(dateTime({ offset: true }).safeParse(value).success).toBe(true);
      expect(dateTime().safeParse(value).success).toBe(false);
    },
  );

  it.each(['2023-02-29T12:30Z', '2024-04-31T12:30Z', '2024-02-29T24:00Z', '2024-02-29T12:60Z', '2024-02-29T12:30'])(
    'rejects invalid dates, times and missing zones: %s', value => expect(dateTime().safeParse(value).success).toBe(false),
  );

  it('retains custom timestamp errors and JSON Schema formats', () => {
    const result = dateTime({ error: 'Timestamp required' }).safeParse('invalid');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ code: 'invalid_format', format: 'datetime', message: 'Timestamp required' });
    expect(z.toJSONSchema(dateTime())).toMatchObject({ type: 'string', format: 'date-time' });
  });
});
