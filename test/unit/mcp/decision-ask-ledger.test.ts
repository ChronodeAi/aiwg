/**
 * MCP `decision-ask` tool ledger parity (#2946; review r1 findings 1, 3).
 *
 * The CLI `ask` handler and this MCP tool must both call the same offload
 * checkpoint, which records a pre-call opportunity and completed ledger
 * result tagged with their transport. Attribution resolution happens INSIDE
 * that checkpoint (never at the MCP
 * call site) so a provider-detection failure cannot replace `result` with a
 * tool error. The decision driver module is mocked so this test never
 * touches the real filesystem, the real `process.cwd()`, or an actual Jev
 * call.
 *
 * @source @src/mcp/tools/decision.mjs
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkpointMock, result, attributionPattern } = vi.hoisted(() => {
  const result = {
    schema: 'aiwg-decision-ask/v1',
    status: 'fallback',
    answer: null,
    confidence: null,
    fallback: 'llm',
    reason: 'not-configured',
    model: null,
    usage: null,
    latencyMs: 0,
  };
  return {
    result,
    checkpointMock: vi.fn(async () => ({ outcome: 'fallback', result, opportunity: {}, attemptRecorded: true, opportunityRecorded: true })),
    attributionPattern: /^[A-Za-z0-9_.-]{1,64}$/,
  };
});

vi.mock('../../../src/decision/driver.js', () => ({
  runDecisionOffloadCheckpoint: checkpointMock,
  ATTRIBUTION_FIELD_PATTERN: attributionPattern,
}));

// @ts-expect-error — .mjs untyped
import { registerDecisionToolset } from '../../../src/mcp/tools/decision.mjs';

function captureTools() {
  const tools = new Map<string, { config: unknown; handler: (args: unknown) => Promise<unknown> }>();
  const server = { registerTool: (name: string, config: unknown, handler: (args: unknown) => Promise<unknown>) => tools.set(name, { config, handler }) };
  registerDecisionToolset(server as never);
  return tools;
}

beforeEach(() => {
  checkpointMock.mockClear();
});

describe('decision-ask MCP tool ledger parity (#2946)', () => {
  it('runs the shared checkpoint tagged transport "mcp", and returns its result unchanged', async () => {
    const tools = captureTools();
    const response = await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true, caller: 'worker-pick' }) as {
      structuredContent: { result: Record<string, unknown> };
    };

    expect(checkpointMock).toHaveBeenCalledTimes(1);
    const [input, options] = checkpointMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ question: 'Proceed?', mode: { kind: 'yes-no' } });
    expect(options).toMatchObject({ transport: 'mcp', caller: 'worker-pick', ledgerCaller: 'worker-pick' });

    // The ledger write never changes what the tool returns to the caller.
    expect(response.structuredContent.result).toEqual(result);
  });

  it('passes sampling overrides and project context to the shared ask runtime', async () => {
    await captureTools().get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true, passes: 10, escalation_passes: 20 });
    expect(checkpointMock).toHaveBeenCalledWith(expect.objectContaining({ passes: 10, escalationPasses: 20 }),
      expect.objectContaining({ projectRoot: process.cwd(), askRuntime: expect.objectContaining({ cwd: process.cwd() }) }));
  });

  it('tags caller null when the optional caller input is omitted', async () => {
    const tools = captureTools();
    await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true });
    const [, options] = checkpointMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).toMatchObject({ caller: 'decision-mcp:ask', ledgerCaller: null, category: 'unattributed' });
  });

  it('drops an invalid caller tag instead of failing the call (review finding 1)', async () => {
    const tools = captureTools();
    const response = await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true, caller: 'sk-ABCDEF:not-allowed chars' }) as {
      structuredContent: { result: Record<string, unknown> };
    };
    const [, options] = checkpointMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).toMatchObject({ caller: 'decision-mcp:ask', ledgerCaller: null, category: 'unattributed' });
    expect(response.structuredContent.result).toMatchObject({ status: 'fallback' });
  });
});
