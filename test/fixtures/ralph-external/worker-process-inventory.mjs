// Isolate synthetic workers' proc inventory from unrelated, unreadable host processes.
import { vi, afterAll, afterEach } from 'vitest';
import { symlinkSync, readFileSync, rmSync, readdirSync } from 'node:fs';

const inventory = vi.hoisted(() => ({ root: null, pidFiles: new Set() }));
vi.mock('../../../tools/ralph-external/lib/worker-invocation-processes.mjs', async importOriginal => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'aiwg-fixture-proc-'));
  inventory.root = root;
  afterEach(() => {
    inventory.pidFiles.clear();
    for (const name of readdirSync(root)) rmSync(join(root, name));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  return { ...actual, scanWorkerInvocationProcesses: options => {
    for (const file of inventory.pidFiles) {
      try { trackWorkerProcess(Number(readFileSync(file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return actual.scanWorkerInvocationProcesses({ procRoot: root, ...options });
  } };
});

export function trackWorkerProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { symlinkSync(`/proc/${pid}`, `${inventory.root}/${pid}`); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function trackWorkerPidFile(file) { inventory.pidFiles.add(file); }
