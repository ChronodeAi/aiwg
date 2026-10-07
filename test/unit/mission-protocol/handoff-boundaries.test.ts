import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MissionConductor } from '../../../src/serve/mission-conductor.js';
import { FleetMissionConductor } from '../../../src/serve/fleet-mission-conductor.js';
import { InMemoryAdmissionStore, SharedHostScheduler } from '../../../src/serve/shared-host-scheduler.js';
import { projectUhpResponseToMission, projectUhpResponseToCanonicalMission } from '../../../src/uhp/mission.js';
import { extractGraphMetadata, graphMetadataRecord, projectGraphMetadata } from '../../../src/flow/graph-metadata.js';
import { executeFlowGraph } from '../../../agentic/code/addons/composition-engine/lib/runtime.mjs';
import { AgenticSandboxMcpClient } from '../../../src/mcp/tools/agentic-sandbox.mjs';
import { decodeMessage, decodeTask, encodeMessage, encodeTask } from '../../../src/a2a/codecs.js';
import { fleetMissionProjection, missionSummary } from '../../../apps/cockpit/bridge/src/server.mjs';
import { UhpClient } from '../../../src/uhp/client.js';
import { UHP_VERSION, type UhpEndpointProfile } from '../../../src/uhp/types.js';

const workerBinding = { 'aiwg.worker-dispatch': { version: 999, requiredFeatures: ['worker.future.v2'] } };
const validDispatch = JSON.parse(readFileSync(resolve('test/conformance/mission-v1/fixtures/worker-contracts/mission-vectors.json'), 'utf8'))
  .find((vector: any) => vector.id === 'dispatch-roundtrip').value;
const missionSchema = JSON.parse(readFileSync(resolve('schemas/mission-v1.schema.json'), 'utf8'));
const workerDefinitions = Object.keys(missionSchema.$defs).filter(name => name.startsWith('worker'));
const plan = { missionId: 'blocked-worker', goal: 'synthetic', completionCriterion: 'never launch', cycles: [] };
const graphIdentity = {
  schemaVersion: 'graph.flow.aiwg.io/v1' as const,
  graphId: 'synthetic', graphVersion: '1', runId: 'run', nodeId: 'node', nodeRunId: 'run:node',
};
function flow(name = 'linear-flow'): any {
  return JSON.parse(readFileSync(resolve('agentic/code/addons/composition-engine/fixtures', `${name}.json`), 'utf8'));
}

