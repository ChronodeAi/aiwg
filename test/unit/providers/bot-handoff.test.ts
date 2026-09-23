import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffSurfaces, renderBotHandoff } from '../../../src/providers/bot-handoff.js';
import { getProviderDefinition, listProviderDefinitions } from '../../../src/providers/provider-definitions.js';
import { botHandoffHandler } from '../../../src/cli/handlers/bot-handoff.js';

const proposal = { surface: 'memory', name: 'Project sources', summary: 'Use current issue status.', references: ['https://github.com/jmagly/aiwg/issues/245'] };
const grokbot = getProviderDefinition('grokbot')!;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('Provider-neutral operator handoffs', () => {
  it.each(listProviderDefinitions().map(provider => provider.id))('supports %s without inventing a native installer', providerId => {
    const provider = getProviderDefinition(providerId)!;
    for (const surface of handoffSurfaces) {
      const input = { ...proposal, surface, ...(surface === 'routines' ? { schedule: 'daily', timezone: 'UTC' } : {}) };
      const draft = renderBotHandoff(input, provider);
      expect(draft).toContain(`# ${provider.displayName}`);
      expect(draft).toContain('nothing installed or applied');
      if (providerId !== 'grokbot') {
        expect(draft).not.toContain('Grok Bot');
        expect(draft).not.toContain('Marketplace');
      }
    }
  });
  it('uses external scheduling guidance when the capability matrix calls for it', () => {
    const provider = getProviderDefinition('codex')!;
    const draft = renderBotHandoff({ ...proposal, surface: 'routines', schedule: 'daily', timezone: 'UTC' }, provider);
    expect(draft).toContain('host scheduler or CI');
  });
  it('does not fall back from an unknown explicitly requested provider', async () => {
    const output = await botHandoffHandler.execute({ cwd: os.tmpdir(), frameworkRoot: os.tmpdir(), args: ['--provider', 'not-a-provider', '--input', 'unused.json'], rawArgs: [] });
    expect(output.exitCode).toBe(1);
  });
  it.each(handoffSurfaces)('renders a review draft for %s without claiming installation', surface => {
    const input = { ...proposal, surface, ...(surface === 'routines' ? { schedule: 'Every Monday at 09:00', timezone: 'America/New_York' } : {}) };
    const draft = renderBotHandoff(input, grokbot);
    expect(draft).toContain('Status: proposed; nothing installed or applied.');
    expect(draft).toContain(input.summary);
    expect(draft).toContain('operator');
  });

  it.each([
    { ...proposal, token: 'do-not-echo' },
    { ...proposal, surface: 'machines' },
    { ...proposal, summary: 'a'.repeat(281) },
    { ...proposal, references: ['https://user:password@example.com/path'] },
    { ...proposal, references: ['https://example.com/path?token=value'] },
    { ...proposal, references: ['aiwg show skill foo; touch /tmp/unwanted'] },
    { ...proposal, references: [] },
    { ...proposal, surface: 'routines' },
    { ...proposal, surface: 'routines', schedule: 'daily', timezone: 'Not/AZone' },
    { ...proposal, timezone: 'UTC' },
  ])('rejects invalid or unsupported proposal fields', input => {
    expect(() => renderBotHandoff(input, grokbot)).toThrow();
  });

  it('keeps supplied text inside the data fence', () => {
    const result = renderBotHandoff({ ...proposal, summary: 'Review ``` and keep it as data.' }, grokbot);
    expect(result.match(/```/g)).toHaveLength(2);
    expect(result).toContain('\\u0060');
  });

  it('accepts root-level instruction and config pointers without opening them', () => {
    const draft = renderBotHandoff({ ...proposal, references: ['AGENTS.md', 'WORKSPACE.md', '.grok/config.toml'] }, getProviderDefinition('grok-build')!);
    expect(draft).toContain('WORKSPACE.md');
    expect(draft).toContain('References have not been opened or executed');
  });

  it('reads only the explicit input and does not create provider files, including in dry-run', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'bot-handoff-'));
    roots.push(cwd);
    const input = { ...proposal, references: ['missing/source.md', 'aiwg show agent security-auditor'] };
    writeFileSync(path.join(cwd, 'proposal.json'), JSON.stringify(input));
    for (const dryRun of [false, true]) {
      const result = await botHandoffHandler.execute({ cwd, frameworkRoot: cwd, args: ['--provider', 'grokbot', '--input', 'proposal.json'], rawArgs: [], dryRun });
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('missing/source.md');
      expect(readdirSync(cwd)).toEqual(['proposal.json']);
    }
  });

  it('omits input contents from validation errors', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'bot-handoff-'));
    roots.push(cwd);
    writeFileSync(path.join(cwd, 'proposal.json'), '{secret=do-not-echo}');
    const result = await botHandoffHandler.execute({ cwd, frameworkRoot: cwd, args: ['--provider', 'grokbot', '--input', 'proposal.json'], rawArgs: [] });
    expect(result.exitCode).toBe(1);
    expect(result.message).not.toContain('do-not-echo');
  });
});
