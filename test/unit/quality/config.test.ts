/**
 * @source @tools/quality/config.mjs
 */
import { describe, expect, it } from 'vitest';
import { defaultGateConfig, globToRegExp, isMeasured, parseGateConfig } from '../../../tools/quality/config.mjs';

describe('globToRegExp', () => {
  it.each([
    ['**/test/**', 'test/a.py', true],
    ['**/test/**', 'pkg/test/sub/a.py', true],
    ['**/test/**', 'pkg/testing/a.py', false],
    ['src/*.py', 'src/a.py', true],
    ['src/*.py', 'src/sub/a.py', false],
    ['.aiwg/quality/**', '.aiwg/quality/gate.json', true],
    ['tsconfig*.json', 'tsconfig.build.json', true],
    ['tsconfig*.json', 'pkg/tsconfig.json', false],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
    ['.eslintrc*', 'xeslintrc', false],
  ])('%s matches %s → %s', (pattern, file, expected) => {
    expect(globToRegExp(pattern).test(file)).toBe(expected);
  });
});

describe('parseGateConfig', () => {
  it('rejects unknown top-level keys', () => {
    expect(() => parseGateConfig('{"version":1,"thresholds":{}}')).toThrow('gate.json: unknown key thresholds');
  });

  it('fills missing sections with defaults', () => {
    const cfg = parseGateConfig('{"bands":{"function_ccn":{"p90":9}}}');
    expect(cfg.bands.function_ccn).toEqual({ p70: 0, p80: 0, p90: 9 });
    expect(cfg.evaluator_surfaces).toEqual(defaultGateConfig().evaluator_surfaces);
  });
});

describe('isMeasured', () => {
  it('measures every supported source file when include is empty, minus excludes', () => {
    const cfg = defaultGateConfig();
    expect(isMeasured('cmd/main.go', cfg)).toBe(true);
    expect(isMeasured('src/a.test.ts', cfg)).toBe(false);
    expect(isMeasured('README.md', cfg)).toBe(false);
  });
});
