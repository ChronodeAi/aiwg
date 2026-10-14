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
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';

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

// Exercise the private adapter's complete result contract without exporting it.
function execGhResult(): { success: boolean; stdout: string; stderr: string; error: Error | null } {
  const source = readFileSync(resolve('tools/contrib/lib/github-client.mjs'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');
  return runInNewContext(`${source}\nexecGh(['api', 'rate_limit']);`, { boundedSpawnSync });
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

  it('preserves the execGh result contract when gh is missing (ENOENT)', () => {
    vi.stubEnv('PATH', root);
    const result = execGhResult();
    expect(Object.keys(result).sort()).toEqual(['error', 'stderr', 'stdout', 'success']);
    expect(result).toMatchObject({ success: false, stdout: '', stderr: expect.stringContaining('ENOENT') });
    expect(result.error).toMatchObject({ code: 'ENOENT', message: result.stderr });
    expect(checkRateLimit()).toEqual({
      success: false, limit: null, remaining: null, reset: null,
      error: `Failed to check rate limit: ${result.stderr}`,
    });
  });

  it.each(['permission denied\n', ''])('preserves the execGh result contract on non-zero exit with stderr %j', (stderr) => {
    fakeBinary('gh', `process.stdout.write(' partial output \\n'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`);
    const result = execGhResult();
    expect(Object.keys(result).sort()).toEqual(['error', 'stderr', 'stdout', 'success']);
    const detail = stderr || 'gh exited with code 7';
    expect(result).toMatchObject({ success: false, stdout: ' partial output \n', stderr: detail });
    expect(result.error).toMatchObject({ name: 'Error', message: detail });
    expect(checkRateLimit()).toEqual({
      success: false, limit: null, remaining: null, reset: null,
      error: `Failed to check rate limit: ${detail}`,
    });
  });

  it.each(['--help', '-1', 0, -1, 1.5, '1.5', '1e2', '42 --help', '', Number.MAX_SAFE_INTEGER + 1])('rejects invalid PR number %j before invoking gh', (prNumber) => {
    fakeBinary('gh', '');
    const error = 'PR number must be a positive integer';
    expect(getPRStatus(prNumber)).toEqual({ success: false, status: null, error });
    expect(commentOnPR(prNumber, payload)).toEqual({ success: false, error });
    expect(getPRReviews(prNumber)).toEqual({ success: false, reviews: null, error });
    expect(getPRReviewComments(prNumber)).toEqual({ success: false, comments: null, error });
    expect(existsSync(capture)).toBe(false);
    expectNoExecution();
  });

  it.each(['--help/repo', 'owner/--help', '--help', 'owner/repo --help', 'owner', 'owner/repo/extra'])('rejects invalid repository %s before invoking gh', (upstream) => {
    fakeBinary('gh', '');
    const error = 'Repository must be in owner/repo format';
    expect(forkRepo(upstream)).toEqual({ success: false, fork: null, alreadyExists: false, error });
    expect(checkPRExists(upstream)).toEqual({ success: false, hasPR: false, pr: null, error });
    expect(existsSync(capture)).toBe(false);
  });

  it.each(['42', '042'])('accepts numeric PR string %s and a repository with a dot-prefixed name', (prNumber) => {
    fakeBinary('gh', `
if (args[0] === 'auth') process.stderr.write('Logged in to github.com account tester');
else if (args[1] === 'list') process.stdout.write('[]');
else if (args[1] === 'view' && args[0] === 'pr') process.stdout.write('{"state":"OPEN"}');
`);
    expect(getPRStatus(prNumber)).toEqual({ success: true, status: { state: 'OPEN' }, error: null });
    expect(forkRepo('owner/.github')).toEqual({ success: true, fork: 'tester/.github', alreadyExists: true, error: null });
    expect(checkPRExists('owner/.github')).toEqual({ success: true, hasPR: false, pr: null, error: null });
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
      'clone', '--branch', 'main', '--', 'https://github.com/jmagly/aiwg.git', edgePath,
    ]);
    expect(calls().filter(call => call.args[0] === 'sparse-checkout').map(call => call.args)).toEqual([
      ['sparse-checkout', 'init', '--cone'],
      ['sparse-checkout', 'set', '--no-cone', '/*', '!/.aiwg'],
    ]);
    expect(JSON.parse(readFileSync(join(configDir, 'channel.json'), 'utf8')).edgePath).toBe(edgePath);
    expectNoExecution();
  });

  it.each(['--upload-pack=probe', 'relative-edge'])('rejects non-absolute edge path %s before invoking git', (edgePath) => {
    fakeBinary('git', '');
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'channel.json'), JSON.stringify({ edgePath }));
    const managerUrl = new URL('../../../src/channel/manager.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { switchToEdge } = await import(${JSON.stringify(managerUrl)});
      try { await switchToEdge(); } catch (error) { console.log(error.message); }
    `], {
      env: { ...process.env, HOME: root, AIWG_CONFIG: configDir, AIWG_CLI_DRY_RUN: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(output.trim()).toBe('Edge installation path must be absolute');
    expect(existsSync(capture)).toBe(false);
    expect(JSON.parse(readFileSync(join(configDir, 'channel.json'), 'utf8')).edgePath).toBe(edgePath);
  });

  it('passes all vision path placeholders as arguments and exports matching environment variables', () => {
    fakeBinary('vision-probe', `
const [imageFlag, image, promptFlag, promptFile] = args;
if (imageFlag !== '--image' || promptFlag !== '--prompt-file') process.exit(1);
if (image !== process.env.AIWG_VISION_IMAGE || promptFile !== process.env.AIWG_VISION_PROMPT_FILE || !process.env.AIWG_VISION_OUT) process.exit(1);
if (process.env.AIWG_VISION_OUT !== require('node:path').join(require('node:path').dirname(image), '.vision-out-1.txt')) process.exit(1);
if (fs.readFileSync(image, 'utf8') !== 'PNG') process.exit(1);
process.stdout.write(fs.readFileSync(promptFile, 'utf8'));
`);
    const dir = join(root, `x;:>PWNED;y ${payload} {image} {prompt_file} {out}`);
    mkdirSync(dir, { recursive: true });
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    const adapter = resolveAdapter({ provider: 'command', command: 'vision-probe --image {image} --prompt-file {prompt_file} > {out}' });
    expect(adapter.transcribe(image, '# Page 1\nLiteral transcription', { root, page: 1, timeoutSec: 10 }))
      .toEqual({ ok: true, text: '# Page 1\nLiteral transcription' });
    expect(calls()[0].args).toEqual(['--image', image, '--prompt-file', join(dir, '.vision-prompt-1.txt')]);
    expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    expect(existsSync(join(dir, '.vision-out-1.txt'))).toBe(false);
    expectNoExecution();
  });

  it.each(['image', 'prompt_file', 'out'])('rejects quoted vision {%s} placeholders before running the template', (placeholder) => {
    fakeBinary('vision-probe', '');
    for (const quoted of [`"{${placeholder}}"`, `'{${placeholder}}'`, `$'{${placeholder}}'`, `$'escaped\\' {${placeholder}}'`]) {
      const command = `touch ${dollarMarker}; vision-probe ${quoted}`;
      expect(() => resolveAdapter({ provider: 'command', command }))
        .toThrow('Vision command placeholders must be outside shell quotes');
    }
    expect(existsSync(capture)).toBe(false);
    expectNoExecution();
  });

  it('rejects escaped vision placeholders before running the template', () => {
    expect(() => resolveAdapter({ provider: 'command', command: `touch ${dollarMarker}; vision-probe \\{image}` }))
      .toThrow('Vision command placeholders must not be escaped');
    expectNoExecution();
  });
});
