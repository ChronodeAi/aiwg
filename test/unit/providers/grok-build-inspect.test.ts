import { describe, expect, it } from 'vitest';
import { runGrokInspect } from '../../../src/providers/grok-build-inspect.js';

describe('runGrokInspect', () => {
  it('returns absent when grok is not on PATH', () => {
    const result = runGrokInspect({ ...process.env, PATH: '/nonexistent-bin-dir' });
    expect(result.status).toBe('absent');
    if (result.status === 'absent') {
      expect(result.remediation).toMatch(/Install the Grok Build CLI/);
      expect(result.remediation).toMatch(/does not invent inspect output/);
    }
  });
});
