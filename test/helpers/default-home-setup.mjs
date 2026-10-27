// Redirect native home resolution before Vitest starts its worker threads.
import { createTemporaryHome } from './temporary-home.mjs';

// CODEX_HOME stays unset rather than pointing at the temporary home: provider
// detection treats a set CODEX_HOME as a Codex session signal, and Codex paths
// already fall back to the temporary HOME.
const UNSET = ['CODEX_HOME'];

export default function setup(project) {
  const { home, env: homeEnv, cleanup } = createTemporaryHome('aiwg-default-home-');
  const env = Object.fromEntries(Object.entries(homeEnv).filter(([key]) => !UNSET.includes(key)));
  const previous = Object.fromEntries([...Object.keys(env), ...UNSET].map(key => [key, process.env[key]]));
  const previousConfigEnv = project.config.env;
  Object.assign(process.env, env);
  for (const key of UNSET) delete process.env[key];
  project.config.env = { ...previousConfigEnv, ...env };
  project.provide('defaultLaneHome', home);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    project.config.env = previousConfigEnv;
    cleanup();
  };
}
