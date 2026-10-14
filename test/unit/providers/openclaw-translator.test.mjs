/**
 * OpenClaw behavior → hook translator tests (PUW-008 / #1109, PUW-009 / #1110).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  translateBehaviorToHook,
  translateAllBehaviors,
  renderHookMd,
  renderHandlerJs,
} from '../../../tools/agents/providers/openclaw-translator.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-openclaw-translator-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeBehavior(name, frontmatter, scriptFiles = []) {
  const behaviorDir = path.join(tmpDir, 'src', name);
  await fs.mkdir(behaviorDir, { recursive: true });
  await fs.writeFile(
    path.join(behaviorDir, 'BEHAVIOR.md'),
    `---\n${frontmatter}\n---\n\n# ${name}\n\nBody.\n`,
    'utf8',
  );
  if (scriptFiles.length > 0) {
    const scriptsDir = path.join(behaviorDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    for (const fname of scriptFiles) {
      await fs.writeFile(path.join(scriptsDir, fname), `#!/bin/bash\necho ${fname}\n`, 'utf8');
    }
  }
  return behaviorDir;
}

describe('translateBehaviorToHook', () => {
  it('emits HOOK.md and handler.js for a behavior with hooks', async () => {
    const behaviorDir = await makeBehavior(
      'test-watcher',
      [
        'name: test-watcher',
        'version: 1.0.0',
        'description: Watches tests',
        'hooks:',
        '  on_file_write:',
        '    - filter: \'**/*.test.ts\'',
        '      action: run_script',
        '      script: scripts/run-test.sh',
      ].join('\n'),
      ['run-test.sh'],
    );
    const hookDir = path.join(tmpDir, 'hooks', 'test-watcher');

    const r = translateBehaviorToHook(behaviorDir, hookDir, {});
    expect(r.ok).toBe(true);

    const hookMd = await fs.readFile(path.join(hookDir, 'HOOK.md'), 'utf8');
    expect(hookMd).toContain('name: "test-watcher"');
    expect(hookMd).toContain('events:\n  - "on_file_write"');
    expect(hookMd).toContain('handler: ./handler.js');
    expect(hookMd).toContain('aiwg_managed: true');

    const handler = await fs.readFile(path.join(hookDir, 'handler.js'), 'utf8');
    expect(handler).toContain('on_file_write');
    expect(handler).toContain('run-test.sh');
    expect(handler).toContain('AIWG_HOOK_EVENT');
    expect(handler).toContain('process.exit');
  });

  it('skips behaviors without a hooks block', async () => {
    const behaviorDir = await makeBehavior(
      'agent-mode',
      [
        'name: agent-mode',
        'description: An agent-mode behavior with no hooks',
      ].join('\n'),
    );
    const r = translateBehaviorToHook(
      behaviorDir,
      path.join(tmpDir, 'hooks', 'agent-mode'),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no hooks');
  });

  it('returns ok:false when BEHAVIOR.md is missing', async () => {
    const empty = path.join(tmpDir, 'empty');
    await fs.mkdir(empty, { recursive: true });
    const r = translateBehaviorToHook(empty, path.join(tmpDir, 'hooks', 'empty'), {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('BEHAVIOR.md not found');
  });

  it('copies scripts/ alongside the handler', async () => {
    const behaviorDir = await makeBehavior(
      'with-scripts',
      [
        'name: with-scripts',
        'description: Has scripts',
        'hooks:',
        '  on_deploy:',
        '    - action: run_script',
        '      script: scripts/deploy.sh',
      ].join('\n'),
      ['deploy.sh'],
    );
    const hookDir = path.join(tmpDir, 'hooks', 'with-scripts');
    const r = translateBehaviorToHook(behaviorDir, hookDir, {});
    expect(r.ok).toBe(true);

    const scriptStat = await fs.stat(path.join(hookDir, 'scripts', 'deploy.sh'));
    expect(scriptStat.isFile()).toBe(true);
  });

  it('honors dry-run by not writing files', async () => {
    const behaviorDir = await makeBehavior(
      'dry',
      [
        'name: dry',
        'description: Dry run',
        'hooks:',
        '  on_deploy:',
        '    - action: run_script',
        '      script: scripts/x.sh',
      ].join('\n'),
      ['x.sh'],
    );
    const hookDir = path.join(tmpDir, 'hooks', 'dry');
    const r = translateBehaviorToHook(behaviorDir, hookDir, { dryRun: true });
    expect(r.ok).toBe(true);
    await expect(fs.access(path.join(hookDir, 'HOOK.md'))).rejects.toThrow();
  });
});

describe('translateAllBehaviors', () => {
  it('translates all behaviors with hooks, skips those without', async () => {
    const behaviorsRoot = path.join(tmpDir, 'src');
    await makeBehavior('a', [
      'name: a',
      'description: a',
      'hooks:',
      '  on_deploy:',
      '    - action: run_script',
      '      script: scripts/a.sh',
    ].join('\n'), ['a.sh']);
    await makeBehavior('b', 'name: b\ndescription: no hooks');

    const r = translateAllBehaviors(behaviorsRoot, path.join(tmpDir, 'hooks'), {});
    expect(r.translated).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].name).toBe('b');
  });

  it('returns empty result when behaviors root does not exist', () => {
    const r = translateAllBehaviors(path.join(tmpDir, 'nonexistent'), path.join(tmpDir, 'hooks'), {});
    expect(r.translated).toBe(0);
    expect(r.skipped).toEqual([]);
  });
});

