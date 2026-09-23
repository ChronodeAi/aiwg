/**
 * `respect-repo-access-manifest` makes the manifest mandatory and default-deny,
 * but every verb was read-only: registering a repo meant hand-editing JSON, and
 * the rule's own recovery text had no supported way to be carried out.
 *
 * @issue #2531
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repoAccessHandler } from '../../../../src/cli/handlers/repo-access.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

let root: string;

function ctx(args: string[]): HandlerContext {
  return { args, rawArgs: ['repo-access', ...args], cwd: root, frameworkRoot: root };
}

async function readConfig(): Promise<{ repos?: Array<{ name: string; allowed: string[] }> }> {
  return JSON.parse(await fs.readFile(path.join(root, '.aiwg', 'aiwg.config'), 'utf8'));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-repo-access-'));
  await fs.mkdir(path.join(root, '.aiwg'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.aiwg', 'aiwg.config'),
    JSON.stringify({
      version: '1', providers: ['claude'], installed: {}, scripts: {},
      workspace: { name: 'test', root: '.' },
    }),
    'utf8',
  );
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('repo-access add (#2531)', () => {
  it('registers the first repo with no manifest present', async () => {
    const result = await repoAccessHandler.execute(
      ctx(['add', '--path', './child', '--name', 'child', '--allow', 'read,write']),
    );
    expect(result.exitCode).toBe(0);
    const config = await readConfig();
    expect(config.repos).toHaveLength(1);
    expect(config.repos?.[0]).toMatchObject({ name: 'child', allowed: ['read', 'write'] });
  });

  it('rejects an unknown action instead of writing it', async () => {
    const result = await repoAccessHandler.execute(
      ctx(['add', '--path', './child', '--name', 'child', '--allow', 'read,fly']),
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('fly');
    expect((await readConfig()).repos).toBeUndefined();
  });

  it('updates an existing entry rather than duplicating it', async () => {
    await repoAccessHandler.execute(ctx(['add', '--path', './c', '--name', 'c', '--allow', 'read']));
    await repoAccessHandler.execute(ctx(['add', '--path', './c', '--name', 'c', '--allow', 'read,push']));
    const config = await readConfig();
    expect(config.repos).toHaveLength(1);
    expect(config.repos?.[0].allowed).toEqual(['read', 'push']);
  });

  it('requires --path, --name and --allow', async () => {
    expect((await repoAccessHandler.execute(ctx(['add', '--name', 'c', '--allow', 'read']))).exitCode).toBe(2);
    expect((await repoAccessHandler.execute(ctx(['add', '--path', './c', '--allow', 'read']))).exitCode).toBe(2);
    expect((await repoAccessHandler.execute(ctx(['add', '--path', './c', '--name', 'c']))).exitCode).toBe(2);
  });
});

describe('repo-access remove (#2531)', () => {
  it('drops the repos key when the last entry goes, keeping the config readable', async () => {
    await repoAccessHandler.execute(ctx(['add', '--path', './c', '--name', 'c', '--allow', 'read']));
    const result = await repoAccessHandler.execute(ctx(['remove', '--name', 'c']));
    expect(result.exitCode).toBe(0);
    // An empty array fails config validation; the key must be absent instead.
    expect((await readConfig()).repos).toBeUndefined();
  });

  it('reports a name that is not registered', async () => {
    const result = await repoAccessHandler.execute(ctx(['remove', '--name', 'absent']));
    expect(result.exitCode).toBe(1);
  });
});

describe('repo-access audit (#2531)', () => {
  it('reports git subdirectories that carry no manifest entry', async () => {
    await fs.mkdir(path.join(root, 'listed', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'unlisted', '.git'), { recursive: true });
    await repoAccessHandler.execute(
      ctx(['add', '--path', './listed', '--name', 'listed', '--allow', 'read']),
    );

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((v) => lines.push(String(v)));
    const result = await repoAccessHandler.execute(ctx(['audit']));
    spy.mockRestore();

    const output = lines.join('\n');
    expect(output).toContain('unlisted');
    expect(output).not.toMatch(/^\s+- listed$/m);
    // Non-zero so the audit can gate CI.
    expect(result.exitCode).toBe(1);
  });
});
