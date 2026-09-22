/**
 * Practical end-to-end coverage for `aiwg use --provider grok-build`.
 * Project deploy, $GROK_HOME user mirroring, registry record, and receipts.
 * Full remove + live `grok inspect` binary verification remain separate from
 * this deterministic absent-binary integration path.
 *
 * @issue #2575
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../..');
const roots: string[] = [];

function isolated(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runUse(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const routerUrl = pathToFileURL(path.join(REPO_ROOT, 'src/cli/router.ts')).href;
  const runner = `import { run } from ${JSON.stringify(routerUrl)}; await run(process.argv.slice(1), { cwd: process.env.AIWG_TEST_PROJECT_ROOT }); process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', runner, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      ...env,
      NO_UPDATE_NOTIFIER: '1',
    },
  });
  let json: Record<string, unknown> = {};
  try {
    json = result.stdout ? JSON.parse(result.stdout) : {};
  } catch {
    json = { raw: result.stdout };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json,
  };
}

describe('aiwg use grok-build e2e (#2575)', () => {
  it('deploys project kernel skills, mirrors to $GROK_HOME, and records registry/receipts', () => {
    const home = isolated('aiwg-grok-use-home-');
    const project = isolated('aiwg-grok-use-project-');
    const grokHome = path.join(home, 'custom-grok-home');
    mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    writeFileSync(path.join(home, '.aiwg', 'channel.json'), JSON.stringify({
      channel: 'edge',
      edgePath: REPO_ROOT,
      devMode: true,
    }));
    const userRegistry = path.join(home, '.aiwg', 'installed.json');

    const use = runUse([
      'use', 'sdlc',
      '--provider', 'grok-build',
      '--target', project,
      '--scope', 'user',
      '--no-project-local',
      '--no-utils',
      '--json',
    ], {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      AIWG_USER_REGISTRY_PATH: userRegistry,
      AIWG_TEST_PROJECT_ROOT: project,
      GROK_HOME: grokHome,
      // Keep the runner's Node executable available without normal Grok install roots.
      PATH: path.dirname(process.execPath),
    }, project);

    expect(use.status, use.stderr || use.stdout).toBe(0);
    expect(use.json).toMatchObject({
      schema: 'aiwg.use.result.v1',
    });

    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toMatch(/Grok Build|grok-build/i);
    expect(existsSync(path.join(project, '.grok', 'skills'))).toBe(true);
    const projectSkills = readdirSync(path.join(project, '.grok', 'skills')).filter((name) =>
      existsSync(path.join(project, '.grok', 'skills', name, 'SKILL.md')));
    expect(projectSkills.length).toBeGreaterThan(0);
    expect(projectSkills.length).toBeLessThan(80);
    // No full-corpus dump into the standard mirror without --copy-all.
    expect(existsSync(path.join(project, '.grok', '.aiwg', 'skills'))).toBe(false);
    // Agents/rules writers deferred — should not invent agent trees.
    expect(existsSync(path.join(project, '.grok', 'agents'))).toBe(false);

    // User-scope mirror via $GROK_HOME/skills
    expect(existsSync(path.join(grokHome, 'skills'))).toBe(true);
    const userSkills = readdirSync(path.join(grokHome, 'skills')).filter((name) =>
      existsSync(path.join(grokHome, 'skills', name, 'SKILL.md')));
    expect(userSkills.length).toBeGreaterThan(0);

    // The user registry must record the actual provider deployment and entries.
    expect(existsSync(userRegistry)).toBe(true);
    const registry = JSON.parse(readFileSync(userRegistry, 'utf8')) as {
      installed?: Record<string, { deployedTo?: Record<string, {
        skills?: number;
        entries?: { skills?: string[] };
      }> }>;
    };
    const recorded = registry.installed?.sdlc?.deployedTo?.['grok-build'];
    expect(recorded?.skills).toBeGreaterThan(0);
    expect(recorded?.entries?.skills?.length).toBeGreaterThan(0);

    // Local-source delivery deterministically emits the policy-exempt evidence state.
    const evidencePath = path.join(
      project,
      '.aiwg',
      'receipts',
      'providers',
      'grok-build.user.evidence.json',
    );
    expect(existsSync(evidencePath)).toBe(true);
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      schemaVersion: 'aiwg.provider-transformation-evidence-state.v1',
      provider: 'grok-build',
      scope: 'user',
      disposition: 'local-source',
    });

    expect(use.json).toMatchObject({
      providers: [expect.objectContaining({
        provider: 'grok-build',
        findings: expect.arrayContaining([
          expect.objectContaining({ id: 'grok-inspect-absent', severity: 'advisory' }),
        ]),
      })],
    });
  }, 180_000);
});