describe('renderHookMd', () => {
  it('emits valid frontmatter with events list', () => {
    const md = renderHookMd({
      name: 'foo',
      description: 'foo desc',
      hooks: { on_deploy: [], on_schedule: [] },
    });
    expect(md).toMatch(/^---\nname: "foo"\n/);
    expect(md).toContain('events:\n  - "on_deploy"\n  - "on_schedule"');
    expect(md).toContain('handler: ./handler.js');
  });

  it.each(['x\nevil: injected', 'e1\nhandler: injected.js', 'true', 'foo #bar', 'x: y', 'line\rnext\u0085next\u2028next\u2029end'])(
    'round-trips name and event scalars without injecting fields: %j', (value) => {
      const md = renderHookMd({ name: value, description: '', hooks: { [value]: [] } });
      const parsed = YAML.parse(md.split('\n---\n')[0].slice(4));
      expect(parsed).toEqual({
        name: value, description: '', events: [value], handler: './handler.js', aiwg_managed: true,
      });
    },
  );

  it('handles behaviors with no events', () => {
    const md = renderHookMd({ name: 'no-events', description: '', hooks: {} });
    expect(md).toContain('events:\n  []');
  });

  it('escapes quotes in description', () => {
    const md = renderHookMd({
      name: 'quoted',
      description: 'Has "quotes" inside',
      hooks: {},
    });
    expect(md).toContain('description: "Has \\"quotes\\" inside"');
  });
});

describe('renderHandlerJs', () => {
  it('emits a node shebang and ESM imports', () => {
    const handler = renderHandlerJs({ name: 'x', hooks: {} });
    expect(handler).toMatch(/^#!\/usr\/bin\/env node/);
    expect(handler).toContain("from 'node:child_process'");
  });

  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'loads generated ESM safely with a hostile name containing %j', async (terminator) => {
      const name = `hook${terminator}throw new Error('comment injection'); //`;
      const handler = path.join(tmpDir, 'handler.mjs');
      await fs.writeFile(handler, renderHandlerJs({ name, hooks: {} }));
      await fs.symlink(path.resolve('node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
      const result = spawnSync(process.execPath, [handler], {
        input: '', encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it('emits dispatch table with event → script mapping', () => {
    const handler = renderHandlerJs({
      name: 'x',
      hooks: {
        on_file_write: [
          { action: 'run_script', script: 'scripts/scan.sh', filter: '**/*.ts' },
          { action: 'run_script', script: 'scripts/audit.sh' },
        ],
      },
    });
    expect(handler).toContain('on_file_write');
    expect(handler).toContain('scan.sh');
    expect(handler).toContain('audit.sh');
    expect(handler).toContain('"filter": "**/*.ts"');
  });
});
