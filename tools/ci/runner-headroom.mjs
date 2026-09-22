#!/usr/bin/env node
/**
 * Print the runner headroom a watcher test depends on, before the unit suite
 * runs, so a recurrence carries its environment evidence in the same job log.
 *
 * Motivation (#2553): `WatchService › should detect file changes` has timed out
 * five times under CI load with "no events" from a real-filesystem chokidar
 * watch. One of those job logs also contained `activity log append failed
 * (non-fatal): disk full`. Whether the runner was out of disk, inodes, or
 * inotify watches is exactly the fact the failure never recorded.
 *
 * This script only reads and prints. It exits 0 unless a value cannot be read
 * at all, in which case it prints `unavailable` for that row and still exits 0:
 * headroom evidence must never turn a healthy run red.
 *
 * Usage:
 *   node tools/ci/runner-headroom.mjs [path]   # default: current directory
 */

import { readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '.');

function sysctl(name) {
  try {
    return readFileSync(`/proc/sys/fs/inotify/${name}`, 'utf8').trim();
  } catch {
    return 'unavailable';
  }
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function collectHeadroom(path = target) {
  const rows = [];
  try {
    const fs = statfsSync(path);
    const blockSize = Number(fs.bsize);
    rows.push(['disk free', gib(Number(fs.bavail) * blockSize)]);
    rows.push(['disk total', gib(Number(fs.blocks) * blockSize)]);
    rows.push(['inodes free', String(fs.ffree)]);
    rows.push(['inodes total', String(fs.files)]);
  } catch {
    rows.push(['disk free', 'unavailable'], ['disk total', 'unavailable'], ['inodes free', 'unavailable'], ['inodes total', 'unavailable']);
  }
  rows.push(['inotify max_user_watches', sysctl('max_user_watches')]);
  rows.push(['inotify max_user_instances', sysctl('max_user_instances')]);
  rows.push(['inotify max_queued_events', sysctl('max_queued_events')]);
  rows.push(['memory free', gib(freemem())]);
  rows.push(['memory total', gib(totalmem())]);
  rows.push(['cpus', String(cpus().length)]);
  rows.push(['load average (1m)', loadavg()[0].toFixed(2)]);
  return rows;
}

export function formatHeadroom(rows, path = target) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    `Runner headroom for ${path} (#2553)`,
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(formatHeadroom(collectHeadroom(target), target));
}
