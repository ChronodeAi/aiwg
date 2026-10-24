import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectIndexRoot } from '../artifacts/types.js';

/** Refresh every existing local retrieval graph after an owner commit or recovery. */
export async function refreshMaintenanceIndexes(root: string): Promise<void> {
  const directory = getProjectIndexRoot(root);
  const graphs = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')
        && existsSync(join(directory, entry.name, 'metadata.json')))
      .map(entry => entry.name)
    : [];
  const { buildIndex } = await import('../artifacts/index-builder.js');
  for (const graph of ['', ...graphs]) {
    await buildIndex(root, { ...(graph ? { graph } : {}), force: true, quiet: true, workers: 0 });
  }
}
