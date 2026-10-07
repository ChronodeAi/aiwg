import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fixtureJson, materialize, validators, type ContractVector } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const { cli } = vi.hoisted(() => ({ cli: vi.fn() }));
vi.mock('../../../src/mcp/helpers.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/helpers.mjs')>(), runAiwgCli: cli,
}));
// @ts-expect-error — .mjs untyped, matching the orchestration test lane
import { registerMissionToolset } from '../../../src/mcp/tools/orchestration.mjs';

const vocabulary = fixtureJson('public-vocabulary.json');
const vectors: ContractVector[] = fixtureJson('mission-vectors.json');
const { draft2020 } = validators();
const resolveDescriptor = vocabulary.mcp.find((tool: any) => tool.name === 'worker-resolve');
const invokeDescriptor = vocabulary.mcp.find((tool: any) => tool.name === 'worker-invoke');
const validateResolve = draft2020.compile(resolveDescriptor.inputSchema);
const validateInvoke = draft2020.compile(invokeDescriptor.inputSchema);
const value = (id: string) => materialize(vectors.find(v => v.id === id)!, vectors);

describe('frozen worker MCP descriptors (T-OG-17; B-OG-35 runtime handoff)', () => {
  it.each(vocabulary.cli.cases)('$id resolves a typed request without a Mission session', fixture => {
    expect(validateResolve(fixture.request), JSON.stringify(validateResolve.errors)).toBe(true);
    expect(resolveDescriptor.annotations.readOnlyHint).toBe(true);
    expect(cli).not.toHaveBeenCalled();
  });

  it.each([
    { transport: 'msp' }, { transport: 'acp' }, { transport: 'http' },
    { format: 'powershell' }, { group: 'fixture; touch injected' },
    { session_id: 'forbidden-managed-prerequisite' }, { server_url: 'https://arbitrary.invalid' },
  ])('rejects unsupported resolve syntax or task-supplied authority %j', patch => {
    expect(validateResolve({ ...vocabulary.cli.cases[0].request, ...patch })).toBe(false);
    expect(cli).not.toHaveBeenCalled();
  });

  it.each(['resolved-shell', 'resolved-mcp'])('%s invokes the typed direct brief without session, lease or verification', id => {
    expect(validateInvoke({ invocation: value(id), brief: value('direct-brief-no-lease') }), JSON.stringify(validateInvoke.errors)).toBe(true);
    expect(invokeDescriptor.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(invokeDescriptor.workerOutputDefinition).toBe('workerClaims');
    expect(invokeDescriptor.observedOutputDefinition).toBe('workerExecution');
  });

  it.each([
    { command: 'echo forbidden' }, { session_id: 'forbidden-session' },
    { verification: { status: 'accepted' } }, { server_url: 'https://arbitrary.invalid' },
  ])('rejects raw command or fabricated managed/conductor authority %j', patch => {
    expect(validateInvoke({ invocation: value('resolved-shell'), brief: value('direct-brief-no-lease'), ...patch })).toBe(false);
  });

  it('rejects a preparatory descriptor and preserves pinned MCP transport fields', () => {
    const invocation = value('preparatory-without-brief-digest');
    expect(validateInvoke({ invocation, brief: value('direct-brief-no-lease') })).toBe(false);
    for (const field of ['inputSchemaDigest', 'outputSchemaDigest', 'sessionIsolation']) {
      const mcp = value('resolved-mcp');
      delete mcp.mcp[field];
      expect(validateInvoke({ invocation: mcp, brief: value('direct-brief-no-lease') })).toBe(false);
    }
  });

  it('keeps the existing mission-dispatch descriptor separate and unchanged', () => {
    const tools = new Map<string, any>();
    registerMissionToolset({ registerTool(name: string, descriptor: any) { tools.set(name, descriptor); } });
    const actual = tools.get('mission-dispatch');
    const frozen = vocabulary.mcp.find((tool: any) => tool.name === 'mission-dispatch');
    expect(Object.keys(actual.inputSchema)).toEqual(frozen.properties);
    expect(Object.entries(actual.inputSchema).filter(([, schema]) => !(schema as z.ZodType).safeParse(undefined).success).map(([key]) => key)).toEqual(frozen.required);
    expect(actual.annotations).toEqual(frozen.annotations);
    // Do not advertise unfinished worker handlers through the Mission toolset.
    expect(tools.has('worker-resolve')).toBe(false);
    expect(tools.has('worker-invoke')).toBe(false);
    expect(cli).not.toHaveBeenCalled();
  });
});
