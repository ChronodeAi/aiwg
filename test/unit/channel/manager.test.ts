import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getVersionInfo,
  getPackageRoot,
  resolveEffectiveInstallationRoot,
  resolveMcpServerEntrypointPath,
} from '../../../src/channel/manager.mjs';

describe('getVersionInfo launcher/runtime identity', () => {
  let root: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(devMode: boolean, runtimeVersion: string | null = '2026.10.3') {
    root = mkdtempSync(join(tmpdir(), 'aiwg-version-'));
    const launcher = join(root, 'launcher');
    const runtime = join(root, 'runtime');
    mkdirSync(launcher);
    mkdirSync(runtime);
    writeFileSync(join(launcher, 'package.json'), JSON.stringify({ version: '2026.9.20' }));
    if (runtimeVersion) writeFileSync(join(runtime, 'package.json'), JSON.stringify({ version: runtimeVersion }));
    writeFileSync(join(root, 'channel.json'), JSON.stringify({ channel: devMode ? 'edge' : 'stable', devMode, edgePath: runtime }));
    vi.stubEnv('AIWG_CONFIG', root);
    vi.stubEnv('AIWG_LAUNCHER_ROOT', launcher);
    vi.stubEnv('AIWG_CLI_DRY_RUN', '1');
    return { launcher, runtime };
  }

  it('reports the launcher and effective edge runtime while preserving the executing version', async () => {
    const { runtime } = setup(true);
    expect(await getVersionInfo()).toMatchObject({
      version: JSON.parse(readFileSync(join(getPackageRoot(), 'package.json'), 'utf8')).version,
      launcherVersion: '2026.9.20', runtimeVersion: '2026.10.3', runtimePath: runtime,
    });
  });

  it('ignores the edge path outside dev mode', async () => {
    const { launcher } = setup(false);
    expect(await getVersionInfo()).toMatchObject({
      launcherVersion: '2026.9.20', runtimeVersion: '2026.9.20', runtimePath: launcher,
    });
  });

  it('reports matching versions without hiding the runtime path', async () => {
    const { runtime } = setup(true, '2026.9.20');
    expect(await getVersionInfo()).toMatchObject({
      launcherVersion: '2026.9.20', runtimeVersion: '2026.9.20', runtimePath: runtime,
    });
  });

  it('reports an unreadable runtime version as unknown', async () => {
    const { runtime } = setup(true, null);
    expect(await getVersionInfo()).toMatchObject({ runtimeVersion: '(unknown)', runtimePath: runtime });
  });
});

// Config-driven version stamps: user-facing CLI output (the `aiwg use` version
// stamp, `aiwg diagnose` bug-report link, the entrypoint packaging-bug message)
// must source their URLs from package.json — the single public source of truth —
// not hardcode the internal build origin (git.integrolabs.net). These assertions
// guard against a regression to a hardcoded literal or an origin leak.
describe('getVersionInfo public URLs (config-driven from package.json)', () => {
  it('surfaces the public repo, homepage, and issues URLs', async () => {
    const info = await getVersionInfo();
    expect(info.repoUrl).toBe('github.com/jmagly/aiwg');
    expect(info.homepage).toBe('https://aiwg.io');
    expect(info.issuesUrl).toBe('https://github.com/jmagly/aiwg/issues');
  });

  it('never leaks the internal build origin into user-facing fields', async () => {
    const info = await getVersionInfo();
    expect(info.repoUrl).not.toContain('integrolabs');
    expect(info.homepage).not.toContain('integrolabs');
    expect(info.issuesUrl).not.toContain('integrolabs');
  });
});