describe('unadvertised production consumer handoffs', () => {
  const uhpProfile: UhpEndpointProfile = {
    endpoint: 'https://uhp.example', version: UHP_VERSION,
    credential: { source: 'env', name: 'SYNTHETIC_UHP_TOKEN' }, experimental: true,
  };

  it('preserves the origin/main Cockpit summary for legacy output schemas with worker-like property names', () => {
    const mission = {
      id: 'legacy', goal: 'Legacy output', completion: 'done', status: 'completed',
      partialOutput: { properties: { 'aiwg.worker-dispatch': { type: 'string' } } },
    };
    expect(missionSummary(mission)).toEqual({
      id: 'legacy', title: 'Legacy output', completion: 'done', status: 'completed',
      loop: 0, max_iterations: 0, priority: 'normal', mode: 'direct',
      target_agent: undefined, ralph_loop_id: undefined, ralph_pid: undefined,
      started_at: undefined, completed_at: undefined, error: undefined, terminal: true,
    });
  });

  describe.each(['extensions', 'status.artifacts[].extensions'])('%s Mission schema carrier', carrier => {
    it.each([
      validDispatch,
      { ...validDispatch, version: 999 },
      { ...validDispatch, requiredFeatures: [...validDispatch.requiredFeatures, 'worker.future.v999'] },
    ])('blocks at Cockpit, MCP and Flow consumer guards', async dispatch => {
      const extensions = { 'aiwg.worker-dispatch': dispatch };
      const record: any = {
        apiVersion: 'mission.aiwg.io/v1', kind: 'Mission', metadata: { id: 'synthetic' },
        spec: { objective: 'synthetic' }, status: { state: 'pending', terminal: false, artifacts: [] },
        provenance: { sourceContract: 'synthetic', sourceVersion: 'unversioned' },
      };
      if (carrier === 'extensions') record.extensions = extensions;
      else record.status.artifacts = [{ id: 'artifact', kind: 'other', extensions }];
      expect(() => missionSummary(record)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
      expect(() => fleetMissionProjection(record, 'session')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
      const fetch = vi.fn();
      await expect(new AgenticSandboxMcpClient({ env: {}, fetch }).request('/synthetic', { body: record })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
      expect(fetch).not.toHaveBeenCalled();
      const manifest = flow();
      manifest.spec.nodes[0].inputs[0].schema = { type: 'object' };
      manifest.spec.nodes[0].inputs[0].value = record;
      const invokeNode = vi.fn();
      await expect(executeFlowGraph(manifest, { invokeNode })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
      expect(invokeNode).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['valid dispatch', validDispatch],
    ['unsupported revision', workerBinding['aiwg.worker-dispatch']],
  ])('blocks UHP create/stream/continue %s before resolving credentials or HTTP transmission', async (_name, dispatch) => {
    const fetch = vi.fn(async () => new Response('{}'));
    const credentials = vi.fn(async () => 'synthetic-test-only');
    const client = new UhpClient('synthetic', uhpProfile, fetch, credentials);
    const request = { input: 'synthetic', metadata: { 'aiwg.worker-dispatch': dispatch } };
    await expect(client.createResponse(request)).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    await expect(client.streamResponse(request).next()).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    await expect(client.continueResponse('resp_synthetic', request)).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([validDispatch, workerBinding['aiwg.worker-dispatch']])('blocks UHP JSON and streaming worker responses before returning or yielding', async dispatch => {
    const response = { id: 'resp_synthetic', object: 'response', created_at: 0, status: 'completed', model: 'synthetic', output: [], metadata: { 'aiwg.worker-dispatch': dispatch } };
    const jsonClient = new UhpClient('synthetic', uhpProfile, async () => new Response(JSON.stringify(response), {
      headers: { 'UHP-Version': UHP_VERSION, 'Content-Type': 'application/json' },
    }), async () => 'synthetic-test-only');
    await expect(jsonClient.createResponse({ input: 'synthetic' })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    await expect(jsonClient.readResponse('resp_synthetic')).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    const streamClient = new UhpClient('synthetic', uhpProfile, async () => new Response(
      `data: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response })}\n\n`,
      { headers: { 'UHP-Version': UHP_VERSION, 'Content-Type': 'text/event-stream' } },
    ), async () => 'synthetic-test-only');
    await expect(streamClient.streamResponse({ input: 'synthetic' }).next()).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
  });

  it.each([validDispatch, workerBinding['aiwg.worker-dispatch']])('blocks Cockpit legacy, canonical and fleet worker records before projection', dispatch => {
    const extensions = { 'aiwg.worker-dispatch': dispatch };
    expect(() => missionSummary({ id: 'synthetic', objective: 'synthetic', status: 'queued', extensions })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => missionSummary({ apiVersion: 'mission.aiwg.io/v1', kind: 'Mission', metadata: { id: 'synthetic' }, spec: { objective: 'synthetic' }, status: { state: 'pending' }, extensions })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => fleetMissionProjection({ lineage: { child_id: 'synthetic' }, status: { observed_state: 'pending' }, metadata: extensions }, 'session')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it.each(['0.3', '1.0'] as const)('blocks A2A %s metadata at existing encode/decode boundaries', version => {
    const message: any = { messageId: 'synthetic', role: 'user', parts: [{ type: 'text', text: 'synthetic' }], metadata: workerBinding };
    const task: any = { id: 'synthetic', status: { state: 'submitted' }, metadata: workerBinding };
    expect(() => encodeMessage(version, message)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => decodeMessage(version, message)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => encodeTask(version, task)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => decodeTask(version, task)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    message.metadata = undefined;
    message.parts[0].metadata = workerBinding;
    expect(() => encodeMessage(version, message)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it.each([
    ['valid revision and features', validDispatch],
    ['unknown required feature', { ...validDispatch, requiredFeatures: [...validDispatch.requiredFeatures, 'worker.future.v2'] }],
  ])('blocks %s through existing owners without advertising runtime support', async (_name, dispatch) => {
    const extensions = { 'aiwg.worker-dispatch': dispatch };
    const runWorker = vi.fn();
    await expect(new MissionConductor({ runWorker }).conduct({ ...plan, extensions } as any, [])).rejects.toThrow(/OG_CONTRACT_UNSUPPORTED/);
    await expect(new FleetMissionConductor({ runWorker }).conduct({ ...plan, extensions, aggregation: 'all' } as any, [])).rejects.toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(runWorker).not.toHaveBeenCalled();
    const response: any = { id: 'response', object: 'response', created_at: 0, status: 'completed', output: [], metadata: extensions };
    expect(() => projectUhpResponseToMission('fake', response)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => projectUhpResponseToCanonicalMission('fake', response)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => projectGraphMetadata({ ...graphIdentity, extensions } as any, 'internal')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it.each(['plan', 'cycle', 'resume'] as const)('blocks Mission and Fleet %s extensions before any worker or durable write', async location => {
    const runWorker = vi.fn();
    const save = vi.fn();
    const input: any = { ...plan, cycles: [{ id: 'one', runtime: 'codex', prompt: 'synthetic', workloadKind: 'one-shot-command' }], aggregation: 'all' };
    const resume: any = { ...plan, cycles: [], checkpoint: { completed: [], pending: [], failed: [] } };
    if (location === 'plan') input.extensions = workerBinding;
    if (location === 'cycle') input.cycles[0].metadata = workerBinding;
    if (location === 'resume') resume.extensions = workerBinding;
    await expect(new MissionConductor({ runWorker }).conduct(input, [], resume)).rejects.toThrow(/OG_CONTRACT_UNSUPPORTED/);
    await expect(new FleetMissionConductor({ runWorker, ledgerStore: { save } }).conduct(input, [], resume)).rejects.toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(runWorker).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('blocks admission before persisting or allocating capacity', () => {
    const store = new InMemoryAdmissionStore();
    const scheduler = new SharedHostScheduler(store, { maxConcurrent: 1, leaseTtlMs: 1000, agingIntervalMs: 1000 });
    expect(() => scheduler.submit({
      requestId: 'blocked', orchestratorId: 'synthetic', environment: 'test', provider: 'codex', runtimeKind: 'container',
      priority: 1, submittedAt: new Date().toISOString(), queueTimeoutMs: 1000, metadata: workerBinding,
    })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(store.read().records).toEqual({});
  });

  it.each([projectUhpResponseToMission, projectUhpResponseToCanonicalMission])('blocks UHP response and request extensions before projection', project => {
    const response: any = { id: 'response', object: 'response', created_at: 0, status: 'completed', output: [] };
    expect(() => project('fake', { ...response, metadata: workerBinding })).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => project('fake', response, { input: '', extensions: workerBinding } as any)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it('blocks graph metadata before cloning or projection', () => {
    const metadata = { ...graphIdentity, extensions: workerBinding };
    expect(() => graphMetadataRecord(metadata)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => projectGraphMetadata(metadata, 'internal')).toThrow(/OG_CONTRACT_UNSUPPORTED/);
    expect(() => extractGraphMetadata({ ...workerBinding, 'aiwg.flow.graph': graphIdentity } as any)).toThrow(/OG_CONTRACT_UNSUPPORTED/);
  });

  it.each(['linear-flow', 'phased-multi-track'])('blocks typed worker values before %s invokeNode or parallelDispatch', async name => {
    const manifest = flow(name);
    manifest.spec.nodes[0].inputs[0].schema = { $ref: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerBrief' };
    const invokeNode = vi.fn();
    const parallelDispatch = vi.fn();
    await expect(executeFlowGraph(manifest, { invokeNode, parallelDispatch })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(invokeNode).not.toHaveBeenCalled();
    expect(parallelDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { $id: 'https://aiwg.io/schemas/mission.aiwg.io/v1', $ref: '#/$defs/workerBrief' },
    { $id: 'https://aiwg.io/schemas/mission.aiwg.io/v1', properties: { child: { $ref: '#/$defs/workerClaims' } } },
    { allOf: [{ $ref: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerResult' }] },
  ])('resolves Flow schema ownership before invoking an adapter %j', async schema => {
    const manifest = flow();
    manifest.spec.nodes[0].inputs[0].schema = schema;
    const invokeNode = vi.fn();
    await expect(executeFlowGraph(manifest, { invokeNode })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it.each(workerDefinitions)('blocks the actual schema-owned %s definition at Flow and MCP handoffs', async definition => {
    const schema = { $ref: `${missionSchema.$id}#/$defs/${definition}` };
    const manifest = flow();
    manifest.spec.nodes[0].inputs[0].schema = schema;
    const invokeNode = vi.fn();
    await expect(executeFlowGraph(manifest, { invokeNode })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(invokeNode).not.toHaveBeenCalled();
    const fetch = vi.fn();
    await expect(new AgenticSandboxMcpClient({ env: {}, fetch }).request('/synthetic', { body: { schema } })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks worker extensions in Flow values and resume records before invokeNode', async () => {
    const manifest = flow();
    manifest.spec.nodes[0].inputs[0].schema = { type: 'object' };
    manifest.spec.nodes[0].inputs[0].value = { extensions: workerBinding };
    const invokeNode = vi.fn();
    await expect(executeFlowGraph(manifest, { invokeNode })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    await expect(executeFlowGraph(flow(), { invokeNode, resumeFrom: { results: { extensions: workerBinding } } })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it('blocks worker outputs before Flow result cloning and accounting', async () => {
    // The node result record is the contract carrier; an output merely named
    // `extensions` is user data (see composition-runtime.test.ts).
    const report = await executeFlowGraph(flow(), { invokeNode: async () => ({ outputs: {}, extensions: workerBinding }) });
    expect(report.status).toBe('failed');
    expect(report.trace).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'node-attempt-failed', code: 'OG_CONTRACT_UNSUPPORTED' })]));
    expect(report.realizedResources.nodeRuns).toBe(0);
  });

  it('blocks MCP request extensions before reading credentials or making HTTP calls', async () => {
    const fetch = vi.fn();
    const client = new AgenticSandboxMcpClient({ env: {}, fetch });
    await expect(client.request('/synthetic', { method: 'POST', body: { extensions: workerBinding } })).rejects.toMatchObject({ code: 'OG_CONTRACT_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

});
