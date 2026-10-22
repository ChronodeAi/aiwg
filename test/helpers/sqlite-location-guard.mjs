import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFeaturesRoot } from '../../src/features/paths.ts';

// Emulate an absent base-install peer without moving or deleting any packages.
// The selected feature package remains the real native implementation.
const mode = process.env.AIWG_TEST_SQLITE_LOCATION;
if (mode === 'feature-only' || mode === 'absent') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const featureRoot = getFeaturesRoot();
      const featureParent = pathToFileURL(join(featureRoot, 'package.json')).href;
      if (specifier === 'better-sqlite3'
        && (mode === 'absent' || context.parentURL !== featureParent
          || !existsSync(join(featureRoot, 'node_modules', 'better-sqlite3', 'package.json')))) {
        const error = new Error('SQLite fixture: base-install native peer is unavailable');
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return nextResolve(specifier, context);
    },
  });
}
