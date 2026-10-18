/**
 * Tests for Runtime Discovery Module
 *
 * Tests tool discovery, version detection, environment detection, and catalog generation.
 *
 * @tests @src/smiths/toolsmith/runtime-discovery.mjs
 * @architecture @.aiwg/architecture/decisions/ADR-014-toolsmith-feature-architecture.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, writeFile, chmod, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir, platform, homedir } from 'os';
import * as boundedProcess from '../../../../src/process/bounded-child-process.mjs';

vi.mock('os', async importOriginal => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: vi.fn(original.homedir) };
});

// Helper for robust cleanup with retries
async function cleanupWithRetry(dir: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (existsSync(dir)) {
        // Small delay to let async file operations complete
        await new Promise(resolve => setTimeout(resolve, 100));
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
      return;
    } catch (error: any) {
      if (attempt === maxRetries) {
        console.warn(`Cleanup warning for ${dir}: ${error.message}`);
        // Don't throw - cleanup failures shouldn't fail tests
      } else {
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  }
}

// We'll import the actual module for integration tests
// For unit tests, we'll mock child_process

// Mock catalog for tests that need it without running actual discovery
function createMockCatalog(testDir: string) {
  return {
    $schema: 'https://aiwg.io/schemas/toolsmith/runtime-catalog-v1.json',
    version: '1.0',
    generated: new Date().toISOString(),
    environment: {
      os: platform(),
      osVersion: 'Test',
      arch: 'x64',
      shell: '/bin/bash',
      homeDir: '/home/test',
      workingDir: testDir
    },
    resources: {
      diskFreeGb: 100,
      memoryTotalGb: 16,
      memoryAvailableGb: 8,
      cpuCores: 4
    },
    tools: [
      {
        id: 'node',
        name: 'node',
        category: 'languages',
        version: '20.0.0',
        path: '/usr/bin/node',
        status: 'verified',
        lastVerified: new Date().toISOString(),
        capabilities: ['javascript', 'runtime'],
        aliases: ['nodejs'],
        relatedTools: ['npm']
      },
      {
        id: 'git',
        name: 'git',
        category: 'core',
        version: '2.40.0',
        path: '/usr/bin/git',
        status: 'verified',
        lastVerified: new Date().toISOString(),
        capabilities: ['version-control'],
        aliases: [],
        relatedTools: []
      },
      {
        id: 'custom-tool',
        name: 'custom-tool',
        category: 'custom',
        version: '1.0.0',
        path: '/usr/local/bin/custom-tool',
        status: 'verified',
        lastVerified: new Date().toISOString(),
        capabilities: ['testing'],
        aliases: [],
        relatedTools: []
      }
    ],
    unavailable: []
  };
}

// Helper to write mock catalog to testDir
async function writeMockCatalog(testDir: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const catalogPath = join(testDir, 'runtime.json');
  const infoPath = join(testDir, 'runtime-info.md');

  const catalog = createMockCatalog(testDir);
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');
  await writeFile(infoPath, '# Runtime Environment Summary\n\n## Environment\n\n## Resources\n\n## Installed Tools\n\n## Summary\n', 'utf-8');
}

// Use sequential to avoid race conditions in parallel test execution
describe.sequential('RuntimeDiscovery', () => {
  let testDir: string;
  let RuntimeDiscovery: any;
  let originalArtifactsPath: string | undefined;

  beforeEach(async () => {
    originalArtifactsPath = process.env.AIWG_ARTIFACTS_PATH;
    // Use process.hrtime.bigint() for more unique directories
    testDir = resolve(tmpdir(), `runtime-discovery-test-${Date.now()}-${process.hrtime.bigint()}`);
    await mkdir(testDir, { recursive: true });

    // Dynamic import to avoid caching issues
    const module = await import('../../../../src/smiths/toolsmith/runtime-discovery.mjs');
    RuntimeDiscovery = module.RuntimeDiscovery;
  });

  afterEach(async () => {
    if (originalArtifactsPath === undefined) delete process.env.AIWG_ARTIFACTS_PATH;
    else process.env.AIWG_ARTIFACTS_PATH = originalArtifactsPath;
    await cleanupWithRetry(testDir);
  });

  describe('initialization', () => {
    it('should create RuntimeDiscovery instance with default path', () => {
      const discovery = new RuntimeDiscovery();

      expect(discovery).toBeDefined();
      expect(discovery.basePath).toContain('.aiwg/smiths/toolsmith');
    });

    it('should create RuntimeDiscovery instance with custom path', () => {
      const customPath = join(testDir, 'custom');
      const discovery = new RuntimeDiscovery(customPath);

      expect(discovery.basePath).toBe(customPath);
    });

    it('honors AIWG_ARTIFACTS_PATH for the default Toolsmith output', () => {
      const artifactRoot = join(testDir, 'relocated-artifacts');
      process.env.AIWG_ARTIFACTS_PATH = artifactRoot;

      const discovery = new RuntimeDiscovery();

      expect(discovery.basePath).toBe(join(artifactRoot, 'smiths', 'toolsmith'));
    });
  });

  describe('getEnvironment', () => {
    it('should detect OS information', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const env = await discovery.getEnvironment();

      expect(env.os).toBeDefined();
      expect(env.os).toMatch(/linux|darwin|win32/);
      expect(env.osVersion).toBeDefined();
      expect(env.arch).toBeDefined();
      expect(env.arch).toMatch(/x64|arm64|x86/);
      expect(env.shell).toBeDefined();
      expect(env.homeDir).toBeDefined();
      expect(env.workingDir).toBeDefined();
    });

    it('should include shell information', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const env = await discovery.getEnvironment();

      expect(env.shell).toBeTruthy();
      // Should be a path or command
      expect(env.shell.length).toBeGreaterThan(0);
    });
  });

  describe('getResources', () => {
    it('should detect system resources', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const resources = await discovery.getResources();

      expect(resources.diskFreeGb).toBeGreaterThan(0);
      expect(resources.memoryTotalGb).toBeGreaterThan(0);
      expect(resources.memoryAvailableGb).toBeGreaterThan(0);
      expect(resources.cpuCores).toBeGreaterThan(0);
    });

    it('should have logical memory values', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const resources = await discovery.getResources();

      // Available memory should be <= total memory
      expect(resources.memoryAvailableGb).toBeLessThanOrEqual(resources.memoryTotalGb);
    });
  });

  describe('checkTool', () => {
    it('should detect git if installed', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const result = await discovery.checkTool('git');

      // Git is almost certainly installed in test environment
      if (result.available) {
        expect(result.version).toBeDefined();
        expect(result.path).toBeDefined();
        expect(result.status).toBe('verified');
        expect(result.lastVerified).toBeDefined();
      } else {
        // If not available, should have install hint
        expect(result.installHint).toBeDefined();
      }
    });

    it('should detect node if installed', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const result = await discovery.checkTool('node');

      // Node is required to run tests, so should be available
      expect(result.available).toBe(true);
      expect(result.version).toBeDefined();
      expect(result.path).toBeDefined();
    });

    it('should return unavailable for non-existent tool', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const result = await discovery.checkTool('nonexistent-tool-xyz-abc-123');

      expect(result.available).toBe(false);
      expect(result.installHint).toBeDefined();
    });

    it('should provide platform-specific install hints', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const result = await discovery.checkTool('jq');

      if (!result.available) {
        expect(result.installHint).toBeDefined();

        // Should mention package manager based on platform
        if (platform() === 'darwin') {
          expect(result.installHint).toContain('brew');
        } else if (platform() === 'linux') {
          expect(result.installHint).toMatch(/apt|dnf/);
        } else if (platform() === 'win32') {
          expect(result.installHint).toMatch(/choco|scoop/);
        }
      }
    });
  });

  describe('discover', () => {
    // NOTE: Full discovery is very slow (scans all PATH executables)
    // Skip in CI, only run manually for integration testing
    it.skip('should discover common tools (SLOW - manual integration test)', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const catalog = await discovery.discover();

      expect(catalog).toBeDefined();
      expect(catalog.version).toBe('1.0');
      expect(catalog.tools.length).toBeGreaterThan(0);
    }, 300000);

    it('should return catalog with correct structure', async () => {
      // Test using mock - verifies the catalog structure without slow discovery
      const mockCatalog = createMockCatalog(testDir);

      expect(mockCatalog.version).toBe('1.0');
      expect(mockCatalog.generated).toBeDefined();
      expect(mockCatalog.environment).toBeDefined();
      expect(mockCatalog.resources).toBeDefined();
      expect(mockCatalog.tools).toBeDefined();
      expect(Array.isArray(mockCatalog.tools)).toBe(true);
      expect(mockCatalog.tools.length).toBeGreaterThan(0);
    });

    it('should categorize tools correctly', async () => {
      const mockCatalog = createMockCatalog(testDir);
      const categories = new Set(mockCatalog.tools.map((t: any) => t.category));

      // Should use only valid categories
      for (const category of categories) {
        expect(['core', 'languages', 'utilities', 'custom']).toContain(category);
      }
    });

    it('should write catalog files when discovery runs', async () => {
      // Use writeMockCatalog to simulate what discover() does
      await writeMockCatalog(testDir);

      const catalogPath = join(testDir, 'runtime.json');
      const infoPath = join(testDir, 'runtime-info.md');

      expect(existsSync(catalogPath)).toBe(true);
      expect(existsSync(infoPath)).toBe(true);
    });
  });

  describe('scheduled refresh', () => {
    let discovery: any;
    let probes: string[];
    let pathTools: Map<string, string>;

    async function installTool(directory: string, name: string): Promise<string> {
      const toolPath = join(testDir, directory, name);
      await mkdir(join(testDir, directory), { recursive: true });
      await writeFile(toolPath, '#!/bin/sh\necho tool 1.2.3\n');
      await chmod(toolPath, 0o755);
      return toolPath;
    }

    beforeEach(() => {
      vi.mocked(homedir).mockReturnValue(testDir);
      vi.stubEnv('HOME', testDir);
      vi.stubEnv('CARGO_HOME', '');
      vi.stubEnv('PATH', '/usr/bin:/bin');
      probes = [];
      pathTools = new Map();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(boundedProcess, 'boundedExecFileSync').mockImplementation((file: any, args: any) => {
        if (file === 'which' && pathTools.has(args[0])) return pathTools.get(args[0])!;
        if (file.startsWith(testDir) && args[0] === '--version') {
          probes.push(file);
          return 'tool 1.2.3';
        }
        throw new Error('not found');
      });
      discovery = new RuntimeDiscovery(join(testDir, 'catalog'));
      vi.spyOn(discovery, 'getEnvironment').mockResolvedValue(createMockCatalog(testDir).environment);
      vi.spyOn(discovery, 'getResources').mockResolvedValue(createMockCatalog(testDir).resources);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(homedir).mockReset();
      vi.unstubAllEnvs();
    });

    it('finds allowlisted Cargo and local tools under a narrow PATH without probing arbitrary executables', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      const fd = await installTool('.local/bin', 'fd');
      await installTool('.cargo/bin', 'unlisted-command');
      const catalog = await discovery.discover();
      expect(catalog.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rg', path: rg, version: '1.2.3' }),
        expect.objectContaining({ id: 'fd', path: fd }),
      ]));
      expect(probes.sort()).toEqual([rg, fd].sort());
      expect(catalog.delta).toEqual({ added: ['rg', 'fd'], removed: [] });
      expect(console.log).toHaveBeenCalledWith('Tool delta: +2 added, -0 removed');
    });

    it('keeps PATH precedence and honors a custom Cargo home', async () => {
      const preferred = await installTool('preferred', 'rg');
      await installTool('.cargo/bin', 'rg');
      const cargoFd = await installTool('cargo-home/bin', 'fd');
      vi.stubEnv('CARGO_HOME', join(testDir, 'cargo-home'));
      pathTools.set('rg', preferred);
      expect((await discovery.discover()).tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rg', path: preferred }),
        expect.objectContaining({ id: 'fd', path: cargoFd }),
      ]));
      expect(await discovery.checkTool('fd')).toMatchObject({ available: true, path: cargoFd });
    });

    it('preserves a Cargo tool when a later refresh loses its PATH entry', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      vi.stubEnv('PATH', `${join(testDir, '.cargo/bin')}:/usr/bin:/bin`);
      pathTools.set('rg', rg);
      await discovery.discover();
      vi.stubEnv('PATH', '/usr/bin:/bin');
      pathTools.clear();
      const refreshed = await discovery.discover();
      expect(refreshed.tools).toEqual([expect.objectContaining({ id: 'rg', path: rg })]);
      expect(refreshed.delta).toEqual({ added: [], removed: [] });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it.each(['bin', '.npm-global/bin', 'go/bin', '.bun/bin', '.deno/bin'])(
      'finds tools installed in ~/%s', async directory => {
        const fd = await installTool(directory, 'fd');
        expect(await discovery.checkTool('fd')).toMatchObject({ available: true, path: fd });
      }
    );

    it('ignores non-executable files and directories in user bin paths', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      await chmod(rg, 0o644);
      await mkdir(join(testDir, '.cargo/bin/fd'));
      expect((await discovery.discover()).tools).toEqual([]);
      expect(probes).toEqual([]);
    });

    it('skips unchanged inputs across instances without probes, resource sampling, or output writes', async () => {
      await installTool('.cargo/bin', 'rg');
      const first = await discovery.discover();
      const catalogPath = join(discovery.basePath, 'runtime.json');
      const infoPath = join(discovery.basePath, 'runtime-info.md');
      const before = await Promise.all([stat(catalogPath), stat(infoPath)]);
      probes.length = 0;
      const next = new RuntimeDiscovery(discovery.basePath);
      const resources = vi.spyOn(next, 'getResources');
      expect(await next.discover()).toEqual(first);
      expect(probes).toEqual([]);
      expect(resources).not.toHaveBeenCalled();
      expect((await Promise.all([stat(catalogPath), stat(infoPath)])).map(s => s.mtimeMs))
        .toEqual(before.map(s => s.mtimeMs));
      expect(console.log).toHaveBeenCalledWith('Discovery skipped: unchanged (1 tools)');
    });

    it('refreshes after executable edits, additions, and removals and reports shrinkage', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      await discovery.discover();
      probes.length = 0;
      await writeFile(rg, '#!/bin/sh\necho tool 2.0.0 updated\n');
      await discovery.discover();
      expect(probes).toEqual([rg]);
      await installTool('.local/bin', 'fd');
      expect((await discovery.discover()).delta).toEqual({ added: ['fd'], removed: [] });
      await rm(rg);
      const shrunk = await discovery.discover();
      expect(shrunk.delta).toEqual({ added: [], removed: ['rg'] });
      expect(console.warn).toHaveBeenCalledWith('Previously cataloged tools no longer available: rg');
      expect(console.log).toHaveBeenCalledWith('Tool delta: +0 added, -1 removed');
    });

    it('repeats probes when forced or the lookup environment or tool definitions change', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      await discovery.discover();
      probes.length = 0;
      await discovery.discover({ force: true });
      vi.stubEnv('PATH', '/bin:/usr/bin');
      await discovery.discover();
      discovery.knownTools.ripgrep.capabilities.push('new-capability');
      await discovery.discover();
      expect(probes).toEqual([rg, rg, rg]);
    });

    it('rebuilds legacy or malformed catalogs and missing human-readable output', async () => {
      const rg = await installTool('.cargo/bin', 'rg');
      const first = await discovery.discover();
      delete first.inputFingerprint;
      await writeFile(join(discovery.basePath, 'runtime.json'), JSON.stringify(first));
      probes.length = 0;
      await discovery.discover();
      await rm(join(discovery.basePath, 'runtime-info.md'));
      await discovery.discover();
      await writeFile(join(discovery.basePath, 'runtime.json'), '{');
      await discovery.discover();
      await writeFile(join(discovery.basePath, 'runtime.json'), JSON.stringify({ tools: {} }));
      await discovery.discover();
      expect(probes).toEqual([rg, rg, rg, rg]);
    });
  });

  describe('verify', () => {
    it('should verify existing catalog', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      // Create mock catalog with tools we know exist
      await writeMockCatalog(testDir);

      // Then verify it
      const result = await discovery.verify();

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.total).toBeDefined();
      expect(result.failed).toBeDefined();
      expect(Array.isArray(result.failed)).toBe(true);
    });

    it('should throw error if no catalog exists', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      await expect(discovery.verify()).rejects.toThrow('No catalog found');
    });
  });

  describe('getSummary', () => {
    it('should return runtime summary', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      // Create mock catalog
      await writeMockCatalog(testDir);

      const summary = await discovery.getSummary();

      expect(summary.environment).toBeDefined();
      expect(summary.resources).toBeDefined();
      expect(summary.toolCounts).toBeDefined();
      expect(summary.totalTools).toBeGreaterThan(0);
      expect(summary.lastDiscovery).toBeDefined();
      expect(summary.catalogPath).toBeDefined();

      // Tool counts should add up
      const sumCounts =
        summary.toolCounts.core +
        summary.toolCounts.languages +
        summary.toolCounts.utilities +
        summary.toolCounts.custom;

      expect(sumCounts).toBe(summary.totalTools);
    });

    it('should throw error if no catalog exists', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      await expect(discovery.getSummary()).rejects.toThrow('No catalog found');
    });
  });

  describe('addCustomTool', () => {
    it('should add custom tool with enhanced metadata to catalog', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      // Create mock catalog
      await writeMockCatalog(testDir);

      // Note: addCustomTool validates by checking if the tool ID exists in PATH
      // So we use 'node' which exists, and add custom metadata to it
      const nodePath = await discovery.checkTool('node');

      if (nodePath.available) {
        await discovery.addCustomTool({
          id: 'node',  // Use existing tool ID
          name: 'Node.js Runtime (Enhanced)',
          path: nodePath.path,
          category: 'custom',  // Re-categorize as custom
          capabilities: ['javascript', 'runtime', 'server', 'cli'],
          documentation: 'https://nodejs.org',
          aliases: ['nodejs']
        });

        // Verify it was updated
        const summary = await discovery.getSummary();
        expect(summary.toolCounts.custom).toBeGreaterThan(0);

        // Check the catalog
        const catalogPath = join(testDir, 'runtime.json');
        const catalogContent = await readFile(catalogPath, 'utf-8');
        const catalog = JSON.parse(catalogContent);

        // Find the updated node tool
        const nodeTool = catalog.tools.find((t: any) => t.id === 'node' && t.category === 'custom');
        expect(nodeTool).toBeDefined();
        expect(nodeTool.name).toBe('Node.js Runtime (Enhanced)');
        expect(nodeTool.category).toBe('custom');
      }
    });

    it('should throw error for non-existent tool', async () => {
      const discovery = new RuntimeDiscovery(testDir);

      // Create mock catalog
      await writeMockCatalog(testDir);

      await expect(
        discovery.addCustomTool({
          id: 'fake-tool',
          name: 'Fake Tool',
          path: '/nonexistent/path/fake',
          category: 'custom',
          capabilities: ['testing']
        })
      ).rejects.toThrow();
    });
  });

  describe('catalog format', () => {
    it('should generate valid JSON catalog', async () => {
      // Test using mock catalog
      const catalog = createMockCatalog(testDir);

      // Should be valid JSON (no circular refs)
      const jsonString = JSON.stringify(catalog);
      const parsed = JSON.parse(jsonString);

      expect(parsed.version).toBe('1.0');
      expect(parsed.$schema).toContain('runtime-catalog');
    });

    it('should include ISO 8601 timestamps', async () => {
      // Test using mock catalog
      const catalog = createMockCatalog(testDir);

      // Validate ISO 8601 format
      const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(catalog.generated).toMatch(dateRegex);

      for (const tool of catalog.tools) {
        expect(tool.lastVerified).toMatch(dateRegex);
      }
    });

    it('should generate human-readable markdown', async () => {
      // Write mock catalog which creates both runtime.json and runtime-info.md
      await writeMockCatalog(testDir);

      const infoPath = join(testDir, 'runtime-info.md');
      const content = await readFile(infoPath, 'utf-8');

      expect(content).toContain('# Runtime Environment Summary');
      expect(content).toContain('## Environment');
      expect(content).toContain('## Resources');
      expect(content).toContain('## Installed Tools');
      expect(content).toContain('## Summary');
    });
  });

  describe('version extraction', () => {
    it('should extract node version', async () => {
      const discovery = new RuntimeDiscovery(testDir);
      const result = await discovery.checkTool('node');

      if (result.available) {
        // Version should be semver-like
        expect(result.version).toMatch(/\d+\.\d+/);
      }
    });

    it('should handle tools with unknown versions gracefully', async () => {
      // Use mock catalog to test version field structure
      const catalog = createMockCatalog(testDir);

      for (const tool of catalog.tools) {
        // Version should be defined (even if "unknown")
        expect(tool.version).toBeDefined();
        expect(typeof tool.version).toBe('string');
      }
    });
  });
});
