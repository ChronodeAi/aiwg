/** Bind pure artifact declarations to the installed adapter's argv and invocation identity. */
import { validateWorkerArtifacts } from '../serve/worker-artifacts.mjs';

export function buildInstalledWorkerTransport(instance, input, profile, invocation, executable, environment) {
  const artifacts = typeof instance.buildWorkerArtifacts === 'function' ? instance.buildWorkerArtifacts(input) : undefined;
  validateWorkerArtifacts({ ...input, artifacts });
  return {
    argv: [executable, ...instance.buildWorkerArgs(input, profile, input.permissions)],
    stdin: invocation.stdin, envNames: Object.keys(environment),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}
