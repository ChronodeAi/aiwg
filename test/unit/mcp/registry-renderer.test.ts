import { describe, expect, it } from 'vitest';
import { buildServerConfig, type McpServerDefinition } from '../../../src/mcp/registry.js';
import { buildServerConfig as renderRuntime } from '../../../src/mcp/registry.mjs';

describe('OMP server renderer parity', () => {
  for (const provider of ['omp', 'oh-my-pi'] as const) {
    it.each(['stdio', 'http', 'sse'] as const)(`${provider} renders %s and credential references`, type => {
      const server: McpServerDefinition = type === 'stdio'
        ? { name: 'fixture', type, command: 'fixture-mcp', args: ['--json'],
            env: { MODE: 'fixture' }, envFrom: { API_KEY: 'FIXTURE_API_KEY' } }
        : { name: 'fixture', type, url: 'https://fixture.example/mcp',
            headers: { Accept: 'application/json' }, headerEnv: { Authorization: 'FIXTURE_TOKEN' } };
      const expected = type === 'stdio'
        ? { command: 'fixture-mcp', args: ['--json'], env: { MODE: 'fixture', API_KEY: '${FIXTURE_API_KEY}' } }
        : { url: 'https://fixture.example/mcp', headers: { Accept: 'application/json', Authorization: '${FIXTURE_TOKEN}' } };
      expect(renderRuntime(server, provider)).toEqual(expected);
      expect(buildServerConfig(server, provider)).toEqual(expected);
    });
  }
});
