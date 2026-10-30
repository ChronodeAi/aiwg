import { describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../../../src/mcp/helpers.mjs', () => ({
  AIWG_ROOT: '/fixture', runAiwgCli: run,
  mcpError: (message: string) => ({ error: message }),
  mcpJson: (value: string) => ({ value }),
}));
import { registerDiscoveryTools } from '../../../src/mcp/tools/discovery.mjs';

describe('rule inventory MCP', () => {
  it('forwards scope, filters and body request to the read-only JSON CLI', async () => {
    const tools = new Map<string, any>();
    registerDiscoveryTools({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, { corpusStore: {} });
    run.mockResolvedValue({ stdout: '{"rules":[]}', stderr: '', code: 0 });
    const tool = tools.get('rule-inventory');
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    expect(await tool.handler({ scope: 'user', capability: 'demo', tier: 'high', bodies: true })).toEqual({ value: '{"rules":[]}' });
    expect(run).toHaveBeenCalledWith(['rules', 'inventory', '--scope', 'user', '--json', '--capability', 'demo', '--tier', 'high', '--bodies']);
  });
});
