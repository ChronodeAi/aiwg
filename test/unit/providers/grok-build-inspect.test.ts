import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  grokExecutableCandidates,
  runGrokInspect,
  validateGrokInspectReport,
} from '../../../src/providers/grok-build-inspect.js';

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeFakeGrok(binDir: string, scriptBody: string): string {
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, 'grok');
  writeFileSync(binary, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runGrokInspect', () => {
  it('returns absent when grok is not on PATH', () => {
    const result = runGrokInspect({ ...process.env, PATH: '/nonexistent-bin-dir' });
    expect(result.status).toBe('absent');
    if (result.status === 'absent') {
      expect(result.remediation).toMatch(/Install the Grok Build CLI/);
      expect(result.remediation).toMatch(/does not invent inspect output/);
    }
  });

  it('discovers grok via injected PATH env (not process.env alone)', () => {
    const root = temporaryRoot('aiwg-grok-inspect-path-');
    const binDir = join(root, 'bin');
    writeFakeGrok(
      binDir,
      `if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '{"projectInstructions":[{"path":"/tmp/AGENTS.md"}],"skills":[],"agents":[],"configSources":{"layers":[]}}'
  exit 0
fi
echo unknown >&2
exit 2`,
    );
    const result = runGrokInspect({
      env: { ...process.env, PATH: binDir },
      expected: {},
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.binary).toBe(join(binDir, 'grok'));
    }
  });

  it('resolves relative PATH entries against the deployment target cwd', () => {
    const root = temporaryRoot('aiwg-grok-inspect-relative-path-');
    const binDir = join(root, 'bin');
    writeFakeGrok(
      binDir,
      `printf '%s\n' '{"projectInstructions":[{"path":"AGENTS.md"}],"skills":[],"agents":[],"configSources":{"layers":[]}}'
exit 0`,
    );
    const result = runGrokInspect({
      env: { ...process.env, PATH: 'bin' },
      cwd: root,
      expected: { instructionPaths: ['AGENTS.md'] },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.binary).toBe(join(binDir, 'grok'));
  });

  it('enumerates PATHEXT candidates for Windows installs', () => {
    const candidates = grokExecutableCandidates(
      { PATH: 'C:\\Tools;bin', PATHEXT: '.EXE;.CMD' },
      'C:\\workspace',
      'win32',
    );
    expect(candidates).toContain('C:\\Tools\\grok.EXE');
    expect(candidates).toContain('C:\\Tools\\grok.CMD');
    expect(candidates).toContain('C:\\workspace\\bin\\grok.EXE');
  });

  it('runs inspect with the deployment target cwd', () => {
    const root = temporaryRoot('aiwg-grok-inspect-cwd-');
    const binDir = join(root, 'bin');
    const target = join(root, 'project');
    mkdirSync(target, { recursive: true });
    const marker = join(root, 'cwd-seen.txt');
    writeFakeGrok(
      binDir,
      `pwd > '${marker}'
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '{"projectInstructions":[{"path":"AGENTS.md"}],"skills":[{"name":"aiwg-status"}],"agents":[],"configSources":{"layers":[]}}'
  exit 0
fi
exit 1`,
    );
    const result = runGrokInspect({
      env: { ...process.env, PATH: binDir },
      cwd: target,
      expected: { instructionPaths: ['AGENTS.md'], skillNames: ['aiwg-status'] },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.cwd).toBe(target);
    }
    const seen = readFileSync(marker, 'utf8').trim();
    expect(seen).toBe(target);
  });

  it('returns ok when JSON report matches expected AIWG artifacts', () => {
    const root = temporaryRoot('aiwg-grok-inspect-ok-');
    const binDir = join(root, 'bin');
    writeFakeGrok(
      binDir,
      `printf '%s\\n' '{"cwd":"/proj","projectInstructions":[{"path":"/proj/AGENTS.md","scope":"project"}],"skills":[{"name":"aiwg-status","description":"status"}],"agents":[],"configSources":{"layers":[{"role":"project","path":"/proj/.grok/config.toml"}]}}'
exit 0`,
    );
    const result = runGrokInspect({
      env: { ...process.env, PATH: binDir },
      expected: {
        instructionPaths: ['AGENTS.md'],
        skillNames: ['aiwg-status'],
        configPathSubstrings: ['.grok/config.toml'],
      },
    });
    expect(result.status).toBe('ok');
  });

  it('returns failed on nonzero exit', () => {
    const root = temporaryRoot('aiwg-grok-inspect-fail-');
    const binDir = join(root, 'bin');
    writeFakeGrok(binDir, 'echo boom >&2; exit 7');
    const result = runGrokInspect({ env: { ...process.env, PATH: binDir } });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toMatch(/boom/);
    }
  });

  it('returns failed for malformed JSON even when exit is zero', () => {
    const root = temporaryRoot('aiwg-grok-inspect-badjson-');
    const binDir = join(root, 'bin');
    writeFakeGrok(binDir, 'echo not-json; exit 0');
    const result = runGrokInspect({ env: { ...process.env, PATH: binDir } });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.mismatches?.[0]?.kind).toBe('shape');
    }
  });

  it('returns failed when JSON omits expected AIWG artifacts', () => {
    const root = temporaryRoot('aiwg-grok-inspect-unexpected-');
    const binDir = join(root, 'bin');
    writeFakeGrok(
      binDir,
      `printf '%s\\n' '{"projectInstructions":[],"skills":[],"agents":[],"configSources":{"layers":[]}}'
exit 0`,
    );
    const result = runGrokInspect({
      env: { ...process.env, PATH: binDir },
      expected: { instructionPaths: ['AGENTS.md'], skillNames: ['aiwg-status'] },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.mismatches?.some((m) => m.kind === 'instructions')).toBe(true);
      expect(result.mismatches?.some((m) => m.kind === 'skills')).toBe(true);
    }
  });
});

describe('validateGrokInspectReport', () => {
  it('accepts a minimal valid InspectReport shape', () => {
    expect(validateGrokInspectReport({
      projectInstructions: [{ path: '/x/AGENTS.md' }],
      skills: [{ name: 'aiwg-status' }],
      agents: [],
      configSources: { layers: [{ path: '/x/.grok/config.toml' }] },
    }, {
      instructionPaths: ['AGENTS.md'],
      skillNames: ['aiwg-status'],
      configPathSubstrings: ['.grok/config.toml'],
    })).toEqual([]);
  });
});
