/**
 * CI hang reporter.
 *
 * A wedged worker never completes the run, so vitest's own exit guard — armed
 * only after the run finishes — never fires. The job then dies at
 * `timeout-minutes` with no attribution. This wrapper bounds the run below that
 * and names what is still alive.
 *
 * @issue #2521
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseDuration,
  parseArgs,
  parsePsLine,
  renderProcessReport,
} from '../../../tools/ci/run-with-hang-report.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/ci/run-with-hang-report.mjs',
);

describe('parseDuration', () => {
  it('accepts the suffixes CI configs actually use', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('12m')).toBe(720_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('250')).toBe(250);
  });

  it('refuses a value it cannot interpret rather than defaulting silently', () => {
    // A misread bound is worse than no bound: it would kill a healthy run.
    for (const bad of ['', 'soon', '12 minutes', '-5s', undefined]) {
      expect(() => parseDuration(bad), String(bad)).toThrow(/Invalid duration/);
    }
  });
});

describe('parseArgs', () => {
  it('splits options from the command at --', () => {
    const parsed = parseArgs(['--timeout', '5m', '--grace', '10s', '--', 'npm', 'test', '--', '--run']);
    expect(parsed.timeoutMs).toBe(300_000);
    expect(parsed.graceMs).toBe(10_000);
    expect(parsed.command).toEqual(['npm', 'test', '--', '--run']);
  });

  it('defaults the bound and grace period', () => {
    const parsed = parseArgs(['--', 'echo', 'hi']);
    expect(parsed.timeoutMs).toBe(720_000);
    expect(parsed.graceMs).toBe(30_000);
  });

  it('rejects a missing command and an unknown option', () => {
    expect(() => parseArgs(['--timeout', '5m'])).toThrow(/No command given/);
    expect(() => parseArgs(['--nope', '--', 'echo'])).toThrow(/Unknown option/);
  });
});

describe('parsePsLine', () => {
  it('reads a ps row', () => {
    expect(parsePsLine('  1234  1200    05:12 Sl    4096 node /path/to/vitest run')).toEqual({
      pid: 1234, ppid: 1200, etime: '05:12', stat: 'Sl', rss: 4096, args: 'node /path/to/vitest run',
    });
  });

  it('ignores the header and malformed rows', () => {
    expect(parsePsLine('  PID  PPID ELAPSED STAT   RSS COMMAND')).toBeNull();
    expect(parsePsLine('')).toBeNull();
  });
});

describe('renderProcessReport', () => {
  const procs = [
    { pid: 100, ppid: 1, etime: '10:00', stat: 'Ss', rss: 1, args: 'npm test' },
    { pid: 101, ppid: 100, etime: '09:58', stat: 'Sl', rss: 2, args: 'node vitest run' },
    { pid: 102, ppid: 101, etime: '09:00', stat: 'S', rss: 3, args: 'git init' },
    { pid: 900, ppid: 1, etime: '20:00', stat: 'Ss', rss: 4, args: 'node orphaned-aiwg-child.mjs' },
    { pid: 901, ppid: 1, etime: '20:00', stat: 'Ss', rss: 5, args: '/usr/sbin/cron -f' },
  ];

  it('renders the full descendant chain, not just the direct child', () => {
    // The blocking process is usually a grandchild — a report that stops at
    // depth 1 names the runner instead of the thing holding it.
    const { tree } = renderProcessReport(procs, 100);
    expect(tree.join('\n')).toContain('100 [Ss 10:00] npm test');
    expect(tree.join('\n')).toContain('101 [Sl 09:58] node vitest run');
    expect(tree.join('\n')).toContain('102 [S 09:00] git init');
  });

  it('surfaces a detached process that left the subtree', () => {
    const { strays } = renderProcessReport(procs, 100);
    expect(strays.map((p) => p.pid)).toEqual([900]);
  });

  it('survives a cyclic ppid without looping forever', () => {
    const cyclic = [
      { pid: 10, ppid: 11, etime: '1', stat: 'S', rss: 1, args: 'a' },
      { pid: 11, ppid: 10, etime: '1', stat: 'S', rss: 1, args: 'b' },
    ];
    expect(() => renderProcessReport(cyclic, 10)).not.toThrow();
  });
});

describe('end to end', () => {
  it('passes a healthy command through with its own exit code', () => {
    const ok = spawnSync(process.execPath, [SCRIPT, '--timeout', '30s', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 60_000 });
    expect(ok.status).toBe(0);

    const fail = spawnSync(process.execPath, [SCRIPT, '--timeout', '30s', '--', process.execPath, '-e', 'process.exit(7)'], { encoding: 'utf8', timeout: 60_000 });
    expect(fail.status).toBe(7);
  });

  it('bounds a hung command, reports the blocking grandchild, and leaves nothing behind', () => {
    const hang = spawnSync(
      process.execPath,
      [SCRIPT, '--timeout', '2s', '--grace', '1s', '--',
        process.execPath, '-e',
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); setInterval(()=>{},1000)"],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(hang.status).toBe(124);
    expect(hang.stderr).toMatch(/exceeded 2000ms without exiting/);
    expect(hang.stderr).toMatch(/live descendants of the test run/);
    // The grandchild is the point: the direct child alone would not explain a hang.
    expect(hang.stderr.split('live descendants of the test run:')[1]).toMatch(/setInterval/);
  }, 70_000);
});
