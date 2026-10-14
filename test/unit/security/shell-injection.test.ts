import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import {
  checkGhAuth, checkPRExists, checkRateLimit, commentOnPR, createPR,
  forkRepo, getPRReviewComments, getPRReviews, getPRStatus, getUsername,
} from '../../../tools/contrib/lib/github-client.mjs';
import { TmuxManager } from '../../../tools/daemon/tmux-manager.mjs';
import { resolveAdapter } from '../../../src/artifacts/corpus-tools/vision-extract.js';

const require = createRequire(import.meta.url);
let root: string;
let capture: string;
let dollarMarker: string;
let backtickMarker: string;
let payload: string;

function fakeBinary(name: string, behavior: string): void {
  writeFileSync(join(root, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.COMMAND_CAPTURE, JSON.stringify({ binary: ${JSON.stringify(name)}, args, input }) + '\\n');
${behavior}
`, { mode: 0o755 });
}

function calls(): { binary: string; args: string[]; input: string }[] {
  return readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function expectNoExecution(): void {
  expect(existsSync(dollarMarker)).toBe(false);
  expect(existsSync(backtickMarker)).toBe(false);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-shell-injection-'));
  capture = join(root, 'calls.jsonl');
  dollarMarker = join(root, 'pwned-dollar');
  backtickMarker = join(root, 'pwned-backtick');
  payload = `$(touch ${dollarMarker}) \`touch ${backtickMarker}\` "double" 'single' \\ $HOME`;
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
  vi.stubEnv('COMMAND_CAPTURE', capture);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('shell injection regressions (#3093)', () => {
  it('keeps the packaged Ralph commit hook identical to the addon source', () => {
    expect(readFileSync(resolve('agentic/code/plugins/agent-loop/hooks/ralph-commit.js'), 'utf8'))
      .toBe(readFileSync(resolve('agentic/code/addons/agent-loop/hooks/ralph-commit.js'), 'utf8'));
  });

  it.each(['addons', 'plugins'])('passes Ralph %s filenames, summary and task through commit stdin', (tree) => {
    vi.stubEnv('FAKE_FILENAME', `${payload}.txt`);
    fakeBinary('git', `if (args[0] === 'status') process.stdout.write(' M ' + process.env.FAKE_FILENAME + '\\n');`);
    // Hooks are CommonJS payloads installed outside the repository's ESM scope.
    const module = { exports: {} as { commitIteration: (state: object, summary: string) => { committed: boolean } } };
    runInNewContext(readFileSync(resolve(`agentic/code/${tree}/agent-loop/hooks/ralph-commit.js`), 'utf8'), {
      require, module, process, console,
    });
    const hook = module.exports;
    const result = hook.commitIteration({ currentIteration: 2, maxIterations: 3, task: payload }, payload);
    expect(result.committed).toBe(true);
    const commit = calls().find(call => call.args[0] === 'commit')!;
    expect(commit.args).toEqual(['commit', '-F', '-']);
    expect(commit.input).toContain(`ralph: iteration 2 - ${payload}`);
    expect(commit.input).toContain(`Task: ${payload}`);
    expect(commit.input).toContain(`${payload}.txt`);
    expectNoExecution();
  });

  it('sends tmux text literally with separate Enter keys, including empty status lines', () => {
    fakeBinary('tmux', '');
    const tmux = new TmuxManager({ sessionName: payload });
    tmux.sendToPane(0, payload);
    tmux.sendToPane(1, '-Enter C-c', false);
    tmux.updateStatusPane(`${payload}\n\nEnter C-c`);
    const sent = calls().filter(call => call.args[0] === 'send-keys').map(call => call.args);
    expect(sent).toEqual([
      ['send-keys', '-t', `${payload}:0.0`, '-l', '--', payload],
      ['send-keys', '-t', `${payload}:0.0`, 'Enter'],
      ['send-keys', '-t', `${payload}:0.1`, '-l', '--', '-Enter C-c'],
      ['send-keys', '-t', `${payload}:0.1`, 'C-c'],
      ['send-keys', '-t', `${payload}:0.1`, 'C-l'],
      ['send-keys', '-t', `${payload}:0.1`, '-l', '--', payload],
      ['send-keys', '-t', `${payload}:0.1`, 'Enter'],
      ['send-keys', '-t', `${payload}:0.1`, '-l', '--', ''],
      ['send-keys', '-t', `${payload}:0.1`, 'Enter'],
      ['send-keys', '-t', `${payload}:0.1`, '-l', '--', 'Enter C-c'],
      ['send-keys', '-t', `${payload}:0.1`, 'Enter'],
    ]);
    expectNoExecution();
  });

  it('passes gh title and labels as argv and body/comment as stdin', () => {
    fakeBinary('gh', `
if (args[0] === 'auth') process.stderr.write('Logged in to github.com account tester');
if (args[1] === 'create') process.stdout.write('https://github.com/owner/repo/pull/42\\n');
`);
    expect(checkGhAuth()).toEqual({ authenticated: true, username: 'tester', error: null });
    expect(createPR(payload, `${payload}\nsecond line`, [payload, 'bug'], true))
      .toEqual({ success: true, number: 42, url: 'https://github.com/owner/repo/pull/42', error: null });
    expect(commentOnPR(42, payload)).toEqual({ success: true, error: null });
    const created = calls().find(call => call.args[1] === 'create')!;
    expect(created.args).toEqual(['pr', 'create', '--title', payload, '--body-file', '-', '--draft', '--label', `${payload},bug`]);
    expect(created.input).toBe(`${payload}\nsecond line`);
    const comment = calls().find(call => call.args[1] === 'comment')!;
    expect(comment.args).toEqual(['pr', 'comment', '42', '--body-file', '-']);
    expect(comment.input).toBe(payload);
    expectNoExecution();
  });

  it('preserves structured gh errors without executing comment data', () => {
    fakeBinary('gh', `
if (args[0] === 'auth') process.stderr.write('Logged in to github.com account tester');
else { process.stderr.write('permission denied'); process.exit(1); }
`);
    expect(createPR(payload, payload).error).toContain('permission denied');
    expect(commentOnPR(42, payload)).toEqual({ success: false, error: 'Failed to comment on PR: permission denied' });
    expect(calls().find(call => call.args[1] === 'comment')!.input).toBe(payload);
    expectNoExecution();
  });

  it('preserves gh caller result contracts for fork, status, reviews and rate limits', () => {
    fakeBinary('gh', `
if (args[0] === 'auth') process.stderr.write('Logged in to github.com account tester');
else if (args[1] === 'list') process.stdout.write(JSON.stringify([{ number: 42, state: 'OPEN' }]));
else if (args[1] === 'view' && args[0] === 'pr') process.stdout.write(JSON.stringify({ state: 'OPEN', reviews: [] }));
else if (args[1] === 'rate_limit') process.stdout.write(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999, reset: 1 } } }));
else if (args[0] === 'api') process.stdout.write('[]');
`);
    expect(getUsername().username).toBe('tester');
    expect(forkRepo('owner/repo').alreadyExists).toBe(true);
    expect(getPRStatus(42).status.state).toBe('OPEN');
    expect(checkPRExists('owner/repo').hasPR).toBe(true);
    expect(getPRReviews(42).reviews).toEqual([]);
    expect(getPRReviewComments(42).comments).toEqual([]);
    expect(checkRateLimit().remaining).toBe(4999);
  });

  it.each(['HOME-derived', 'configured'])('passes a %s channel clone path literally to git', (source) => {
    fakeBinary('git', `if (args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });`);
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    const homeDir = join(root, payload);
    const edgePath = source === 'HOME-derived'
      ? join(homeDir, '.local', 'share', 'ai-writing-guide')
      : join(root, `configured-${payload}`);
    if (source === 'configured') writeFileSync(join(configDir, 'channel.json'), JSON.stringify({ edgePath }));
    const managerUrl = new URL('../../../src/channel/manager.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { switchToEdge } = await import(${JSON.stringify(managerUrl)});
      await switchToEdge();
    `], {
      env: { ...process.env, HOME: homeDir, AIWG_CONFIG: configDir, AIWG_CLI_DRY_RUN: '1' },
      stdio: 'pipe', timeout: 30_000,
    });
    expect(calls().find(call => call.args[0] === 'clone')!.args).toEqual([
      'clone', '--branch', 'main', 'https://github.com/jmagly/aiwg.git', edgePath,
    ]);
    expect(calls().filter(call => call.args[0] === 'sparse-checkout').map(call => call.args)).toEqual([
      ['sparse-checkout', 'init', '--cone'],
      ['sparse-checkout', 'set', '--no-cone', '/*', '!/.aiwg'],
    ]);
    expect(JSON.parse(readFileSync(join(configDir, 'channel.json'), 'utf8')).edgePath).toBe(edgePath);
    expectNoExecution();
  });

  it('quotes all vision path placeholders literally while preserving shell templates', () => {
    fakeBinary('vision-probe', `
const [image, promptFile, out] = args;
if (fs.readFileSync(image, 'utf8') !== 'PNG') process.exit(1);
fs.writeFileSync(out, fs.readFileSync(promptFile, 'utf8'));
`);
    const dir = join(root, `${payload} {image} {prompt_file} {out}`);
    mkdirSync(dir, { recursive: true });
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    const adapter = resolveAdapter({ provider: 'command', command: 'vision-probe {image} {prompt_file} {out}' });
    expect(adapter.transcribe(image, '# Page 1\nLiteral transcription', { root, page: 1, timeoutSec: 10 }))
      .toEqual({ ok: true, text: '# Page 1\nLiteral transcription' });
    expect(calls()[0].args).toEqual([image, join(dir, '.vision-prompt-1.txt'), join(dir, '.vision-out-1.txt')]);
    expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    expect(existsSync(join(dir, '.vision-out-1.txt'))).toBe(false);
    expectNoExecution();
  });
});
