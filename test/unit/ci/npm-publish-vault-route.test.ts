import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('Gitea promotion Vault routes', () => {
  it('registers a dedicated authenticated-user evidence route', () => {
    const plan = JSON.parse(read('ci/vault-migration-plan.json'));
    const route = plan.routes.find((entry: { id: string }) => entry.id === 'github-release-evidence-token');
    expect(route).toEqual({
      id: 'github-release-evidence-token',
      path_variable: 'AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_PATH',
      field_variable: 'AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_FIELD',
      env: 'AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_FILE',
      type: 'api-token',
      purpose: 'Dedicated GitHub authenticated-user API release evidence token',
    });
    expect(plan.tracker_variables).toContain(route.path_variable);
    expect(plan.tracker_variables).toContain(route.field_variable);
  });

  it('exports only the dedicated evidence credential through the scoped spec', () => {
    const spec = read('ci/vault-fetch.npm-publish-evidence.spec');
    const directives = spec.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(directives).toEqual([
      'keyfile AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_FILE ${AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_PATH} ${AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_FIELD}',
    ]);
    expect(spec).not.toContain('GH_TOKEN');
    expect(spec).not.toContain('NODE_AUTH_TOKEN');
  });

  it('materializes a mode-0600 file, persists only its path, and removes it', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'aiwg-evidence-vault-'));
    try {
      const bin = resolve(fixture, 'bin');
      const envFile = resolve(fixture, 'github-env');
      mkdirSync(bin);
      writeFileSync(resolve(bin, 'curl'), '#!/bin/sh\ncat >/dev/null\necho "{}"\n');
      writeFileSync(resolve(bin, 'jq'), `#!/bin/sh
# Real jq consumes its input before closing the pipe. Preserve that contract.
cat >/dev/null
case "$*" in
  *auth.client_token*) echo fixture-vault-session ;;
  *data.data*) echo fixture-evidence-token ;;
  *) echo '{}' ;;
esac
`);
      chmodSync(resolve(bin, 'curl'), 0o755);
      chmodSync(resolve(bin, 'jq'), 0o755);
      const env = {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        CI: '1',
        RUNNER_TEMP: fixture,
        GITHUB_ENV: envFile,
        VAULT_ADDR: 'https://vault.invalid',
        VAULT_CI_ROLE_ID: 'fixture-role',
        VAULT_CI_SECRET_ID: 'fixture-secret',
        AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_PATH: 'fixture/evidence',
        AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_VAULT_FIELD: 'token',
      };
      const fetched = spawnSync('bash', ['ci/vault-fetch.sh', '--spec',
        'ci/vault-fetch.npm-publish-evidence.spec'], {
        cwd: root, env, encoding: 'utf8', timeout: 5_000,
      });
      expect(fetched.status, fetched.stderr).toBe(0);
      const persisted = readFileSync(envFile, 'utf8');
      expect(persisted).not.toContain('fixture-evidence-token');
      const tokenFile = persisted.match(/^AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN_FILE=(.+)$/m)?.[1];
      expect(tokenFile).toBeDefined();
      expect(readFileSync(tokenFile!, 'utf8')).toBe('fixture-evidence-token\n');
      expect(statSync(tokenFile!).mode & 0o777).toBe(0o600);

      const cleaned = spawnSync('bash', ['ci/vault-fetch.sh', '--cleanup'], {
        cwd: root, env, encoding: 'utf8', timeout: 5_000,
      });
      expect(cleaned.status, cleaned.stderr).toBe(0);
      expect(existsSync(tokenFile!)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
