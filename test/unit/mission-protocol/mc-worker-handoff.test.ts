import { describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), mkdir: vi.fn(), open: vi.fn(), writeFile: vi.fn(), launch: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, promises: { ...actual.promises, readFile: mocks.readFile, mkdir: mocks.mkdir, open: mocks.open, writeFile: mocks.writeFile } };
});
vi.mock('../../../src/cli/handlers/ralph-launcher.js', () => ({ launchExternalRalph: mocks.launch }));
import { mcHandler } from '../../../src/cli/handlers/mc.js';
import { decodeMission, encodeMission } from '../../../src/mission-protocol/codecs.js';

describe('Mission Control worker boundary', () => {
  it('preserves managed generation, launch claim, execution identity and artifacts in Mission checkpoints', () => {
    const checkpoint = {
      admissionRequestId: 'synthetic.request', admissionGeneration: 7, admissionState: 'uncertain',
      admissionLaunchClaimed: true, admissionExecution: { pid: 4242, startedAt: 'synthetic-boot:123:1000' },
      ralphLoopId: 'synthetic-loop',
    };
    const mission = decodeMission({ id: 'synthetic', objective: 'synthetic', status: 'paused', ...checkpoint,
      artifacts: [{ id: 'partial', kind: 'other', uri: 'file:///synthetic/partial' }],
    }, 'mission-control-session').value;
    expect(mission.extensions?.['aiwg.source.mission-control-session']).toMatchObject(checkpoint);
    expect(mission.status.state).toBe('blocked');
    for (const target of ['mission-control-session', 'mission-ledger', 'graph-flow-v1'] as const) {
      const encoded = encodeMission(mission, target).value as any;
      const extensions = encoded.extensions ?? encoded.metadata;
      expect(extensions['aiwg.source.mission-control-session']).toMatchObject(checkpoint);
    }
    expect(encodeMission(mission, 'mission-control-session').value).toMatchObject({
      artifacts: [expect.objectContaining({ id: 'partial', uri: 'file:///synthetic/partial' })],
    });
  });

  it.each([
    ['run', 'session'], ['run', 'mission'],
    ['dispatch', 'session'], ['dispatch', 'mission'],
  ])('blocks %s with loaded %s extensions before mutation, admission or Ralph spawn', async (command, location) => {
    const session: any = {
      id: 'mc-synthetic', state: 'active', missions: [{ id: 'synthetic', status: 'queued', mode: 'direct',
        objective: 'synthetic', completion: 'never spawn', maxIterations: 1 }],
    };
    const owner = location === 'session' ? session : session.missions[0];
    owner.extensions = { 'aiwg.worker-dispatch': { version: 999, requiredFeatures: ['worker.future.v2'] } };
    mocks.readFile.mockResolvedValue(JSON.stringify(session));
    const args = command === 'run'
      ? ['run', session.id, '--accept-cost']
      : ['dispatch', session.id, 'synthetic', '--completion', 'never spawn'];
    const result = await mcHandler.execute({ args, rawArgs: [], cwd: '/synthetic', frameworkRoot: '/synthetic' } as HandlerContext);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/OG_CONTRACT_UNSUPPORTED/);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
