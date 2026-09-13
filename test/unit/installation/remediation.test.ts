/**
 * `installation show` must print the shell step that actually resolves drift.
 * `switch` and `adopt` only write installation.json, so neither can change which
 * binary is on PATH — the operator needs a command this output never named.
 *
 * @issue #2534
 */
import { describe, it, expect } from 'vitest';
import { remediation } from '../../../src/cli/handlers/installation.js';

type Status = Parameters<typeof remediation>[0];

function status(overrides: Partial<Status>): Status {
  return {
    state: 'mismatch',
    actualMethod: 'npm',
    actualRoot: '/home/u/.nvm/lib/node_modules/aiwg',
    frameworkRoot: '/home/u/.nvm/lib/node_modules/aiwg',
    drift: [],
    identity: { method: 'source', root: '/home/u/dev/aiwg' },
    ...overrides,
  } as Status;
}

describe('installation remediation (#2534)', () => {
  it('returns nothing when the installation is aligned', () => {
    expect(remediation(status({ state: 'aligned' }))).toBeNull();
  });

  it('names npm link when a declared source install is shadowed by npm', () => {
    const lines = remediation(status({}));
    expect(lines?.join('\n')).toContain('cd /home/u/dev/aiwg && npm link');
    // The reported trap: switch looks like the fix but is a no-op here.
    expect(lines?.join('\n')).toContain('switch');
  });

  it('names npm install when a declared npm install is shadowed by source', () => {
    const lines = remediation(status({
      actualMethod: 'source',
      identity: { method: 'npm', root: '/usr/local/lib/node_modules/aiwg' },
    } as Partial<Status>));
    expect(lines?.join('\n')).toContain('npm i -g aiwg');
  });

  it('still explains the declaration-only limit for other directions', () => {
    const lines = remediation(status({
      actualMethod: 'web',
      identity: { method: 'source', root: undefined },
    } as Partial<Status>));
    expect(lines?.join('\n')).toContain('declaration-only');
  });
});
