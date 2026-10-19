import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// One build per corpus lane; individual fresh HOMEs consume these immutable tables.
export default async function setup() {
  const root = path.resolve(import.meta.dirname, '../..');
  await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'tools/release/build-fortemi-core-indices.mjs'], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
}
