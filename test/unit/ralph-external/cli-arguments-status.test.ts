// Verify public Ralph argument and status contracts with only synthetic local state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, parseWorkerStatusArgs, printHelp, printStatus } from '../../../tools/ralph-external/index.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ralph-cli-contract-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('T-OG-05 Ralph argument admission', () => {
  it('preserves explicit numeric controls and option values', () => {
    const harness = path.join(root, 'harness.json'); writeFileSync(harness, '{"version":1}');
    expect(parseArgs(['objective', '-c', 'criteria', '--max-iterations', '2', '--budget', '.5', '--timeout', '10',
      '--max-total-tokens', '100', '--max-output-tokens', '40', '--max-tool-calls', '3', '--max-total-cost', '1.2',
      '--max-wall-clock-minutes', '5', '--exploration-quota', '2', '--budget-stop-policy', 'completion-wins',
      '--model', 'synthetic', '--mcp-config', '{"servers":{}}', '--eval-harness', harness,
      '--provider', 'muse', '--thinking', 'high', '--tools', 'read, write, ', '--memory', '5',
      '--cross-task', '--verbose', '--gitea-issue', '--log-file', path.join(root, 'run.log'),
      '--no-best-output', '--no-early-stopping', '--allow-exhausted-resume',
    ])).toMatchObject({ objective: 'objective', completionCriteria: 'criteria', maxIterations: 2,
      budgetPerIteration: .5, timeoutMinutes: 10, model: 'synthetic', tools: ['read', 'write'],
      budgetLimits: { total_tokens: 100, output_tokens: 40, tool_calls: 3, spend_usd: 1.2, wall_clock_minutes: 5 },
      explorationQuota: { enabled: true, k: 2 }, budgetStopPolicy: 'completion-wins', evalHarness: { version: 1 },
      mcpConfig: { servers: {} }, provider: 'muse', thinking: 'high', memory: 5, crossTask: true,
      verbose: true, giteaIssue: true, enableBestOutput: false, enableEarlyStopping: false, allowExhaustedResume: true });
  });

  it('accepts aliases and memory presets, ignores additional objectives and unknown flags', () => {
    expect(parseArgs(['first', 'second', '-h', '-r', '-s', '--abort', '-m', 'complex', '-v', '--unknown', '--no-cross-task']))
      .toMatchObject({ objective: 'first', help: true, resume: true, status: true, abort: true,
        memory: 'complex', verbose: true, crossTask: false });
    expect(parseArgs(['--help', '--resume', '--status', '--memory', 'moderate']))
      .toMatchObject({ help: true, resume: true, status: true, memory: 'moderate' });
  });

  it.each(['--max-iterations', '--max-total-tokens', '--max-output-tokens', '--max-tool-calls',
    '--exploration-quota', '--timeout', '--budget', '--max-total-cost', '--max-wall-clock-minutes'])(
    'rejects invalid whole-value numeric control %s', flag => {
      for (const value of [undefined, '0', '-1', 'NaN', '1junk', '0x10']) {
        expect(() => parseArgs([flag, ...(value === undefined ? [] : [value])])).toThrow('exit:1');
      }
    },
  );

  it('rejects fractional integer counters, unsafe integers, and unsupported stop policies', () => {
    for (const value of ['1.5', '9007199254740992']) expect(() => parseArgs(['--max-iterations', value])).toThrow('exit:1');
    expect(() => parseArgs(['--budget-stop-policy', 'invented'])).toThrow('exit:1');
    expect(() => parseArgs(['--eval-harness', path.join(root, 'absent')])).toThrow('exit:1');
  });

  it('warns only when disabling analytics voids declared controls', () => {
    parseArgs(['--no-analytics']); expect(console.warn).not.toHaveBeenCalled();
    parseArgs(['--no-analytics', '--budget', '1', '--exploration-quota', '2', '--max-total-tokens', '5']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('total_tokens, exploration_quota'));
  });

  it('parses a bounded, observed worker watch scoped to one root', () => {
    expect(parseWorkerStatusArgs(['-s', '--workers', '--runs-root', root, '--watch', '--observe',
      '--deadline-seconds', '.5', '--json'])).toEqual({ watch: true, observe: true, json: true, runsRoot: root, deadlineSeconds: .5 });
  });

  it.each([
    [[], 'WORKER_STATUS_REQUIRED'], [['--workers'], 'WORKER_STATUS_REQUIRED'],
    [['--status', '--workers', '--json', '--json'], 'DUPLICATE_STATUS_OPTION'],
    [['--status', '--workers', '--invented'], 'UNKNOWN_STATUS_OPTION'],
    [['--status', '--workers', '--run-dir'], 'MISSING_STATUS_VALUE'],
    [['--status', '--workers', '--run-dir', '--json'], 'MISSING_STATUS_VALUE'],
    [['--status', '--workers'], 'EXACTLY_ONE_RUN_SCOPE_REQUIRED'],
    [['--status', '--workers', '--run-dir', 'a', '--runs-root', 'b'], 'EXACTLY_ONE_RUN_SCOPE_REQUIRED'],
    [['--status', '--workers', '--run-dir', 'a', '--watch'], 'FINITE_WATCH_DEADLINE_REQUIRED'],
    [['--status', '--workers', '--run-dir', 'a', '--deadline-seconds', '1'], 'FINITE_WATCH_DEADLINE_REQUIRED'],
    [['--status', '--workers', '--run-dir', 'a', '--observe'], 'OBSERVE_REQUIRES_WATCH'],
    ...['0', 'NaN', '86401'].map(value => [['--status', '--workers', '--deadline-seconds', value], 'INVALID_WATCH_DEADLINE']),
  ])('refuses invalid worker status grammar (case %#)', (args, diagnostic) => {
    expect(() => parseWorkerStatusArgs(args)).toThrow(diagnostic);
  });
});

