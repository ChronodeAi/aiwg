/**
 * Clears every environment variable the shared interactive decision reads
 * (`isInteractive()` / `isCI()` in src/cli/env.ts), so a test that needs the
 * interactive path gets it on any host, including a CI runner that sets its
 * own markers. Returns a function that restores the previous values.
 */
import { CI_ENV_VARS, INTERACTIVE_ENV_VARS } from '../../src/cli/env.js';

export function clearInteractiveEnv(): () => void {
  const keys = [...CI_ENV_VARS, ...INTERACTIVE_ENV_VARS];
  const saved = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
