import { describe, expect, it } from 'vitest';
import { collectHeadroom, formatHeadroom } from '../../../tools/ci/runner-headroom.mjs';

describe('tools/ci/runner-headroom.mjs (#2553)', () => {
  it('collects every headroom row as a non-empty string', () => {
    const rows = collectHeadroom(process.cwd());
    const labels = rows.map(([label]) => label);
    expect(labels).toEqual([
      'disk free',
      'disk total',
      'inodes free',
      'inodes total',
      'inotify max_user_watches',
      'inotify max_user_instances',
      'inotify max_queued_events',
      'memory free',
      'memory total',
      'cpus',
      'load average (1m)',
    ]);
    for (const [, value] of rows) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
    expect(rows.find(([label]) => label === 'disk free')?.[1]).toMatch(/^\d+\.\d{2} GiB$|^unavailable$/);
    expect(rows.find(([label]) => label === 'cpus')?.[1]).toMatch(/^\d+$/);
  });

  it('marks an unreadable path unavailable instead of throwing', () => {
    const rows = collectHeadroom('/definitely/not/a/mounted/path');
    expect(rows.find(([label]) => label === 'disk free')?.[1]).toBe('unavailable');
    expect(rows.find(([label]) => label === 'inodes total')?.[1]).toBe('unavailable');
    // Non-filesystem rows are still reported.
    expect(rows.find(([label]) => label === 'cpus')?.[1]).toMatch(/^\d+$/);
  });

  it('formats an aligned, labelled report', () => {
    const output = formatHeadroom([['disk free', '1.00 GiB'], ['inotify max_user_watches', '8192']], '/work');
    expect(output.split('\n')).toEqual([
      'Runner headroom for /work (#2553)',
      '  disk free                 1.00 GiB',
      '  inotify max_user_watches  8192',
    ]);
  });
});
