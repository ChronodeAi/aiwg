import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A reader can open the authority file just before a writer renames a new
// snapshot over it. Its descriptor then reports nlink 0. Simulate that
// interleaving deterministically by reporting nlink 0 for the next fstat.
const replaced = { next: false };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const stat = actual.fstatSync(...args) as fs.Stats;
      if (!replaced.next) return stat;
      replaced.next = false;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
    }) as typeof actual.fstatSync,
  };
});

const { FileAdmissionStore } = await import('../../../src/serve/shared-host-scheduler.js');

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })));

function durableStore() {
  const root = fs.mkdtempSync(join(tmpdir(), 'host-authority-replaced-'));
  directories.push(root);
  fs.chmodSync(root, 0o700);
  const path = join(root, 'admission.json');
  const store = new FileAdmissionStore(path);
  store.useDurableWrites();
  store.transact(() => undefined);
  return { store, path };
}

describe('FileAdmissionStore durable reads', () => {
  it('reads a snapshot whose file was atomically replaced after it was opened', () => {
    const { store } = durableStore();
    replaced.next = true;
    expect(store.read().revision).toBe(1);
    expect(replaced.next).toBe(false);
  });

  it('still refuses an authority file with an extra hard link', () => {
    const { store, path } = durableStore();
    fs.linkSync(path, `${path}.alias`);
    expect(() => store.read()).toThrow(/private bounded regular file/);
  });
});
