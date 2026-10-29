// Guard the CLI exception boundary independently of source-level lookup findings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCli } from '../../../src/artifacts/corpus-tools/resolve-cli.js';
import { resolveReference } from '../../../src/artifacts/corpus-tools/resolve.js';
import { AiwgError, exitCodeFor } from '../../../src/cli/errors.js';
import { ResearchError, ResearchErrorCode as Code } from '../../../src/research/types.js';

vi.mock('../../../src/artifacts/corpus-tools/resolve.js', () => ({
  createResolverClients: vi.fn(() => ({})), resolveReference: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe('corpus resolve thrown errors', () => {
  it.each([Code.RF_103, Code.RF_104, Code.RF_200, Code.RF_201, Code.RF_202, Code.RF_500, Code.RF_501, Code.RF_502])(
    'defers transient %s', async code => {
      vi.mocked(resolveReference).mockRejectedValueOnce(new ResearchError(code, 'Temporary source failure'));
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
      await expect(resolveCli(['A reference', '--json'], '', '')).rejects.toMatchObject({ exitCode: 4 });
      expect(JSON.parse(output)).toMatchObject({ status: 'deferred', incomplete: true, error: 'Temporary source failure' });
    });
  it.each([
    new Error('Local corpus read failure'),
    new AiwgError({ code: 'ERR_CORPUS_STORAGE', message: 'Storage failed', exitCode: 1 }),
    ...[Code.RF_100, Code.RF_102, Code.RF_300, Code.RF_301, Code.RF_400, Code.RF_401, Code.RF_402]
      .map(code => new ResearchError(code, 'Nontransient failure')),
  ])('propagates nontransient error: %s', async error => {
    vi.mocked(resolveReference).mockRejectedValueOnce(error);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const caught = await resolveCli(['A reference', '--json'], '', '').catch(value => value);
    expect(caught).toBe(error);
    expect(exitCodeFor(caught)).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });
});
