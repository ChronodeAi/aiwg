import type { InjectProvider, McpServerDefinition } from './registry.js';

export function buildServerConfig(server: McpServerDefinition, provider: InjectProvider): Record<string, unknown>;
