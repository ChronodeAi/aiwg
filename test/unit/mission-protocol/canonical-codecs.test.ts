// Covers canonical Mission validation and legacy projections with synthetic payloads.
import { describe, expect, it } from 'vitest';
import { decodeMission, encodeMission, normalizeMissionState, validateCanonicalMission } from '../../../src/mission-protocol/canonical-codecs.js';
import type { CanonicalMission, MissionSource, MissionTarget } from '../../../src/mission-protocol/types.js';

function mission(): CanonicalMission {
  return { apiVersion: 'mission.aiwg.io/v1', kind: 'Mission', metadata: { id: 'synthetic' },
    spec: { objective: 'Verify local fixture' }, status: { state: 'pending', terminal: false, artifacts: [] },
    provenance: { sourceContract: 'mission-plan', sourceVersion: 'unversioned' } };
}

describe('T-OG-01 canonical Mission compatibility boundaries', () => {
  it.each([
    ['success', 'completed'], ['canceled', 'cancelled'], ['timed_out', 'failed'],
    ['max-tokens', 'incomplete'], ['assigned', 'running'], ['scheduled', 'pending'],
    ['input-required', 'blocked'], ['manual-review', 'operator-review'],
    ['disconnected', 'unknown'], ['vendor-new-state', 'unknown'], [undefined, 'unknown'],
  ])('normalizes %s without inventing successful completion', (native, expected) => {
    expect(normalizeMissionState(native)).toBe(expected);
  });

  it.each([null, [], 7])('rejects non-object input %j', input => {
    expect(() => decodeMission(input, 'mission-plan')).toThrow('must be an object');
  });

  it.each(['missionId', 'mission_id', 'id', 'taskId', 'task_id', 'responseId', 'metadata'])
    ('reads a stable identity from %s', key => {
      const input = key === 'metadata' ? { metadata: { id: 'stable' } } : { [key]: 'stable' };
      expect(decodeMission(input, 'mission-plan').value.metadata.id).toBe('stable');
    });
  it('rejects a source without a stable identity', () => {
    expect(() => decodeMission({ goal: 'no id' }, 'mission-plan')).toThrow('stable identifier');
  });

  it.each([
    ['executor-v1', 'executor.aiwg.io/v1'], ['fleet-workload-v1', 'fleet-workload/v1'],
    ['graph-flow-v1', 'graph.flow.aiwg.io/v1'], ['activity-v1', 'activity.aiwg.io/v1'],
    ['uhp-2026-08-11', '2026-08-11'],
  ] as const)('decodes the supported %s source version', (source, version) => {
    expect(decodeMission({ id: 'fixture', objective: 'local', state: 'running' }, source))
      .toMatchObject({ sourceVersion: version, value: { status: { state: 'running' } } });
  });
  it.each(['apiVersion', 'api_version', 'schemaVersion', 'schema_version'])
    ('checks the legacy %s version field', key => {
      expect(decodeMission({ id: 'fixture', [key]: 'mission.aiwg.io/v1' }, 'mission-plan').sourceVersion)
        .toBe('mission.aiwg.io/v1');
      expect(() => decodeMission({ id: 'fixture', [key]: 'mission.aiwg.io/v2' }, 'mission-plan'))
        .toThrow('supported major is v1');
      expect(() => decodeMission({ id: 'fixture', [key]: 'unsupported' }, 'mission-plan'))
        .toThrow('Unsupported Mission source version');
    });

  it.each([
    [{ pending: ['p'] }, 'running'], [{ failed: ['f'] }, 'failed'],
    [{ completed: ['c'] }, 'completed'], [{}, 'unknown'],
  ])('infers ledger state from checkpoint %j', (checkpoint, state) => {
    expect(decodeMission({ id: 'ledger', checkpoint }, 'mission-ledger').value.status.state).toBe(state);
  });
  it.each(['nativeState', 'status', 'state', 'observed_state', 'observedState', 'nodeState'])
    ('honors the explicit %s lifecycle field', key => {
      expect(decodeMission({ id: 'fixture', [key]: 'failed' }, 'mission-control-session').value.status)
        .toMatchObject({ state: 'failed', terminal: true });
    });

  it('preserves metadata, unknown fields, lineage, budgets and typed artifact details', () => {
    const input = { missionId: 'rich', goal: 'Verify rich fixture', completionCriterion: 'All checks pass',
      createdAt: '2026-10-01', updatedAt: '2026-10-02', previous_response_id: 'parent',
      metadata: { vendor: true }, extensions: { custom: 1 }, vendor: { retained: true },
      status: { state: 'working', progress: 42 }, budgets: { maxAttempts: 2 },
      lineage: [null, 1, {}, { relation: 'parent', id: 'parent' }], partialOutput: 'progress',
      artifacts: [null, 1, { id: 'a', kind: 'report', uri: 'file:report', sha256: 'digest', mediaType: 'text/plain' },
        { fileId: 'b', media_type: 'application/json' }, { file_id: 'c' }, { uri: 'file:d' }, {}] };
    const result = decodeMission(input, 'a2a');
    expect(result.value).toMatchObject({ metadata: { id: 'rich', previousId: 'parent',
      createdAt: '2026-10-01', updatedAt: '2026-10-02', lineage: [{ relation: 'parent', id: 'parent' }] },
      spec: { completionCriterion: 'All checks pass', budgets: { maxAttempts: 2 } },
      status: { state: 'running', partialOutput: 'progress', artifacts: [
        { id: 'a', kind: 'report', uri: 'file:report', sha256: 'digest', mediaType: 'text/plain' },
        { id: 'b', mediaType: 'application/json' }, { id: 'c' }, { id: 'file:d' }, { id: 'artifact-6' },
      ] } });
    expect(result.preservedExtensions).toMatchObject({ custom: 1, metadata: { vendor: true },
      nativeStatus: { state: 'working', progress: 42 }, vendor: { retained: true } });
    input.vendor.retained = false;
    expect(result.preservedExtensions.vendor).toEqual({ retained: true });
  });

  it.each(['objective', 'title', 'prompt'])('accepts legacy %s and snake case metadata', key => {
    const result = decodeMission({ id: 'fixture', [key]: 'Legacy objective', created_at: 'created',
      updated_at: 'updated', completion_criterion: 'Finished', partial_output: 'partial' }, 'cockpit');
    expect(result.value).toMatchObject({ metadata: { createdAt: 'created', updatedAt: 'updated' },
      spec: { objective: 'Legacy objective', completionCriterion: 'Finished' }, status: { partialOutput: 'partial' } });
  });
  it('retains placeholders and warnings for missing objectives and unknown native state', () => {
    const result = decodeMission({ id: 'fixture', status: 'vendor-state', completion: 'Done', output: 'text' }, 'cockpit');
    expect(result.warnings).toHaveLength(2);
    expect(result.value.spec).toMatchObject({ completionCriterion: 'Done', objective: expect.stringContaining('legacy') });
    expect(result.value.status).toMatchObject({ state: 'unknown', nativeState: 'vendor-state', partialOutput: 'text' });
  });
  it('discovers nested UHP output files and deduplicates explicit artifacts', () => {
    const result = decodeMission({ id: 'response', objective: 'UHP fixture', artifacts: [{ id: 'existing' }],
      output: [{ content: [{ file_id: 'existing' }, { file_id: 'new', media_type: 'text/plain' },
        { nested: { file_id: 'no-media' } }, null, 'text'] }] }, 'uhp-2026-08-11');
    expect(result.value.status.artifacts.map(a => a.id)).toEqual(['existing', 'new', 'no-media']);
    expect(result.value.status.artifacts[1]).toMatchObject({ kind: 'uhp-file', mediaType: 'text/plain' });
  });

  it('round-trips canonical data as detached copies, with and without extensions', () => {
    for (const value of [mission(), { ...mission(), extensions: { local: { keep: true } } }]) {
      const decoded = decodeMission(value, 'canonical');
      const encoded = encodeMission(decoded.value, 'canonical');
      expect(encoded.value).toEqual(value);
      expect(encoded.value).not.toBe(value);
      expect(decoded.preservedExtensions).toEqual(value.extensions ?? {});
    }
  });
  it.each([
    [{ apiVersion: 'mission.aiwg.io/v2' }, 'version'], [{ kind: 'Task' }, 'kind'],
    [{ metadata: null }, 'metadata'], [{ spec: null }, 'spec'], [{ status: null }, 'status'],
    [{ provenance: null }, 'provenance'], [{ metadata: { id: '' } }, 'required identity'],
    [{ spec: { objective: '' } }, 'required identity'],
    [{ provenance: { sourceContract: '', sourceVersion: 'v1' } }, 'required identity'],
    [{ provenance: { sourceContract: 'fixture', sourceVersion: '' } }, 'required identity'],
    [{ status: { state: 'done' } }, 'not normalized'],
    [{ status: { state: 'completed', terminal: false } }, 'terminal flag'],
    [{ status: { state: 'pending', terminal: false, artifacts: {} } }, 'artifacts must be an array'],
  ])('rejects malformed canonical fields %j', (patch, error) => {
    expect(() => validateCanonicalMission({ ...mission(), ...patch })).toThrow(String(error));
  });

  it.each([
    ['mission-plan', 'goal', 'Verify local fixture'], ['mission-ledger', 'goal', 'Verify local fixture'],
    ['uhp-2026-08-11', 'object', 'response'], ['a2a', 'id', 'synthetic'],
    ['graph-flow-v1', 'runId', 'synthetic'], ['cockpit', 'title', 'Verify local fixture'],
    ['activity-v1', 'event', 'mission.projected'], ['executor-v1', 'mission_id', 'synthetic'],
    ['fleet-workload-v1', 'mission_id', 'synthetic'], ['mission-control-session', 'id', 'synthetic'],
  ] as Array<[MissionTarget, string, string]>)('projects the %s transport with its native identity fields', (target, key, expected) => {
    const result = encodeMission(mission(), target);
    expect(result.value).toHaveProperty(key, expected);
    expect(result).toMatchObject({ targetVersion: target, warnings: [], lossReport: [] });
  });
  it('requires loss authorization for lineage and reports budget and verification losses', () => {
    const value = mission();
    value.metadata.lineage = [{ relation: 'parent', id: 'parent' }];
    value.spec.budgets = { maxAttempts: 2 };
    value.status.verification = [{ name: 'unit', status: 'passed' }];
    expect(() => encodeMission(value, 'a2a')).toThrow('silently lose required semantics');
    const result = encodeMission(value, 'a2a', { allowLoss: true });
    expect(result.lossReport.map(loss => loss.path)).toEqual(['/status/verification', '/metadata/lineage', '/spec/budgets']);
    expect(result.warnings).toHaveLength(3);
    expect(encodeMission(value, 'fleet-workload-v1').lossReport.map(loss => loss.path)).toEqual(['/status/verification']);
  });
  it('preserves source identity, native state, transport, partial output and extension overrides', () => {
    const value = mission();
    value.provenance = { ...value.provenance, sourceId: 'response-id', transport: 'local' };
    value.spec.completionCriterion = 'Done'; value.status.nativeState = 'queued';
    value.status.partialOutput = [{ text: 'partial' }]; value.extensions = { vendor: 'retained' };
    expect(encodeMission(value, 'uhp-2026-08-11').value).toMatchObject({ id: 'response-id', status: 'queued', output: [{ text: 'partial' }] });
    expect(encodeMission(value, 'cockpit').value).toMatchObject({ source: 'local', completion: 'Done', extensions: { vendor: 'retained' } });
    expect(encodeMission(value, 'mission-plan').value).toMatchObject({ completionCriterion: 'Done' });
  });
});
