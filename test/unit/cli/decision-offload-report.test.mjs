import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWorkspaceStatus } from '../../../tools/cli/workspace-status.mjs';
import { collectDecisionOffloadReport, formatDecisionOffloadReport } from '../../../tools/cli/decision-offload-report.mjs';

describe('offline decision-offload reporting', () => {
  it('exposes the real shared snapshot without probing or creating a journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-offload-report-'));
    const saved = process.env.AIWG_CONFIG;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network must not be used by offline reports'); });
    try {
      process.env.AIWG_CONFIG = join(root, 'user');
      mkdirSync(join(root, '.aiwg'), { recursive: true });
      writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ decision: { enabled: false } }));
      const report = await collectDecisionOffloadReport(root);
      expect(report.schema).toBe('aiwg-decision-offload-snapshot/v1');
      expect(report.readiness.evaluate.state).toBe('disabled');
      expect(report.opportunities.organic.observed).toBe(0);
      expect(report.drift.status).not.toBe('ok');
      const status = await buildWorkspaceStatus(root);
      expect(status.decisionOffload.schema).toBe(report.schema);
      expect(status.decisionOffload.opportunities).toEqual(report.opportunities);
      expect(network).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.aiwg', 'decision', 'opportunities.jsonl'))).toBe(false);
      expect(existsSync(join(root, '.aiwg', 'decision', 'ledger.jsonl'))).toBe(false);
      const lines = formatDecisionOffloadReport(report).join('\n');
      expect(lines).toContain('offline, advisory');
      expect(lines).toContain('no probe');
      expect(lines).toContain('excluded from organic adoption');
    } finally {
      network.mockRestore();
      if (saved === undefined) delete process.env.AIWG_CONFIG; else process.env.AIWG_CONFIG = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps doctor and steward offline entrypoints from initializing installation state', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aiwg-offload-readonly-'));
    try {
      const project = join(fixture, 'project');
      mkdirSync(project);
      const router = pathToFileURL(resolve(import.meta.dirname, '../../../dist/src/cli/router.js')).href;
      const entry = 'const {run}=await import(process.argv[1]);await run(process.argv.slice(2),{cwd:process.cwd()});process.exit(process.exitCode??0);';
      for (const args of [['doctor', '--decision-offload', '--json'], ['steward', 'decision-offload', '--json']]) {
        const user = join(fixture, args[0]);
        const env = { ...process.env, HOME: join(user, 'home'), XDG_CONFIG_HOME: join(user, 'xdg'),
          AIWG_CONFIG: join(user, 'config'), AIWG_USER_REGISTRY_PATH: join(user, 'registry.json'), AIWG_NO_UPDATE_CHECK: '1' };
        delete env.AIWG_DECISION_JEV_API_KEY;
        delete env.JEV_API_KEY;
        const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', entry, router, ...args], {
          cwd: project, env, encoding: 'utf8', timeout: 10_000,
        });
        expect(JSON.parse(result.stdout).decisionOffload.schema).toBe('aiwg-decision-offload-snapshot/v1');
        expect(existsSync(user) ? readdirSync(user, { recursive: true }) : []).toEqual([]);
        expect(existsSync(join(user, 'config', 'installation.json'))).toBe(false);
        expect(existsSync(join(user, 'config', 'config.json'))).toBe(false);
        expect(existsSync(join(project, '.aiwg'))).toBe(false);
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

});
