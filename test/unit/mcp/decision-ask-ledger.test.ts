/**
 * MCP `decision-ask` tool ledger parity (#2946; review r1 findings 1, 3).
 *
 * The CLI `ask` handler and this MCP tool must both record through the same
 * `recordDecisionAsk` function, tagged with their own transport, and
 * attribution resolution now happens INSIDE that call (never at the MCP
 * call site) so a provider-detection failure cannot replace `result` with a
 * tool error. The decision driver module is mocked so this test never
 * touches the real filesystem, the real `process.cwd()`, or an actual Jev
 * call.
 *
 * @source @src/mcp/tools/decision.mjs
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { askDecisionMock, recordDecisionAskMock, attributionPattern } = vi.hoisted(() => ({
  askDecisionMock: vi.fn(async () => ({
    schema: 'aiwg-decision-ask/v1',
    status: 'fallback',
    answer: null,
    confidence: null,
    fallback: 'llm',
    reason: 'not-configured',
    model: null,
    usage: null,
    latencyMs: 0,
  })),
  recordDecisionAskMock: vi.fn(async () => null),
  attributionPattern: /^[A-Za-z0-9_.-]{1,64}$/,
}));

vi.mock('../../../src/decision/driver.js', () => ({
  askDecision: askDecisionMock,
  recordDecisionAsk: recordDecisionAskMock,
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
  askDecisionMock.mockClear();
  recordDecisionAskMock.mockClear();
});

describe('decision-ask MCP tool ledger parity (#2946)', () => {
  it('records through recordDecisionAsk tagged transport "mcp", and returns askDecision result unchanged', async () => {
    const tools = captureTools();
    const response = await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true, caller: 'worker-pick' }) as {
      structuredContent: { result: Record<string, unknown> };
    };

    expect(askDecisionMock).toHaveBeenCalledTimes(1);
    expect(recordDecisionAskMock).toHaveBeenCalledTimes(1);

    const [input, result, options] = recordDecisionAskMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ question: 'Proceed?', mode: { kind: 'yes-no' } });
    expect(result).toMatchObject({ status: 'fallback', reason: 'not-configured' });
    // The MCP call site no longer resolves provider/session itself (review finding 3):
    // it hands raw cwd/env + the already-validated caller to recordDecisionAsk.
    expect(options).toMatchObject({ transport: 'mcp', caller: 'worker-pick' });
    expect(options.provider).toBeUndefined();
    expect(options.sessionId).toBeUndefined();

    // The ledger write never changes what the tool returns to the caller.
    expect(response.structuredContent.result).toMatchObject({ status: 'fallback', reason: 'not-configured' });
  });

  it('tags caller null when the optional caller input is omitted', async () => {
    const tools = captureTools();
    await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true });
    const [, , options] = recordDecisionAskMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(options.caller).toBeNull();
  });

  it('drops an invalid caller tag instead of failing the call (review finding 1)', async () => {
    const tools = captureTools();
    const response = await tools.get('decision-ask')!.handler({ question: 'Proceed?', yes_no: true, caller: 'sk-ABCDEF:not-allowed chars' }) as {
      structuredContent: { result: Record<string, unknown> };
    };
    const [, , options] = recordDecisionAskMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(options.caller).toBeNull();
    expect(response.structuredContent.result).toMatchObject({ status: 'fallback' });
  });
});
