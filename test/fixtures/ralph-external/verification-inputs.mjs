// Supply synthetic installed qualification roots to the offline CLI subprocess.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function loadWorkerInputs() {
  const roots = JSON.parse(readFileSync(new URL('./qualified-roots.json', import.meta.url), 'utf8'));
  return { drivers: { fixture: { qualification: { installation: { workerWritableRoots: roots } } } } };
}

const self = import.meta.url;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('file:') && fileURLToPath(resolved.url).endsWith('/dist/src/cli/handlers/models.js')) {
      return { url: self, shortCircuit: true };
    }
    return resolved;
  },
});
