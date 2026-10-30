import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler } from '../../../src/cli/handlers/models.js';
import { diagnoseDirectWorkerReadiness } from '../../../src/models/worker-direct-readiness.js';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { managedMcWorkerFixture } from '../../fixtures/managed-mc-worker.js';
import { qualificationRows } from '../../../tools/testing/managed-pilot.mjs';

const mocks = vi.hoisted(() => ({ cli: vi.fn() }));
vi.mock('../../../src/mcp/helpers.mjs', async original => ({
  ...await original<typeof import('../../../src/mcp/helpers.mjs')>(), runAiwgCli: mocks.cli,
}));
// @ts-expect-error — .mjs tool registration has no declaration
import { registerWorkerResolveTool } from '../../../src/mcp/tools/orchestration.mjs';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('T-OG-12 two-conductor eligibility conformance', () => {
  it.each(['managed', 'direct', 'missing-activation', 'stale-activation', 'denied-effort', 'unqualified', 'disabled'] as const)(
    'gives Claude and Codex shell/MCP front ends identical %s eligibility without dispatch', async vector => {
      const root = await mkdtemp(join(tmpdir(), 'conductor-conformance-')); roots.push(root);
      const f = await managedMcWorkerFixture(root);
      // Public resolve previews eligibility; only the trusted MC/Flow caller supplies managed task authority.
      await writeFile(f.paths.brief, 'Bounded synthetic implementation task.');
      if (vector === 'direct') { f.cfg.parallelism!.worker_mode = 'direct'; delete f.cfg.parallelism!.activation; }
      if (vector === 'missing-activation') delete f.cfg.parallelism!.activation;
      if (vector === 'stale-activation') f.cfg.parallelism!.max_parallel_subagents = 2;
      if (vector === 'denied-effort') {
        f.snapshot.models.defaults.workerSelection!.guards!.deniedEfforts = ['medium', 'high', 'ultra'];
      }
      if (vector === 'unqualified') for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.qualification.status = 'unqualified';
      if (vector === 'disabled') f.cfg.parallelism!.worker_dispatch = false;
      const build = vi.spyOn(f.drivers.codex, 'buildInvocation');
      const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => f.now });
      const cli = async (args: string[]) => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const result = await handler.execute({ args: args.slice(1), rawArgs: args, cwd: root, frameworkRoot: process.cwd() });
          return { code: result.exitCode, stdout: String(output.mock.calls.at(-1)?.[0] ?? ''), stderr: String(error.mock.calls.at(-1)?.[0] ?? '') };
        } finally { output.mockRestore(); error.mockRestore(); }
      };
      mocks.cli.mockImplementation(cli);
      let tool: any;
      registerWorkerResolveTool({ registerTool(_name: string, config: any, callback: any) { tool = { config, callback }; } });
      const input = { role: 'coding', task: 'implementation', group: 'workers', brief: f.paths.brief,
        workdir: f.paths.workdir, final_output: f.paths.final, transport: 'shell', project_dir: root };
      const args = ['models', 'resolve', ...Object.entries(input).filter(([key]) => key !== 'project_dir')
        .map(([key, value]) => `--${key.replace('_', '-')}=${value}`), '--format=json'];
      const before = await readdir(root, { recursive: true });
      const artifacts = [f.paths.brief, f.paths.intent, f.paths.decision, f.paths.dispatch];
      const bytes = await Promise.all(artifacts.map(file => readFile(file, 'utf8')));
      const shell = await cli(args);
      const expected = JSON.parse(shell.stdout);
      for (const conductor of ['claude', 'codex']) {
        const response = await tool.callback(tool.config.inputSchema.parse(input));
        expect(JSON.parse(response.content[0].text), conductor).toEqual(expected);
        expect(response.isError === true, conductor).toBe(shell.code !== 0);
      }
      expect(await readdir(root, { recursive: true })).toEqual(before);
      expect(await Promise.all(artifacts.map(file => readFile(file, 'utf8')))).toEqual(bytes);
      if (vector === 'direct') {
        expect(shell.code).toBe(0);
        expect(expected.invocation.mode).toBe('direct');
      } else {
        expect(shell.code).toBe(2);
        expect(build).not.toHaveBeenCalled();
        if (vector === 'managed') {
          expect(expected.status).toBe('eligible');
          expect(expected.diagnostics).toContainEqual(expect.objectContaining({ pointer: '/request/managedIntent' }));
        }
      }
    });

  it('keeps every advertised provider visible with offline qualification findings for both conductors', async () => {
    const registry = loadProviderModelCapabilities();
    const clis = Object.fromEntries(PROVIDER_IDS.map(id => [id, { adapter: `providers:${id}`, accountScope: 'synthetic', quotaScope: 'synthetic' }]));
    const input = { parallelism: { worker_dispatch: true, worker_mode: 'managed' as const, clis }, registry };
    const claude = await diagnoseDirectWorkerReadiness(input);
    const codex = await diagnoseDirectWorkerReadiness(input);
    const dispatch = claude.findings.filter(row => row.kind === 'dispatch');
    expect(codex).toEqual(claude);
    expect(dispatch.map(row => row.cli).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(dispatch.every(row => row.eligibility === 'blocked' && row.message.length > 0)).toBe(true);
    const routes = [...PROVIDER_IDS.flatMap(id => [`${id}/shell`, `${id}/bridge`, `${id}/native-mcp`]), 'local/http'];
    const report = qualificationRows(routes);
    expect(report).toHaveLength(routes.length);
    expect(report.every(row => row.status === 'blocked' && row.reason)).toBe(true);
    for (const route of ['codex/shell', 'muse/shell', 'claude/shell', 'hermes/shell', 'local/http']) {
      expect(report).toContainEqual(expect.objectContaining({ id: route, qualification: 'missing', status: 'blocked' }));
    }
  });
});