// #276 — the MCP server health check must resolve the exact same root
// bin/aiwg.mjs's resolveRouterPath() picks, not re-derive its own notion of
// "either file exists". These are the production functions doctor.mjs calls
// directly (tools/cli/doctor.mjs #8 "Check MCP server"), not a re-implemented
// predicate.
describe('resolveEffectiveInstallationRoot (shared with bin/aiwg.mjs resolveRouterPath)', () => {
  it('npm/installed layout: no devMode — uses the package root', () => {
    const packageRoot = '/opt/node_modules/aiwg';
    expect(resolveEffectiveInstallationRoot(packageRoot, { devMode: false, edgePath: undefined })).toBe(packageRoot);
  });

  it('source checkout, not in dev mode — still uses the package root', () => {
    const packageRoot = '/home/user/dev/aiwg';
    expect(resolveEffectiveInstallationRoot(packageRoot, { devMode: false, edgePath: '/home/user/.aiwg/edge' })).toBe(packageRoot);
  });

  it('dev-mode install with a distinct edge checkout — uses the edge path', () => {
    const packageRoot = '/opt/node_modules/aiwg';
    const edgePath = '/home/user/dev/aiwg-checkout';
    expect(resolveEffectiveInstallationRoot(packageRoot, { devMode: true, edgePath })).toBe(edgePath);
  });

  it('dev-mode true but edgePath equals the package root — uses the package root', () => {
    const packageRoot = '/home/user/dev/aiwg';
    expect(resolveEffectiveInstallationRoot(packageRoot, { devMode: true, edgePath: packageRoot })).toBe(packageRoot);
  });

  it('dev-mode true with no edgePath configured — uses the package root', () => {
    const packageRoot = '/opt/node_modules/aiwg';
    expect(resolveEffectiveInstallationRoot(packageRoot, { devMode: true, edgePath: undefined })).toBe(packageRoot);
  });
});

describe('resolveMcpServerEntrypointPath (production resolver doctor.mjs calls)', () => {
  it('npm layout: resolves to <packageRoot>/dist/src/mcp/server.mjs', () => {
    const packageRoot = '/opt/node_modules/aiwg';
    expect(resolveMcpServerEntrypointPath(packageRoot, { devMode: false })).toBe(
      join(packageRoot, 'dist', 'src', 'mcp', 'server.mjs'),
    );
  });

  it('source checkout (not dev mode): resolves under the checkout root', () => {
    const packageRoot = '/home/user/dev/aiwg';
    expect(resolveMcpServerEntrypointPath(packageRoot, { devMode: false, edgePath: '/home/user/.aiwg/edge' })).toBe(
      join(packageRoot, 'dist', 'src', 'mcp', 'server.mjs'),
    );
  });

  it('dev root: resolves under the edge checkout, not the installed package', () => {
    const packageRoot = '/opt/node_modules/aiwg';
    const edgePath = '/home/user/dev/aiwg-checkout';
    expect(resolveMcpServerEntrypointPath(packageRoot, { devMode: true, edgePath })).toBe(
      join(edgePath, 'dist', 'src', 'mcp', 'server.mjs'),
    );
  });

  // The resolved path is always the compiled one — never src/mcp/server.mjs
  // — so a layout with a missing compiled server but surviving source
  // correctly resolves to (and reports) the missing file.
  describe('missing compiled server with surviving source', () => {
    const roots: string[] = [];
    afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

    function fixtureRoot(): string {
      const root = mkdtempSync(join(tmpdir(), 'aiwg-mcp-entrypoint-'));
      roots.push(root);
      mkdirSync(join(root, 'src', 'mcp'), { recursive: true });
      writeFileSync(join(root, 'src', 'mcp', 'server.mjs'), '// source server survives\n');
      return root;
    }

    it('npm/checkout layout: resolved path does not exist even though src/mcp/server.mjs does', () => {
      const packageRoot = fixtureRoot();
      const resolved = resolveMcpServerEntrypointPath(packageRoot, { devMode: false });
      expect(resolved).toBe(join(packageRoot, 'dist', 'src', 'mcp', 'server.mjs'));
      expect(existsSync(resolved)).toBe(false);
      expect(existsSync(join(packageRoot, 'src', 'mcp', 'server.mjs'))).toBe(true);
    });

    it('dev-mode layout: resolved path under the edge checkout does not exist even though its src/ survives', () => {
      const packageRoot = '/opt/node_modules/aiwg';
      const edgePath = fixtureRoot();
      const resolved = resolveMcpServerEntrypointPath(packageRoot, { devMode: true, edgePath });
      expect(resolved).toBe(join(edgePath, 'dist', 'src', 'mcp', 'server.mjs'));
      expect(existsSync(resolved)).toBe(false);
      expect(existsSync(join(edgePath, 'src', 'mcp', 'server.mjs'))).toBe(true);
    });

    it('becomes present once the compiled server is actually built', () => {
      const packageRoot = fixtureRoot();
      const resolved = resolveMcpServerEntrypointPath(packageRoot, { devMode: false });
      expect(existsSync(resolved)).toBe(false);
      mkdirSync(join(packageRoot, 'dist', 'src', 'mcp'), { recursive: true });
      writeFileSync(resolved, '// compiled server\n');
      expect(existsSync(resolved)).toBe(true);
    });
  });
});
