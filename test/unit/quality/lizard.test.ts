/**
 * @source @tools/quality/lizard.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileLoc, parseLizardCsv, runLizard } from '../../../tools/quality/lizard.mjs';

// Captured from `lizard --csv a.py b.ts` (lizard 1.24.0; no header without -V).
const CAPTURED = [
  '4,2,18,3,4,"f@1-4@a.py","a.py","f","f( a , b , c = \'x,y\' )",1,4',
  '2,1,7,1,2,"m@7-8@a.py","a.py","m","m( self )",7,8',
  '4,2,23,2,4,"g@1-4@b.ts","b.ts","g","g ( x , y )",1,4',
].join('\n');

const lizardAvailable = spawnSync('lizard', ['--version']).status === 0
  || spawnSync('python3', ['-m', 'lizard', '--version']).status === 0;

describe('parseLizardCsv', () => {
  it('parses positional columns with commas inside quoted long names', () => {
    const functions = parseLizardCsv(CAPTURED);
    expect(functions).toHaveLength(3);
    expect(functions[0]).toEqual({
      file: 'a.py', name: 'f', longName: "f( a , b , c = 'x,y' )", startLine: 1, endLine: 4, nloc: 4, ccn: 2, params: 3,
    });
    expect(functions[2]).toMatchObject({ file: 'b.ts', name: 'g', ccn: 2, params: 2 });
  });

  it('skips the -V header row', () => {
    expect(parseLizardCsv(`NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end\n${CAPTURED}`)).toHaveLength(3);
  });
});

describe('fileLoc', () => {
  it('counts physical lines with or without a trailing newline', () => {
    expect(fileLoc('a\nb\n')).toBe(2);
    expect(fileLoc('a\nb')).toBe(2);
    expect(fileLoc('')).toBe(0);
  });
});

describe.skipIf(!lizardAvailable)('runLizard (live)', () => {
  it('measures a Python function', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-lizard-'));
    try {
      writeFileSync(join(dir, 'a.py'), 'def f(x):\n    if x:\n        return 1\n    return 2\n');
      expect(runLizard(['a.py'], { cwd: dir })).toEqual([
        expect.objectContaining({ file: 'a.py', name: 'f', ccn: 2, startLine: 1 }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
