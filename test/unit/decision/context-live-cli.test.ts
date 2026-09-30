import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Live-mode preflight of the TV-12 CLI. Every case must be refused before the build, the resolver import
 * and any credential read, so each run finishes in well under a build's duration and prints a fixed reason.
 */
const cli = 'tools/decision/context-live-qualification.mjs';
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function run(args: string[], env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.FORCE_COLOR;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: childEnv, timeout: 30_000 });
  return { status: result.status, stderr: result.stderr, elapsedMs: Date.now() - started };
}

describe('TV-12 CLI live-mode preflight (offline)', () => {
  async function files() {
    const directory = await mkdtemp(join(tmpdir(), 'tv12-cli-'));
    const approval = join(directory, 'approval.json'); const resolver = join(directory, 'resolver.mjs');
    await writeFile(approval, '{"schemaVersion":"context-live-approval/v1"}\n');
    await writeFile(resolver, 'export async function resolveCredential() { throw new Error("must not be imported"); }\n');
    return { directory, approval, resolver, approvalDigest: digest('{"schemaVersion":"context-live-approval/v1"}\n'),
      resolverDigest: digest('export async function resolveCredential() { throw new Error("must not be imported"); }\n') };
  }
  const collect = (f: Awaited<ReturnType<typeof files>>, overrides: Partial<Record<'approvalDigest' | 'resolverDigest', string>> = {}) => ['--collect-approved',
    f.approval, overrides.approvalDigest ?? f.approvalDigest, join(f.directory, 'corpus.json'), f.directory, f.resolver, overrides.resolverDigest ?? f.resolverDigest];
  const canary = (f: Awaited<ReturnType<typeof files>>) => ['--canary-approved', f.approval, f.approvalDigest, join(f.directory, 'corpus.json'),
    join(f.directory, 'record.json'), f.directory, f.resolver, f.resolverDigest];

  it.each([['collect', collect], ['canary', canary]] as const)('%s requires the AIWG_DECISION_TV12_LIVE=1 gate', async (_label, args) => {
    const f = await files();
    try {
      for (const value of [undefined, '0', 'true']) {
        const result = run(args(f), { AIWG_DECISION_TV12_LIVE: value });
        expect(result.status).toBe(1); expect(result.stderr).toContain('AIWG_DECISION_TV12_LIVE=1');
        expect(result.elapsedMs).toBeLessThan(10_000);
      }
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it('refuses a process that disables TLS verification', async () => {
    const f = await files();
    try {
      const result = run(collect(f), { AIWG_DECISION_TV12_LIVE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
      expect(result.status).toBe(1); expect(result.stderr).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it.each([
    ['approval', { approvalDigest: `sha256:${'0'.repeat(64)}` }, 'approval digest'],
    ['resolver', { resolverDigest: `sha256:${'0'.repeat(64)}` }, 'resolver digest'],
  ] as const)('refuses a %s digest that differs from the pinned command-line value before the build', async (_label, overrides, message) => {
    const f = await files();
    try {
      const result = run(collect(f, overrides), { AIWG_DECISION_TV12_LIVE: '1', NODE_TLS_REJECT_UNAUTHORIZED: undefined });
      expect(result.status).toBe(1); expect(result.stderr).toContain(message);
      expect(result.elapsedMs).toBeLessThan(10_000);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});
