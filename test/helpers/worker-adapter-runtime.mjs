// Copy the shared adapter runtime closure into synthetic installed packages.
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function copyWorkerAdapterRuntime(base, packageRoot) {
  for (const name of ['provider-adapter.mjs', 'worker-health.mjs', 'strict-worker-json.mjs', 'session-attempt.mjs']) {
    const destination = join(packageRoot, 'lib', name);
    await copyFile(resolve('tools/ralph-external/lib', name), destination);
    await chmod(destination, 0o644);
  }
  await mkdir(join(base, 'src/models'), { recursive: true, mode: 0o755 });
  await copyFile(resolve('src/models/qualification-digest.mjs'), join(base, 'src/models/qualification-digest.mjs'));
}
