// Regression coverage for update selection and scoped config persistence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';
import { updateHandler } from '../../../../src/cli/handlers/utilities.js';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
const { deploy } = vi.hoisted(() => ({ deploy: vi.fn() }));
vi.mock('../../../../src/cli/handlers/use.js', () => ({ useHandler: { execute: deploy } }));

describe('update installed authority', () => {
  let root: string;
  let ctx: HandlerContext;
  let log: ReturnType<typeof vi.spyOn>;
  let originalHome: string | undefined;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-update-selection-'));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    await fs.mkdir(path.join(root, '.aiwg/frameworks'), { recursive: true });
    await fs.writeFile(path.join(root, '.aiwg/frameworks/registry.json'), JSON.stringify({ frameworks: [
      { id: 'sdlc-complete' }, { id: 'media-marketing-kit' },
    ] }));
    ctx = { args: ['--skip-check'], rawArgs: [], cwd: root, frameworkRoot: root };
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    deploy.mockReset().mockResolvedValue({ exitCode: 0 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function config(installed?: Record<string, unknown>) {
    const value = { ...emptyConfig(), installed };
    await fs.writeFile(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(value));
    return fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8');
  }
  const entry = { version: '1', source: 'bundled', installedAt: '2026-01-01', deployedTo: {} };
  const output = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().join('\n');

  it('deploys only config entries and reports stale registry frameworks', async () => {
    const before = await config({ 'custom-addon': entry });
    await updateHandler.execute(ctx);
    expect(deploy.mock.calls.map(([c]) => c.args[0])).toEqual(['custom-addon']);
    expect(output(log)).toContain('Skipped legacy registry frameworks: sdlc-complete, media-marketing-kit');
    expect(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8')).toBe(before);
  });
  it('treats an empty installed block as authoritative', async () => {
    const before = await config({});
    await updateHandler.execute(ctx);
    expect(deploy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8')).toBe(before);
  });
  it('reports legacy fallback only when installed is absent', async () => {
    await config();
    await updateHandler.execute(ctx);
    expect(deploy.mock.calls.map(([c]) => c.args[0])).toEqual(['sdlc', 'marketing']);
    expect(output(log)).toContain('Legacy fallback');
  });
  it('keeps agreeing aliases and passes the provider through', async () => {
    await config({ sdlc: entry, marketing: entry });
    ctx.args.push('--provider', 'codex');
    await updateHandler.execute(ctx);
    expect(deploy.mock.calls.map(([c]) => c.args)).toEqual([
      ['sdlc', '--provider', 'codex'], ['marketing', '--provider', 'codex'],
    ]);
    expect(output(log)).not.toContain('Skipped');
  });
  it('shows the exact dry-run commands and disagreement without writes', async () => {
    const before = await config({ 'research-complete': entry });
    ctx.args.push('--dry-run', '--provider', 'codex');
    await updateHandler.execute(ctx);
    expect(output(log)).toContain('aiwg use research --provider codex');
    expect(output(log)).toContain('Skipped legacy registry frameworks: sdlc-complete, media-marketing-kit');
    expect(deploy).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8')).toBe(before);
  });
  it.each([{ flags: [] }, { flags: ['--all'] }])('prevents use config writes from adding entries with flags %j', async ({ flags }) => {
    await config({ 'sdlc-complete': entry });
    deploy.mockImplementation(async () => {
      const value = emptyConfig();
      value.installed = { sdlc: entry, marketing: entry } as typeof value.installed;
      await writeAiwgConfig(root, value);
      return { exitCode: 0 };
    });
    ctx.args.push(...flags);
    await updateHandler.execute(ctx);
    const after = JSON.parse(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
    expect(after.installed).toEqual({ 'sdlc-complete': entry });
  });
  it('refreshes existing metadata and releases the guard for explicit use writes', async () => {
    await config({ sdlc: entry });
    const value = emptyConfig();
    value.installed = { sdlc: { ...entry, version: '2' }, marketing: entry } as typeof value.installed;
    deploy.mockImplementation(async () => {
      await writeAiwgConfig(root, value);
      return { exitCode: 0 };
    });
    await updateHandler.execute(ctx);
    const after = JSON.parse(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
    expect(after.installed).toEqual({ sdlc: { ...entry, version: '2' } });
    await writeAiwgConfig(root, value);
    const explicit = JSON.parse(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
    expect(explicit.installed).toEqual(value.installed);
  });
  it('does not promote legacy fallback entries into config', async () => {
    await config();
    deploy.mockImplementation(async () => {
      const value = emptyConfig();
      value.installed = { sdlc: entry } as typeof value.installed;
      await writeAiwgConfig(root, value);
      return { exitCode: 0 };
    });
    await updateHandler.execute(ctx);
    const after = JSON.parse(await fs.readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
    expect(after).not.toHaveProperty('installed');
  });
  it('refuses malformed config instead of falling back', async () => {
    await fs.writeFile(path.join(root, '.aiwg/aiwg.config'), '{bad');
    const result = await updateHandler.execute(ctx);
    expect(result.exitCode).not.toBe(0);
    expect(deploy).not.toHaveBeenCalled();
  });
});
