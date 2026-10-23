import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = mkdtempSync(join(tmpdir(), 'aiwg-doctor-b4-'));
const home = join(root, 'home');
mkdirSync(home);
const env = {
  ...process.env, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
  AIWG_ROOT: repo, AIWG_HOME: repo, NO_COLOR: '1',
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(project: string, relative: string, content = '# Fixture\n') {
  const file = join(project, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(provider: string, agents: number | null = 0, bundle = 'all') {
  const project = mkdtempSync(join(root, 'project-'));
  put(project, '.aiwg/aiwg.config', JSON.stringify({
    version: '1.0', providers: [provider], scripts: {},
    installed: agents === null ? {} : {
      [bundle]: { version: '2026.10.5', source: 'bundled', installedAt: '2026-10-23T00:00:00Z',
        deployedTo: { [provider]: { agents, commands: 0, rules: 1, skills: 26 } } },
    },
  }));
  return project;
}

async function doctor(project: string, provider?: string) {
  const args = [join(repo, 'tools/cli/doctor.mjs'), '--no-budget-check'];
  if (provider) args.push('--provider', provider);
  // Files also work in sandboxes that prohibit Node's socket-backed stdio
  // pipes. Execute the real doctor and retain both output and exit status.
  const stdoutFile = join(project, 'doctor-stdout.log');
  const stderrFile = join(project, 'doctor-stderr.log');
  const stdoutFd = openSync(stdoutFile, 'w');
  const stderrFd = openSync(stderrFile, 'w');
  let result: { code: number | null; signal: string | null };
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: project, env, timeout: 120_000, stdio: ['ignore', stdoutFd, stderrFd],
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutFile, 'utf8');
  const stderr = readFileSync(stderrFile, 'utf8');
  expect(result.signal, stderr).toBeNull();
  expect([0, 1], stderr).toContain(result.code);
  // Even an unrelated workspace error must include the completed report.
  expect(stdout, stderr).toMatch(/(?:FAIL|WARN|OK) /);
  return stdout;
}

describe('doctor deployed agent counts (#3462, #3465)', () => {
  it.each(['claude', 'codex'])('treats empty %s agents as healthy for kernel-only receipts', async provider => {
    const project = fixture(provider);
    mkdirSync(join(project, `.${provider}/agents`), { recursive: true });
    put(project, `.${provider}/rules/kernel.md`);
    const out = await doctor(project, provider);
    expect(out).toContain('✓ ' + (provider === 'claude' ? 'Claude Code' : 'Codex') + ' Agents: 0 agents deployed');
    expect(out).toContain('expected: installed deployments provide no agents');
    expect(out).not.toContain('Half-deployed tree');
    expect(out).not.toContain('Recorded deployment drift');
    expect(out).not.toContain(`aiwg use sdlc --provider ${provider}`);
  }, 150_000);

  it('treats an absent kernel-only agent directory as expected', async () => {
    const project = fixture('claude');
    put(project, '.claude/rules/kernel.md');
    const out = await doctor(project, 'claude');
    expect(out).toContain('✓ Claude Code Agents: 0 agents deployed');
    expect(out).not.toContain('Half-deployed tree');
    expect(out).not.toContain('aiwg use sdlc');
  }, 150_000);

  it.each([true, false])('warns for recorded SDLC agents missing from disk (directory exists: %s)', async exists => {
    const project = fixture('claude', 12, 'sdlc');
    if (exists) mkdirSync(join(project, '.claude/agents'), { recursive: true });
    put(project, '.claude/rules/framework.md');
    const out = await doctor(project, 'claude');
    expect(out).toContain('⚠ Claude Code Deployment consistency: Half-deployed tree');
    expect(out).toContain('⚠ Claude Code Recorded deployment drift:');
    expect(out).toContain('sdlc (12)');
  }, 150_000);

  it('preserves the legacy warning when there is no deployment receipt', async () => {
    const project = fixture('claude', null);
    mkdirSync(join(project, '.claude/agents'), { recursive: true });
    put(project, '.claude/commands/framework.md');
    expect(await doctor(project, 'claude')).toContain('Half-deployed tree');
  }, 150_000);

  it('counts only agent files under the selected provider path', async () => {
    const project = fixture('codex', 26, 'sdlc');
    put(project, '.codex/agents/one.toml', 'developer_instructions = "Agent"\n');
    put(project, '.codex/agents/one.soul.md');
    mkdirSync(join(project, '.codex/agents/not-an-agent.md'), { recursive: true });
    put(project, '.claude/agents/unrelated.md');
    put(project, 'unrelated.md');
    const out = await doctor(project, 'codex');
    expect(out).toContain('Codex Agents: 1 agents deployed (.codex/agents/)');
    expect(out).not.toContain('26 agents deployed');
    expect(out).not.toContain('Recorded deployment drift');
  }, 150_000);

  it('preserves the indexed-only Muse agent surface', async () => {
    const out = await doctor(fixture('muse', 26), 'muse');
    expect(out).toContain('Muse Code Agents: 0 agents deployed on disk — no native agent surface');
    expect(out).not.toContain('Unknown provider: muse');
    expect(out).not.toContain('Muse Code Recorded deployment drift:');
  }, 150_000);

  it('reports aggregate context separately from standalone agent counts', async () => {
    const project = fixture('hermes', 26);
    put(project, 'AGENTS.md', '# Context bridge, not 26 agent files\n');
    const out = await doctor(project, 'hermes');
    expect(out).toContain('Hermes Agents: Aggregated context at AGENTS.md (no standalone agent file count)');
    expect(out).not.toContain('26 agents deployed');
    expect(out).not.toContain('Hermes Recorded deployment drift:');
  }, 150_000);

  it.each([true, false])('reports pi with zero on-disk agents, independently of stale receipts (explicit: %s)', async explicit => {
    const project = fixture('pi', 26);
    put(project, '.pi/prompts/prompt.md');
    mkdirSync(join(project, '.pi/prompts/not-a-prompt.md'), { recursive: true });
    put(project, 'AGENTS.md');
    for (let i = 0; i < 26; i++) put(project, `unrelated-${i}.md`);
    put(project, '.claude/agents/unrelated.md');
    const out = await doctor(project, explicit ? 'pi' : undefined);
    expect(out).toContain('✓ Pi Coding Agent Agents: 0 agents deployed on disk — no native agent surface; agents are indexed');
    expect(out).toContain('Pi Coding Agent Commands: 1 commands deployed (.pi/prompts)');
    expect(out).not.toMatch(/Pi Coding Agent (?:Deployment consistency|Recorded deployment drift):/);
    expect(out).not.toContain('26 agents deployed');
    expect(out).not.toContain('Unknown provider: pi');
    expect(out).not.toContain('aiwg use sdlc --provider pi');
  }, 150_000);
});
