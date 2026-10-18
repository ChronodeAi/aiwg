import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClawHubAdapter } from '../../../src/skills/adapters/clawhub.js';

describe('ClawHubAdapter CLI fallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-clawhub-adapter-'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a command substitution query literally without executing it', async () => {
    const sentinel = path.join(dir, 'injected');
    const record = path.join(dir, 'argv.json');
    const entry = path.join(dir, 'clawhub.mjs');
    const fixture = fileURLToPath(new URL('../../fixtures/codeql-residual/fake-tool.mjs', import.meta.url));
    fs.copyFileSync(fixture, entry);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'clawhub.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\clawhub.mjs" %*\n');
    } else {
      const command = path.join(dir, 'clawhub');
      fs.copyFileSync(fixture, command);
      fs.chmodSync(command, 0o755);
    }
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('AIWG_FAKE_TOOL_LOG', record);
    const query = `$(touch "${sentinel}")`;
    expect(await new ClawHubAdapter().search(query)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).args).toEqual(['search', query, '--json']);
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});