function statusFixture(analytics?: unknown, stateOverrides = {}) {
  const dir = path.join(root, '.aiwg/ralph-external'); mkdirSync(path.join(dir, 'analytics'), { recursive: true });
  writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({ version: '1.0.0', loopId: 'fixture', status: 'running',
    objective: 'fixture', completionCriteria: 'fixture', currentIteration: 1, maxIterations: 2, iterations: [],
    accumulatedLearnings: '', config: {}, ...stateOverrides }));
  if (analytics !== undefined) writeFileSync(path.join(dir, 'analytics/fixture.json'), JSON.stringify(analytics));
  return path.join(dir, 'analytics/fixture.json');
}
const output = () => vi.mocked(console.log).mock.calls.map(call => call.join(' ')).join('\n');

describe('T-OG-05/06 Ralph status output without provider probes', () => {
  it('prints help and reports no loop when state is absent', () => {
    printHelp(); expect(output()).toContain('Worker status (read-only');
    printStatus(root); expect(output()).toContain('No external Ralph loop found.');
  });

  it('reports configured controls without analytics and tolerates missing optional config', () => {
    statusFixture(undefined, { config: { budgetLimits: { total_tokens: 100, ignored: null, empty: '', invalid: -1 } },
      lfdControls: { structuralVariantRequired: true, flatCycleCount: 2, explorationQuotaK: 3 } });
    printStatus(root); expect(output()).toContain('total_tokens=100'); expect(output()).toContain('required (2/3 flat cycles)');
    statusFixture(undefined, { config: null }); printStatus(root); expect(output()).toContain('none configured');
    statusFixture(undefined, { lfdControls: {} }); printStatus(root); expect(output()).toContain('not required (0/N/A flat cycles)');
  });

  it('reports unreadable analytics instead of fabricating budget usage', () => {
    const file = statusFixture(); writeFileSync(file, '{'); printStatus(root);
    expect(output()).toContain('unreadable'); expect(output()).toContain(file);
  });

  it('prints bounded budget usage, exhausted controls and best observed efficiency metrics', () => {
    const iterations = [1, 3, 2].map(n => ({ iteration_number: n, quality_per_1k_tokens: n * 10, quality_per_minute: n * 20,
      baseline_comparison: { quality_lift: n, token_efficiency_lift: n * 2, speed_efficiency_lift: n * 3 } }));
    iterations.push({ iteration_number: 4 } as typeof iterations[number]);
    statusFixture({ budget_usage: { total_tokens: 100, output_tokens: 40, tool_calls: 2, spend_usd: .1, wall_clock_minutes: 1 },
      budget_exhausted: true, budget_stop_report: { budgets: { exhausted: [{ name: 'total_tokens' }] } },
      iterations, structural_variant_required: true, flat_cycle_count: 2 },
    { config: { budgetLimits: { total_tokens: 100, output_tokens: 80, tool_calls: 4, spend_usd: .2, wall_clock_minutes: 2 },
      explorationQuota: { k: 3 } }, iterations: [{ status: 'completed', analysis: { completionPercentage: 50 } }, {}],
    accumulatedLearnings: 'fixture learning' });
    printStatus(root);
    expect(output()).toContain('100 / 100 (100.0%)'); expect(output()).toContain('$0.1000 / $0.2000 (50.0%)');
    expect(output()).toContain('exhausted (total_tokens)'); expect(output()).toContain('iteration 3 (30.00)');
    expect(output()).toContain('unknown (0% progress)'); expect(output()).toContain('fixture learning...');
  });

  it('marks unknown usage and absent efficiency evidence without inventing values', () => {
    statusFixture({}); printStatus(root);
    expect(output()).toContain('unknown'); expect(output()).toContain('not exhausted'); expect(output()).toContain('N/A');
    statusFixture({ budget_usage: { total_tokens: 5 }, iterations: [] }); printStatus(root);
    expect(output()).toMatch(/Total Tokens:\s+5/);
  });
});
