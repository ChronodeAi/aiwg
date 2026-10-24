import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'bin', 'aiwg.mjs');
const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('guided setup offline CLI walkthrough', () => {
  it('interviews, reviews, applies and verifies core setup plus Jev in an isolated home', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-guided-walkthrough-'));
    temporary.push(scratch);
    const project = path.join(scratch, 'project');
    const home = path.join(scratch, 'home');
    const bin = path.join(scratch, 'bin');
    const artifacts = path.join(project, '.aiwg');
    for (const dir of [project, home, bin]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'guided-fixture', private: true }));
    // Discovery and verification inspect the executable without invoking a paid worker.
    fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nthrow new Error("Worker execution is outside this walkthrough");\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@exit /b 97\r\n');

    const requests = path.join(scratch, 'jev-requests.jsonl');
    const preload = path.join(scratch, 'offline-endpoint.mjs');
    // The real decision setup child inherits this endpoint stub. All fetches
    // are intercepted; an unexpected URL fails before any network request.
    fs.writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected offline endpoint');
  const request = JSON.parse(init.body);
  if (init.method !== 'POST' || request.questions.answer?.type !== 'noul') throw new Error('Invalid setup verification request');
  appendFileSync(process.env.AIWG_WALKTHROUGH_REQUESTS, JSON.stringify({ url: String(url), question: request.questions.answer }) + '\\n');
  return new Response(JSON.stringify({ model: 'jev-fixture', answers: { answer: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
    const env: NodeJS.ProcessEnv = {
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      AIWG_CONFIG: path.join(home, '.aiwg'),
      AIWG_PROJECT_MEMORY_HOME: path.join(scratch, 'memory'),
      AIWG_WALKTHROUGH_REQUESTS: requests,
      AIWG_WALKTHROUGH_PROVIDER_INPUT: 'fixture-provider-input',
      AIWG_WALKTHROUGH_JEV_INPUT: 'fixture-jev-input',
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CI: '1',
      ...(process.env.AIWG_FRAMEWORK_INDEX_CACHE ? { AIWG_FRAMEWORK_INDEX_CACHE: process.env.AIWG_FRAMEWORK_INDEX_CACHE,
        AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE } : {}),
      ...(process.env.AIWG_RULE_BINDING_INDEX_CACHE ? { AIWG_RULE_BINDING_INDEX_CACHE: process.env.AIWG_RULE_BINDING_INDEX_CACHE } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, 'setup', ...args], {
        cwd: project, env, encoding: 'utf8', input: '', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).not.toMatch(/\[back \||Enter .*API input|\[y\/N\]/);
      expect(`${result.stdout}${result.stderr}`).not.toContain(env.AIWG_WALKTHROUGH_PROVIDER_INPUT);
      expect(`${result.stdout}${result.stderr}`).not.toContain(env.AIWG_WALKTHROUGH_JEV_INPUT);
      // Deployment owners may print their progress before the raw JSON result.
      const start = result.stdout.lastIndexOf('\n{');
      return JSON.parse(result.stdout.slice(start < 0 ? 0 : start + 1));
    };

    expect(fs.existsSync(artifacts)).toBe(false);
    const plan = run(['--scope', 'project', '--providers', 'codex', '--intent', 'code',
      '--credential', 'codex=env:AIWG_WALKTHROUGH_PROVIDER_INPUT', '--jev', 'enable',
      '--credential', 'jev=env:AIWG_WALKTHROUGH_JEV_INPUT', '--verify', '--yes', '--json']);
    expect(plan.actions.map((action: { kind: string }) => action.kind)).toEqual(expect.arrayContaining([
      'configure-provider', 'verify-provider', 'write-project-config', 'deploy-framework', 'register-project', 'configure-jev',
    ]));
    expect(fs.existsSync(path.join(project, '.aiwg', 'aiwg.config'))).toBe(false);
    expect(fs.existsSync(requests)).toBe(false);

    const review = run(['--review', '--json']);
    expect(review).toMatchObject({ schema: 'aiwg.setup.review.v1', conflicts: [] });
    expect(review.stale.flatMap((entry: { changes: Array<{ reason: string }> }) => entry.changes)
      .every((change: { reason: string }) => change.reason === 'unobserved')).toBe(true);
    expect(review.actions.every((action: { status: string }) => action.status === 'ready')).toBe(true);
    expect(fs.existsSync(requests)).toBe(false);

    const applied = run(['--apply', '--yes', '--json']);
    expect(applied).toMatchObject({ schema: 'aiwg.setup.apply.v1', classification: 'success', exitCode: 0 });
    expect(applied.results.every((action: { status: string }) => action.status === 'applied')).toBe(true);
    expect(applied.results.find((action: { kind: string }) => action.kind === 'deploy-framework').message).toMatch(/verification: ready(?:-restart-required)?\)/);
    expect(applied.results.find((action: { kind: string }) => action.kind === 'verify-provider').message).toContain('verified codex');
    expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.aiwg', 'aiwg.config'), 'utf8')).providers).toContain('codex');
    expect(fs.existsSync(path.join(home, '.config', 'aiwg', 'credentials', 'jev.json'))).toBe(true);
    const calls = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');

    const ready = run(['--review', '--json']);
    expect(ready.actions.every((action: { status: string }) => action.status === 'applied')).toBe(true);
    expect(ready.readiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'workspace', provider: 'shared', ready: true }),
      expect.objectContaining({ area: 'provider', provider: 'codex', ready: true }),
      expect.objectContaining({ area: 'integration', provider: 'jev', ready: true }),
    ]));
    expect(ready.readiness.every((entry: { ready: boolean }) => entry.ready)).toBe(true);
    const saved = fs.readFileSync(path.join(artifacts, 'setup', 'plans', `${plan.id}.json`), 'utf8');
    expect(saved).not.toContain(env.AIWG_WALKTHROUGH_PROVIDER_INPUT);
    expect(saved).not.toContain(env.AIWG_WALKTHROUGH_JEV_INPUT);
    const snapshot = (): Map<string, { bytes: string; modified: number }> => {
      const files = new Map<string, { bytes: string; modified: number }>();
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (entry.isFile()) files.set(file, { bytes: fs.readFileSync(file).toString('base64'), modified: fs.statSync(file).mtimeMs });
        }
      };
      // Inspect project and plan writes, never the synthetic auth file.
      walk(project);
      return files;
    };
    const beforeRepeat = snapshot();
    expect(run(['--apply', '--yes', '--json'])).toMatchObject({ classification: 'success', results: [] });
    expect(snapshot()).toEqual(beforeRepeat);
    expect(fs.readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 240_000);
});
