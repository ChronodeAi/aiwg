import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileWithCapture as execFileSync } from '../../helpers/exec-file-capture.js';

const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-grokbot-delivery-'));
  roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.cpSync(path.join(repo, 'test/fixtures/rule-delivery'), source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  return { root, source, target };
}

// Project-scope grokbot is bridge-only: native skills stay unwritten without
// AIWG_GROKBOT_SKILLS_DIR, and paths.skills is a getter-only accessor.
function deploy(source: string, target: string, args: string[] = []) {
  const home = path.join(target, '../home');
  fs.mkdirSync(home, { recursive: true });
  return execFileSync('node', [path.join(repo, 'tools/agents/deploy-agents.mjs'), '--source', source,
    '--target', target, '--provider', 'grokbot', '--mode', 'all', '--kernel-only',
    '--skip-commands-migration', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HOME: home, AIWG_ROOT: source,
      AIWG_RULES_INLINE_BUDGET_TOKENS: '0', AIWG_GROKBOT_SKILLS_DIR: '',
    },
  });
}

describe('grokbot project-scope rule delivery (#3648)', () => {
  it('deploys the bridge without writing through getter-only paths.skills', () => {
    const { source, target } = setup();
    // Throws with the child stderr attached when the deploy fails, so a
    // getter-assignment crash fails here with 'only a getter' in the message.
    const stdout = deploy(source, target);
    expect(stdout).not.toContain('only a getter');
    expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.cursor'))).toBe(false);
  }, 90_000);

  it('leaves the provider skills getter intact after staging and restore', async () => {
    const { source, target } = setup();
    deploy(source, target);
    const grokbot = await import('../../../tools/agents/providers/grokbot.mjs');
    const descriptor = Object.getOwnPropertyDescriptor(grokbot.paths, 'skills');
    expect(typeof descriptor?.get).toBe('function');
    expect(descriptor?.set).toBeUndefined();
  }, 90_000);
});
