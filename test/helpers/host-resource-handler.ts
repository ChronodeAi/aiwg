// Installed model handler fixture with deterministic /proc and filesystem readers.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { idleHostResourceReaders } from '../fixtures/host-resources.js';

export function installedHostResourceReaders(): string {
  const files = Object.fromEntries(['/proc/meminfo', '/proc/loadavg', '/proc/pressure/memory']
    .map(name => [name, idleHostResourceReaders().readText(name)]));
  return `{ readText: p => (${JSON.stringify(files)})[p], coreCount: () => 8,
    countWorkers: () => 0, statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) }`;
}

export function installedResourceModelsHandler(installed: string): string {
  return `await (async () => {
    const { createModelsHandler, loadWorkerInputs } = await import(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/src/cli/handlers/models.js')).href)});
    return createModelsHandler({ load: ctx => loadWorkerInputs(ctx, ${installedHostResourceReaders()}) });
  })()`;
}
