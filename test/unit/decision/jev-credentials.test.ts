import { mkdtempSync } from 'node:fs';
import { chmod, link, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectJevCredential, jevCredentialPath, lookupJevCredential, resolveJevCredentialBytes,
  writeJevCredentialFile, type JevCredentialOptions,
} from '../../../src/decision/jev-credentials.js';

const SECRET = 'synthetic-runtime-jev-key';

describe('Jev runtime sensitive-value lookup', () => {
  let root: string;
  let options: JevCredentialOptions;
  let filename: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-jev-runtime-'));
    options = { cwd: root, configHome: root, homeDir: root, env: { AIWG_CONFIG: path.join(root, 'user') } };
    filename = jevCredentialPath(options);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  async function legacy(record: object = { token: SECRET }) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, JSON.stringify(record), { mode: 0o600 });
  }

  it('retains the legacy JSON record, path, default region and enablement', async () => {
    await legacy();
    expect(filename).toBe(path.join(root, 'aiwg', 'credentials', 'jev.json'));
    await expect(lookupJevCredential(options)).resolves.toEqual({ source: 'file', token: SECRET, region: 'us', enabled: false });
    await legacy({ token: SECRET, region: 'eu', endpoint: 'https://jev.example/v1', enabled: true });
    await expect(lookupJevCredential(options)).resolves.toEqual({ source: 'file', token: SECRET, region: 'eu', endpoint: 'https://jev.example/v1', enabled: true });
    expect(new TextDecoder().decode(await resolveJevCredentialBytes('typesafe-api', options))).toBe(SECRET);
  });

  it('keeps primary/alias/file precedence and file metadata for environment credentials', async () => {
    await legacy({ token: SECRET, region: 'eu', endpoint: 'https://jev.example/v1', enabled: true });
    const env = { ...options.env, JEV_API_KEY: ' primary-canary ', AIWG_DECISION_JEV_API_KEY: 'alias-canary' };
    await expect(lookupJevCredential({ ...options, env })).resolves.toMatchObject({ source: 'env', token: 'primary-canary', region: 'eu', endpoint: 'https://jev.example/v1', enabled: true });
    env.JEV_API_KEY = ' ';
    await expect(lookupJevCredential({ ...options, env })).resolves.toMatchObject({ source: 'env', token: 'alias-canary', region: 'eu' });
    env.AIWG_DECISION_JEV_API_KEY = '';
    await expect(lookupJevCredential({ ...options, env })).resolves.toMatchObject({ source: 'file', token: SECRET });
  });

  it('preserves forced environment enablement without touching the credential file', async () => {
    await legacy();
    await chmod(filename, 0o644);
    await expect(lookupJevCredential({ ...options, env: { ...options.env, AIWG_DECISION_ENABLED: '1', JEV_API_KEY: SECRET } }))
      .resolves.toEqual({ source: 'env', token: SECRET, region: 'us', enabled: true });
  });

  it('keeps generated credential files private and uses them on the next lookup', async () => {
    await writeJevCredentialFile({ token: SECRET, region: 'us', enabled: true }, options);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filename))).mode & 0o777).toBe(0o700);
    await expect(lookupJevCredential(options)).resolves.toMatchObject({ token: SECRET, source: 'file' });
  });

  it.each([0o640, 0o604])('refuses mode %o with a clear, credential-free error', async mode => {
    await legacy();
    await chmod(filename, mode);
    let failure: unknown;
    try { await lookupJevCredential(options); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ category: 'denied', message: expect.stringMatching(/Jev credential file.*group or other access/) });
    expect(String(failure)).not.toContain(SECRET);
    await expect(inspectJevCredential(options)).resolves.toEqual({ configured: null, enabled: null, source: 'unknown' });
  });

  it.each(['symlink', 'hardlink'])('refuses a %s credential record', async kind => {
    await legacy();
    const alias = path.join(path.dirname(filename), 'alias.json');
    if (kind === 'symlink') await symlink(filename, alias); else await link(filename, alias);
    await expect(lookupJevCredential({ ...options, credentialPath: alias })).rejects.toMatchObject({
      category: 'denied', message: expect.stringMatching(kind === 'symlink' ? /symlink/ : /hard link/),
    });
  });

  it('refuses another owner before parsing the credential record', async () => {
    await legacy();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(lookupJevCredential(options)).rejects.toMatchObject({ category: 'denied', message: expect.stringMatching(/not owned by the current user/) });
  });

  it('retains the private parent directory requirement', async () => {
    await legacy();
    await chmod(path.dirname(filename), 0o755);
    await expect(lookupJevCredential(options)).rejects.toMatchObject({ category: 'denied', message: expect.stringMatching(/directory.*group or other access/) });
  });

  it('keeps parse errors, metadata inspection and stdout/stderr free of the value', async () => {
    await legacy({ token: SECRET, enabled: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(JSON.stringify(await inspectJevCredential(options))).not.toContain(SECRET);
      await writeFile(filename, `{"token":"${SECRET}",invalid}`, { mode: 0o600 });
      let failure: unknown;
      try { await lookupJevCredential(options); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ category: 'configuration' });
      expect(String(failure)).not.toContain(SECRET);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });

  it('keeps a missing runtime credential optional without prompting', async () => {
    await expect(lookupJevCredential(options)).resolves.toBeNull();
  });
});
