/**
 * Unit tests for parallelism-section — context-file injector for the
 * project parallelism cap.
 *
 * @source @src/smiths/context-pipeline/parallelism-section.ts
 * @implements #1362
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildParallelismSection,
  replaceOrAppendParallelismBlock,
  MAX_SHOWN_GROUPS,
  PARALLELISM_BLOCK_START,
  PARALLELISM_BLOCK_END,
  PARALLELISM_HEALTH_UNRESOLVED_NOTE,
} from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { emptyConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { parseWorkerCommandArgs } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { parseWorkerStatusArgs } from '../../../tools/ralph-external/index.mjs';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-parallelism-section-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('buildParallelismSection (#1362)', () => {
  let tmpDir: string;
  const originalEnv = process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    // Locate the bundled model defaults from this checkout (same as
    // test/unit/models/resolver.test.ts); never the user's home install.
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(tmpDir, 'aiwg-user-config'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (originalEnv !== undefined) {
      process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = originalEnv;
    } else {
      delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    }
  });

  it('returns empty when no aiwg.config exists', async () => {
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe('');
  });

  it('returns empty when AIWG_HIDE_PARALLELISM_IN_CONTEXT=1 is set', async () => {
    process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = '1';
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe('');
  });

  it('includes provider-default labeling for claude', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('## Parallelism Cap');
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('4 (provider default for claude)');
    expect(section).toContain('2 (provider default for claude)'); // ralph loops
  });

  it('includes provider-default labeling for codex', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('10 (provider default for codex)');
    expect(section).toContain('3 (provider default for codex)'); // ralph loops
  });

  it('labels operator-overridden values', async () => {
    const cfg = emptyConfig(['claude']);
    cfg.parallelism = {
      max_parallel_subagents: 8, // override (claude default is 4)
      max_parallel_ralph_loops: 2,
      max_parallel_mc_missions: 4,
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('8 (operator override)');
    // Non-overridden fields keep the provider-default label
    expect(section).toContain('2 (provider default for claude)');
  });

  it('includes rationale when present', async () => {
    const cfg = emptyConfig(['claude']);
    cfg.parallelism = {
      max_parallel_subagents: 4,
      max_parallel_ralph_loops: 2,
      max_parallel_mc_missions: 4,
      rationale: 'Anthropic Team plan',
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('*Rationale*: Anthropic Team plan');
  });

  it('wraps content in managed-block markers', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain(PARALLELISM_BLOCK_START);
    expect(section).toContain(PARALLELISM_BLOCK_END);
    expect(section.indexOf(PARALLELISM_BLOCK_START)).toBeLessThan(
      section.indexOf(PARALLELISM_BLOCK_END),
    );
  });

  it('includes the MIN-of-caps composition guidance', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('take the MIN of');
    expect(section).toContain('AIWG_CONTEXT_WINDOW');
    expect(section).toContain('framework-specific caps');
    expect(section).toContain('natural task decomposition');
    expect(section).toContain('aiwg config set --project');
  });

  it('emits the wrapper selection rubric and primary-agent responsibilities', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('assess whether it contains independent, bounded subtasks');
    expect(section).toContain('aiwg-model-efficiency-worker');
    expect(section).toContain('aiwg-model-coding-worker');
    expect(section).toContain('aiwg-model-reasoning-worker');
    expect(section).toContain('The primary agent retains orchestration');
    expect(section).toContain('native custom subagents');
  });

  it('documents no-delegation edge cases', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('trivial work');
    expect(section).toContain('tightly coupled changes');
    expect(section).toContain('serial dependencies');
    expect(section).toContain('collide in shared state');
    expect(section).toContain('coordination costs');
  });

  it.each([
    ['warp', 'model selection is global/run-scoped'],
    ['hermes', 'model selection is global/run-scoped'],
    ['windsurf', 'portable subagent model selection is unsupported'],
    ['openhuman', 'wrapper roles compile to OpenHuman agent definitions'],
  ])('qualifies provider delegation for %s', async (provider, expected) => {
    await writeAiwgConfig(tmpDir, emptyConfig([provider]));
    expect(await buildParallelismSection(tmpDir)).toContain(expected);
  });
});

describe('orchestration groups block (#2893 / #2914)', () => {
  let tmpDir: string;
  const originalEnv = process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    // Locate the bundled model defaults from this checkout (same as
    // test/unit/models/resolver.test.ts); never the user's home install.
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(tmpDir, 'aiwg-user-config'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (originalEnv !== undefined) {
      process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = originalEnv;
    } else {
      delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    }
  });

  function groupConfig() {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    cfg.parallelism.groups = {
      'default': {
        members: [
          { id: 'codex-a', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] },
          { id: 'muse-b', cli: 'muse', model: 'muse-spark-1.3', roles: ['efficiency', 'coding'] },
        ],
        maxParallel: 2,
        requiredRoles: ['coding'],
      },
    };
    return cfg;
  }

  // Byte-for-byte rendering of buildParallelismSection() at HEAD (before the
  // orchestration-guidance block existed) for emptyConfig(['codex']): no
  // worker_dispatch, no groups. Regenerate only from HEAD sources.
  const PRE_DISPATCH_GOLDEN = `<!-- AIWG-PARALLELISM-CAP:START -->
## Parallelism Cap

This project caps parallel agent fan-out (#1359):

- **max_parallel_subagents**: 10 (provider default for codex)
- **max_parallel_ralph_loops**: 3 (provider default for codex)
- **max_parallel_mc_missions**: 6 (provider default for codex)

*Rationale*: Provider default for codex — adjust via 'aiwg config set --project parallelism.max_parallel_subagents N'

### Model-selected delegation rubric

For each non-trivial task, assess whether it contains independent, bounded subtasks that can run concurrently. When delegation is supported, prefer the deployed model-pinned wrappers by task characteristics and consequence:

- \`aiwg-model-efficiency-worker\`: discovery, inventory, focused edits, and other bounded low-cost work.
- \`aiwg-model-coding-worker\`: implementation, tests, debugging, and routine technical delivery.
- \`aiwg-model-reasoning-worker\`: architecture, synthesis, difficult analysis, and high-consequence review.

Do not delegate trivial work, tightly coupled changes, serial dependencies, or tasks likely to collide in shared state; also keep work local when coordination costs exceed the expected benefit. Parallelize only independent work, and take the MIN of provider limits, \`max_parallel_subagents\`, \`AIWG_CONTEXT_WINDOW\` budget, framework-specific caps (including the RLM 7-agent hard cap for RLM dispatches), and natural task decomposition. Bump the project cap via \`aiwg config set --project parallelism.max_parallel_subagents N\`.

The primary agent retains orchestration, final integration, conflict resolution, validation, and user-facing accountability.

**Provider behavior (codex)**: native custom subagents can select the deployed model-worker wrapper. Verify the resolved model when provider or account policy may substitute it.

<!-- AIWG-PARALLELISM-CAP:END -->
`;

  it('dispatch disabled renders byte-identical output to the pre-dispatch rendering', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    expect(await buildParallelismSection(tmpDir)).toBe(PRE_DISPATCH_GOLDEN);
  });

  it('dispatch explicitly false renders byte-identical output even with groups configured', async () => {
    const cfg = groupConfig();
    cfg.parallelism.worker_dispatch = false;
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe(PRE_DISPATCH_GOLDEN);
    expect(section).not.toContain('Orchestration groups');
  });

  it('dispatch enabled renders configured groups with caps, roles, and eligibility inside the managed block', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('### Orchestration groups (group dispatch enabled)');
    expect(section).toContain('Configured groups:');
    expect(section).toContain('default (members: 2');
    expect(section).toContain('maxParallel: 2');
    expect(section).toContain('requiredRoles: coding');
    expect(section).toContain('; eligible)');
    expect(section).not.toContain('Available groups');
    expect(section.indexOf('### Orchestration groups')).toBeGreaterThan(
      section.indexOf(PARALLELISM_BLOCK_START),
    );
    expect(section.indexOf('### Orchestration groups')).toBeLessThan(
      section.indexOf(PARALLELISM_BLOCK_END),
    );
  });

  it('dispatch enabled with a disabled member marks the group configured-not-eligible', async () => {
    const cfg = groupConfig();
    cfg.parallelism.groups!.stale = {
      members: [
        { id: 'codex-c', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] },
        { id: 'muse-d', cli: 'muse', model: 'muse-spark-1.3', roles: ['coding'], enabled: false },
      ],
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('default (members: 2');
    expect(section).toContain('stale (members: 2');
    expect(section).toContain('configured — not eligible: member muse-d is disabled');
    expect(section).not.toContain('Available groups');
  });

  it('dispatch enabled without groups keeps the native rubric and names no Available groups', async () => {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('Configured groups: none');
    expect(section).toContain('the native delegation rubric above applies unchanged');
    expect(section).not.toContain('Available groups');
    expect(section).not.toContain('keep work local or add a group');
  });

  it('overriding all five health settings changes the rendered numbers and shows project origin', async () => {
    const cfg = groupConfig();
    cfg.parallelism.health = {
      checkSeconds: 7, startupSeconds: 30, quietSeconds: 45, stallSeconds: 120, hardTimeoutSeconds: 600,
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('check every 7s (project config)');
    expect(section).toContain('confirm startup within 30s (project config)');
    expect(section).toContain('quiet limit 45s (project config)');
    expect(section).toContain('stall limit 120s (project config)');
    expect(section).toContain('hard stop 600s (project config)');
    expect(section).not.toContain('every 15s');
    expect(section).not.toContain('(default)');
  });

  it('unconfigured health renders defaults with default origin', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('check every 15s (default)');
    expect(section).toContain('confirm startup within 60s (default)');
    expect(section).toContain('quiet limit 90s (default)');
    expect(section).toContain('stall limit 300s (default)');
    expect(section).toContain('hard stop 1800s (default)');
    expect(section).toContain('Resolved values win over these configured values');
    expect(section).toContain('--format json');
    expect(section).toContain('invocation.health');
  });

  it('omits the health block with a one-line note when bundled defaults cannot be loaded', async () => {
    const section = await buildParallelismSection(tmpDir, {
      readConfig: () => Promise.reject(new Error('Failed to load AIWG default config: Error: ENOENT: no such file or directory')),
    });
    expect(section).toContain(PARALLELISM_BLOCK_START);
    expect(section).toContain(PARALLELISM_BLOCK_END);
    expect(section).toContain(PARALLELISM_HEALTH_UNRESOLVED_NOTE);
    expect(section).not.toContain('### Orchestration groups');
    expect(section).not.toContain('Configured health windows');
    const noteLines = section.split('\n').filter((line) => line.includes('could not be resolved'));
    expect(noteLines).toHaveLength(1);
  });

  it('every advertised CLI command parses in the real argument parsers', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    const resolveMatch = /`(aiwg models resolve [^`]+)`/.exec(section);
    expect(resolveMatch).not.toBeNull();
    const argv = resolveMatch![1].split(' ').slice(3).map((token) => token
      .replace('<role>', 'coding').replace('<class>', 'bugfix').replace('<group>', 'default')
      .replace('<file>', '/tmp/brief.md').replace('<tree>', '/tmp/tree'));
    const request = parseWorkerCommandArgs(argv);
    expect(request).toMatchObject({
      role: 'coding', task: 'bugfix', group: 'default', brief: '/tmp/brief.md',
      workdir: '/tmp/tree', final_output: '/tmp/brief.md', transport: 'shell', format: 'shell',
    });
    const jsonArgv = argv.map((token, index) => (token === 'shell' && argv[index - 1] === '--format' ? 'json' : token));
    expect(parseWorkerCommandArgs(jsonArgv).format).toBe('json');
    const statusMatch = /`(aiwg ralph-external --status --workers --runs-root [^`]+)`/.exec(section);
    expect(statusMatch).not.toBeNull();
    const statusArgv = statusMatch![1].split(' ').slice(2).map((token) => (token === '<dir>' ? '/tmp/runs' : token));
    expect(parseWorkerStatusArgs(statusArgv)).toMatchObject({ runsRoot: '/tmp/runs', json: true });
    expect(section).not.toContain('doctor --groups');
    expect(section).not.toContain('steward models --group');
  });

  it('100 groups render at most eight summaries with a +N more tail', async () => {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    cfg.parallelism.groups = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`g-${i}`, {
      members: [{ id: `m-${i}`, cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] }],
    }]));
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('(+92 more)');
    expect((section.match(/\(members: /g) ?? []).length).toBe(MAX_SHOWN_GROUPS);
    expect(section.length).toBeLessThan(12000);
  });

  it('quiet-state guidance matches the observer: quiet never stops, only hung authorizes an owned stop', async () => {
    let now = 0;
    const observer = createWorkerHealthObserver({
      invocationId: 'guidance-quiet', now: () => now, wallNow: () => 0,
      launchTime: new Date(0).toISOString(), health: { handshake: 'process-only' },
    });
    observer.processStarted({ pid: 1, startTicks: 100, executable: '/usr/bin/codex' });
    now = 91_000;
    expect(observer.check(now).state).toBe('quiet');
    expect(observer.check(now).confidence).toBe('suspected');
    expect(observer.shouldStop()).toBe(false);
    now = 301_000;
    expect(observer.check(now).state).toBe('stalled');
    expect(observer.shouldStop()).toBe(false);
    now = 361_000;
    expect(observer.check(now).state).toBe('hung');
    expect(observer.shouldStop()).toBe(false);
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).not.toContain('suspect transition');
    expect(section).toContain('is not a stop');
    expect(section).toContain('only `hung`');
    expect(section).toContain('only a worker this conductor owns');
    expect(section).toContain('Confirm the stop');
    expect(section).toContain('preserve partial work');
    expect(section).toContain('OBSERVER_GAP');
    expect(section).toContain('unknown, never worker failure');
    expect(section).toContain('Heartbeats and log bytes are not progress');
  });

  it('preserves caps and rubric alongside the dispatch block', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('aiwg-model-efficiency-worker');
    expect(section).toContain('aiwg-model-coding-worker');
    expect(section).toContain('aiwg-model-reasoning-worker');
  });
});

describe('replaceOrAppendParallelismBlock (#1362)', () => {
  const FAKE_SECTION = [
    PARALLELISM_BLOCK_START,
    '## Parallelism Cap',
    'fake',
    PARALLELISM_BLOCK_END,
    '',
  ].join('\n');

  it('appends section to content with no existing block', () => {
    const original = '# Some doc\n\nbody content';
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).toContain('# Some doc');
    expect(result).toContain(PARALLELISM_BLOCK_START);
    expect(result.endsWith(FAKE_SECTION)).toBe(true);
  });

  it('replaces existing block in-place', () => {
    const original = `# Doc\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\nrest of doc`;
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).not.toContain('OLD');
    expect(result).toContain('fake');
    expect(result).toContain('rest of doc');
    // Block appears exactly once
    const startMatches = result.split(PARALLELISM_BLOCK_START).length - 1;
    expect(startMatches).toBe(1);
  });

  it('strips existing block when new section is empty', () => {
    const original = `# Doc\n\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\nrest`;
    const result = replaceOrAppendParallelismBlock(original, '');
    expect(result).not.toContain(PARALLELISM_BLOCK_START);
    expect(result).not.toContain(PARALLELISM_BLOCK_END);
    expect(result).toContain('# Doc');
    expect(result).toContain('rest');
  });

  it('returns content unchanged when no block and section is empty', () => {
    const original = '# Doc\n\nbody';
    const result = replaceOrAppendParallelismBlock(original, '');
    expect(result).toBe(original);
  });

  it('preserves content before and after a regenerated block', () => {
    const original = `# Doc\nintro\n\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\noutro`;
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).toMatch(/^# Doc\nintro/);
    expect(result).toContain('outro');
  });
});
