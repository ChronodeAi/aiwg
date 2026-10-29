// Fresh regeneration must install compact core policy without a prior deploy.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate } from '../../../src/smiths/context-pipeline/index.js';
import { parseRuleFrontmatter, readCoreBody } from '../../../src/rules/activation.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('fresh core generation (#3740 F3)', () => {
  it.each(['codex', 'hermes', 'warp', 'copilot', 'claude'] as const)('%s writes current core policy on every generated startup', async provider => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-fresh-core-')); roots.push(projectPath);
    const result = await generate({ provider, projectPath, sections: [], detectExistingFiles: true });
    const dir = path.resolve(__dirname, '../../../agentic/code/addons/aiwg-utils/rules');
    const cores = (await fs.readdir(dir)).filter(file => file.endsWith('.md') && !file.endsWith('.core.md'));
    const bodies = [];
    for (const name of cores) if (parseRuleFrontmatter(await fs.readFile(path.join(dir, name), 'utf8')).rule?.activation === 'core') bodies.push(readCoreBody(path.join(dir, name)));
    expect(bodies.length).toBeGreaterThan(0);
    const startups = [...(result.agentsMdPath ? [result.agentsMdPath] : []), ...result.twinPaths,
      ...(result.claudeMdHookPath ? [result.claudeMdHookPath] : [])];
    expect(startups.length).toBeGreaterThan(0);
    for (const file of startups) {
      const content = await fs.readFile(file, 'utf8');
      expect(content.match(/AIWG:rule-core:start/g)).toHaveLength(1);
      for (const body of bodies) expect(content).toContain(body);
    }
    const before = await Promise.all(startups.map(file => fs.readFile(file, 'utf8')));
    await generate({ provider, projectPath, sections: [], detectExistingFiles: true });
    expect(await Promise.all(startups.map(file => fs.readFile(file, 'utf8')))).toEqual(before);
    expect(await fs.readFile(path.join(projectPath, 'AIWG.md'), 'utf8')).not.toContain('AIWG:rule-core:start');
  });

  it('adds core to operator-owned bridges and twins while preserving operator text', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-operator-core-')); roots.push(projectPath);
    for (const name of ['AGENTS.md', '.hermes.md']) await fs.writeFile(path.join(projectPath, name), 'Operator instructions.\n');
    await generate({ provider: 'hermes', projectPath, sections: [], detectExistingFiles: true });
    for (const name of ['AGENTS.md', '.hermes.md']) {
      const content = await fs.readFile(path.join(projectPath, name), 'utf8');
      expect(content).toContain('Operator instructions.\n');
      expect(content).toContain('AIWG:rule-core:start');
    }
  });

  it('does not duplicate core in CLAUDE.md when native .claude/rules core files are deployed', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-native-core-')); roots.push(projectPath);
    await fs.mkdir(path.join(projectPath, '.claude', 'rules'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.claude', 'rules', 'core-anti-laziness.md'), '<!-- aiwg:managed test -->\n# Core: Anti-Laziness\n');
    const result = await generate({ provider: 'claude', projectPath, sections: [], detectExistingFiles: true });
    const file = result.claudeMdHookPath ?? path.join(projectPath, 'CLAUDE.md');
    expect(await fs.readFile(file, 'utf8')).not.toContain('AIWG:rule-core:start');
  });
});
