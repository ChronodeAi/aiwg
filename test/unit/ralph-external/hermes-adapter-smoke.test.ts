/**
 * Declared-vs-observed smoke test for the Hermes provider adapter (ADR-006).
 *
 * Per-adapter smoke pattern (ADR-001 §5, ADR-006): spawn `hermes --help`,
 * extract the observed flag surface, and assert:
 *   1. every capability declared `true` has its supporting flag observed;
 *   2. every capability declared `false` has no corresponding flag emitted
 *      by buildSessionArgs();
 *   3. no arg emitted by buildSessionArgs() is an unknown option in the
 *      observed surface (the FC1 `error: unknown option` crash class,
 *      generalized).
 *
 * Skips (recorded as unrun) when the hermes binary is absent from the
 * environment; the recorded `hermes --version` output is the fixture pin.
 *
 * @source @tools/ralph-external/lib/hermes-adapter.mjs
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

// @ts-ignore - ESM import
import { HermesAdapter } from '../../../tools/ralph-external/lib/hermes-adapter.mjs';

const adapter = new HermesAdapter();

const help = spawnSync(adapter.getBinary(), ['--help'], {
  timeout: 15000,
  encoding: 'utf8',
});
const observed = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
const binaryAvailable = !help.error && help.status === 0;

const CAPABILITY_FLAG_MAP: Record<string, string[]> = {
  sessionResume: ['--session-id', '--resume'],
  budgetControl: ['--max-budget-usd'],
  systemPrompt: ['--append-system-prompt'],
  streamJson: ['--output-format'],
  agentMode: ['--agent'],
  mcpConfig: ['--mcp-config'],
  maxTurns: ['--max-turns'],
};

describe.skipIf(!binaryAvailable)('hermes adapter declared-vs-observed smoke', () => {
  it('records the observed hermes version as the fixture pin', () => {
    const version = spawnSync(adapter.getBinary(), ['--version'], {
      timeout: 15000,
      encoding: 'utf8',
    });
    // eslint-disable-next-line no-console
    console.log(
      `[hermes-adapter-smoke] hermes --version: ${(version.stdout ?? 'unavailable').trim()}`
    );
    expect(observed.length).toBeGreaterThan(0);
  });

  it('declares no capability whose supporting flag is unobserved', () => {
    const caps = adapter.getCapabilities();
    for (const [capability, flags] of Object.entries(CAPABILITY_FLAG_MAP)) {
      for (const flag of flags) {
        if (caps[capability]) {
          expect(observed, `${capability}=true requires observed ${flag}`).toContain(flag);
        } else {
          expect(adapter.buildSessionArgs({ prompt: 'smoke' } as any)).not.toContain(flag);
        }
      }
    }
  });

  it('emits no arg that the observed surface rejects (FC1, generalized)', () => {
    const emitted = adapter.buildSessionArgs({
      prompt: 'smoke prompt',
      sessionId: 'smoke-session',
      model: 'sonnet',
      budget: 1,
      maxTurns: 2,
      verbose: true,
      systemPrompt: 'smoke system prompt',
      mcpConfig: {},
    } as any);
    for (const arg of emitted) {
      if (arg.startsWith('--')) {
        expect(observed, `emitted option ${arg} must appear in observed --help`).toContain(arg);
      }
    }
    // H-1 (observed 2026-08-30): prompt rides as the -z flag VALUE, never a
    // bare positional — argparse would consume it as the command name.
    expect(emitted[emitted.indexOf('-z') + 1]).toBe('smoke prompt');
    expect(emitted.filter((a: string) => !a.startsWith('-') && a !== 'smoke prompt')).toEqual([]);
  });
});
