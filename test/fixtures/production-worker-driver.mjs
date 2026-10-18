import { readFileSync } from 'node:fs';

export const interfaceVersion = 1;
export function register(factory) {
  const { cli, id, adapterFrame } = JSON.parse(readFileSync(new URL('./driver-config.json', import.meta.url), 'utf8'));
  factory(id, () => ({
    getName: () => id,
    buildWorkerArgs: (input, _profile, permissions) => [cli, '--model', input.selected.model, '--effort', input.selected.effort.value,
      '--sandbox', permissions.sandbox, '--approval', permissions.approval, '--final-output', input.finalPath],
    ...(adapterFrame ? { buildWorkerStdinFrame: brief => JSON.stringify({ message: brief.toString() }) } : {}),
  }));
}
