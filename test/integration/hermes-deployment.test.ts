import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { sourceRules, sdlcDeploymentRules } from '../unit/providers/rule-source-expectations.js';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');

function deployHermes(projectDir: string, homeDir: string, mode: string, source?: string): void {
  const config = path.join(homeDir, 'config');
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, 'channel.json'), JSON.stringify({
    channel: 'edge', edgePath: REPO_ROOT, devMode: true, checkOnStartup: false,
  }));
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, HERMES_HOME: path.join(homeDir, '.hermes'),
    AIWG_CONFIG: config, XDG_DATA_HOME: path.join(homeDir, 'data'), XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(homeDir, 'cache'), XDG_STATE_HOME: path.join(homeDir, 'state') };
  delete env.AIWG_HOME;
  delete env.AIWG_ROOT;
  execFileSync(
    process.execPath,
    mode === 'all' ? [path.join(REPO_ROOT, 'bin/aiwg.mjs'), 'use', 'all', '--provider', 'hermes'] : [
      path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
      '--provider', 'hermes',
      '--mode', mode,
      '--target', projectDir,
      '--deploy-skills',
      '--deploy-rules',
      ...(source ? ['--source', source] : []),
    ],
    {
      cwd: mode === 'all' ? projectDir : REPO_ROOT,
      env,
      stdio: 'pipe',
      timeout: 240_000,
    },
  );
}

describe('Hermes deployment', () => {
  it.each(['sdlc', 'all', 'utils'])('%s delivers the selected Hermes startup contract under the cap', async mode => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-hermes-project-'));
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-hermes-home-'));
    try {
      execFileSync('git', ['init'], { timeout: 60_000, cwd: projectDir, stdio: 'pipe' });
      const source = mode === 'utils' ? path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils') : undefined;
      deployHermes(projectDir, homeDir, mode === 'utils' ? 'sdlc' : mode, source);

      const agentsMd = await fs.readFile(path.join(projectDir, 'AGENTS.md'), 'utf8');
      if (mode !== 'all') {
        const rules = mode === 'utils'
          ? sourceRules(REPO_ROOT, 'addons').filter(rule => rule.file.startsWith(source! + path.sep) && !rule.structural)
          : sdlcDeploymentRules(REPO_ROOT);
        const index = await fs.readFile(path.join(projectDir, '.hermes/rules/RULES-INDEX.md'), 'utf8');
        const reached = agentsMd.includes('read and follow `.hermes/rules/RULES-INDEX.md`') ? agentsMd + '\n' + index : agentsMd;
        for (const rule of rules) {
          if (rule.activation === 'kernel' && rule.data.enforcement === 'critical') {
            expect(agentsMd).toContain(`## Rule: ${rule.data.name || rule.name}`);
            expect(agentsMd).toContain(rule.body);
          } else if (['kernel', 'summary'].includes(rule.activation)) {
            const context = rule.activation === 'kernel' ? agentsMd : reached;
            expect(context).toContain(rule.data.summary || 'Fetch and follow the full rule before governed work.');
            expect(context).toContain(`aiwg show rule ${rule.data.name || rule.name}`);
            expect(agentsMd).not.toContain(rule.body);
          }
        }
      }
      const hermesMd = await fs.readFile(path.join(projectDir, '.hermes.md'), 'utf8');
      console.info(`Hermes ${mode}: AGENTS.md=${agentsMd.length}, .hermes.md=${hermesMd.length} chars`);
      expect(hermesMd.length).toBeLessThanOrEqual(19000);
      if (mode !== 'all') expect(agentsMd).toContain('Before every task and subagent task, fetch and follow');
      expect(agentsMd.length).toBeLessThanOrEqual(19000);
      expect(agentsMd).not.toContain('<!-- AIWG:bound-rules:start -->');
      if (mode === 'all') {
        expect(agentsMd).toContain('WORKSPACE.md');
        return;
      }
      expect(agentsMd).toContain('aiwg show rule <name>');
      expect(agentsMd).toContain('aiwg discover "rule <topic>" --type rule');
      expect(agentsMd).toContain('MCP is optional');
      expect(agentsMd).toContain('mcp_aiwg_rule_show');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 310_000);
});
