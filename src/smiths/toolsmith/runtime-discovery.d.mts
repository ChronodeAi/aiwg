export class RuntimeDiscovery {
  basePath: string;
  constructor(basePath?: string | null);
  discover(options?: { force?: boolean }): Promise<any>;
  verify(): Promise<any>;
  getCatalog(): Promise<any>;
  generateDefinition(): Promise<any>;
  checkTool(toolName: string): Promise<any>;
  getSummary(): Promise<any>;
}
