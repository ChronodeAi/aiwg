import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { sourceRules } from '../unit/providers/rule-source-expectations.js';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');

function deployHermes(projectDir: string, homeDir: string, source?: string): void {
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
      '--provider', 'hermes',
      '--mode', 'sdlc',
      '--target', projectDir,
      '--deploy-skills',
      '--deploy-rules',
      ...(source ? ['--source', source] : []),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
}

describe('Hermes deployment', () => {
  it('delivers rules through AGENTS.md and CLI pointers without requiring MCP', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-hermes-project-'));
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-hermes-home-'));
    try {
      execFileSync('git', ['init'], { timeout: 60_000, cwd: projectDir, stdio: 'pipe' });
      // ADR: the complete selected SDLC kernel currently exceeds Hermes's
      // hard cap. Reject it atomically rather than compressing/dropping rules.
      expect(() => deployHermes(projectDir, homeDir)).toThrow(/19000/);
      expect(existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(false);
      const source = path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils');
      deployHermes(projectDir, homeDir, source);

      const agentsMd = await fs.readFile(path.join(projectDir, 'AGENTS.md'), 'utf8');
      const rules = sourceRules(REPO_ROOT, 'addons').filter(rule => rule.file.startsWith(source + path.sep) && !rule.structural);
      for (const rule of rules) {
        if (rule.activation === 'kernel') {
          expect(agentsMd).toContain(`## Rule: ${rule.data.name || rule.name}`);
          expect(agentsMd).toContain(rule.body);
        } else if (rule.activation === 'summary') {
          expect(agentsMd).toContain(rule.data.summary);
          expect(agentsMd).toContain(`aiwg show rule ${rule.data.name || rule.name}`);
          expect(agentsMd).not.toContain(rule.body);
        }
      }
      expect(agentsMd.length).toBeLessThanOrEqual(19000);
      expect(agentsMd).not.toContain('<!-- AIWG:bound-rules:start -->');
      expect(agentsMd).toContain('aiwg show rule <name>');
      expect(agentsMd).toContain('aiwg discover "rule <topic>" --type rule');
      expect(agentsMd).toContain('MCP is optional');
      expect(agentsMd).toContain('mcp_aiwg_rule_show');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
