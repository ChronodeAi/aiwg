/**
 * Tests for BehaviorRegistry
 *
 * @implements Issue #515
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BehaviorRegistry } from '../../../tools/ralph-external/lib/behavior-registry.mjs';

const VALID_BEHAVIOR = `
name: test-behavior
version: "1.0.0"
description: Test behavior for unit tests
agentTypes:
  - daemon
  - ralph-loop
directives:
  - id: test-directive-1
    rule: Always do the right thing
    defaults:
      param1: value1
  - id: test-directive-2
    rule: Never do the wrong thing
tools:
  - tool: test-tool-1
    description: A test tool
    schema:
      type: object
      properties: {}
  - tool: test-tool-2
    description: Another test tool
    schema:
      type: object
      properties: {}
`;

const OVERRIDE_BEHAVIOR = `
name: test-behavior
version: "1.1.0"
description: Project-level override
agentTypes:
  - daemon
directives:
  - id: test-directive-1
    rule: Override rule
tools:
  - tool: override-tool
    description: Override tool
`;

const INVALID_BEHAVIOR_MISSING_NAME = `
version: "1.0.0"
agentTypes:
  - daemon
directives:
  - id: d1
    rule: test
tools:
  - tool: t1
    description: test
`;

const INVALID_BEHAVIOR_BAD_DIRECTIVE = `
name: bad-directives
version: "1.0.0"
agentTypes:
  - daemon
directives:
  - rule: missing id
tools:
  - tool: t1
    description: test
`;

describe('BehaviorRegistry', () => {
  let testDir;
  let frameworkBehaviorsDir;
  let projectBehaviorsDir;
  let registry;

  beforeEach(() => {
    testDir = join(tmpdir(), `behavior-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    frameworkBehaviorsDir = join(testDir, 'agentic', 'code', 'behaviors');
    projectBehaviorsDir = join(testDir, '.aiwg', 'behaviors');

    mkdirSync(frameworkBehaviorsDir, { recursive: true });
    mkdirSync(projectBehaviorsDir, { recursive: true });

    registry = new BehaviorRegistry({
      projectRoot: testDir,
      frameworkRoot: testDir,
    });

    // Override user tier to a test path (avoid touching real user config)
    registry._tiers[2] = {
      name: 'user',
      path: join(testDir, 'user-behaviors'),
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('discover()', () => {
    it('should discover YAML files from framework tier', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'ops-toolset.yaml'), VALID_BEHAVIOR);
      const discovered = await registry.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].tier).toBe('framework');
      expect(discovered[0].file).toBe('ops-toolset.yaml');
    });

    it('should discover from multiple tiers', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'framework.yaml'), VALID_BEHAVIOR);
      writeFileSync(join(projectBehaviorsDir, 'project.yaml'), VALID_BEHAVIOR);
      const discovered = await registry.discover();
      expect(discovered).toHaveLength(2);
      expect(discovered.map(d => d.tier)).toEqual(['framework', 'project']);
    });

    it('should skip non-existent directories', async () => {
      const discovered = await registry.discover();
      // user tier dir doesn't exist, should not error
      expect(discovered).toHaveLength(0);
    });

    it('should discover .yml files too', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'test.yml'), VALID_BEHAVIOR);
      const discovered = await registry.discover();
      expect(discovered).toHaveLength(1);
    });
  });

  describe('validate()', () => {
    it('should validate a correct behavior', () => {
      const behavior = {
        name: 'test',
        version: '1.0.0',
        agentTypes: ['daemon'],
        directives: [{ id: 'd1', rule: 'test' }],
        tools: [{ tool: 't1', description: 'test' }],
      };
      const result = registry.validate(behavior);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject null input', () => {
      const result = registry.validate(null);
      expect(result.valid).toBe(false);
    });

    it('should report missing required fields', () => {
      const result = registry.validate({ version: '1.0.0' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
      expect(result.errors.some(e => e.includes('agentTypes'))).toBe(true);
      expect(result.errors.some(e => e.includes('directives'))).toBe(true);
      expect(result.errors.some(e => e.includes('tools'))).toBe(true);
    });

    it('should reject directives missing id', () => {
      const result = registry.validate({
        name: 'test',
        version: '1.0.0',
        agentTypes: ['daemon'],
        directives: [{ rule: 'missing id' }],
        tools: [{ tool: 't1', description: 'test' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("missing 'id'"))).toBe(true);
    });

    it('should reject tools missing description', () => {
      const result = registry.validate({
        name: 'test',
        version: '1.0.0',
        agentTypes: ['daemon'],
        directives: [{ id: 'd1', rule: 'test' }],
        tools: [{ tool: 't1' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("missing 'description'"))).toBe(true);
    });
  });

  describe('load()', () => {
    it('should load a behavior by name', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'ops-toolset.yaml'), VALID_BEHAVIOR);
      const behavior = await registry.load('ops-toolset');
      expect(behavior.name).toBe('test-behavior');
      expect(behavior._tier).toBe('framework');
    });

    it('should throw for unknown behavior', async () => {
      await expect(registry.load('nonexistent')).rejects.toThrow(/not found/);
    });

    it('should throw for invalid behavior', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'bad.yaml'), INVALID_BEHAVIOR_MISSING_NAME);
      await expect(registry.load('bad')).rejects.toThrow(/Invalid behavior/);
    });

    it('should prefer higher tier (project over framework)', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'test-behavior.yaml'), VALID_BEHAVIOR);
      writeFileSync(join(projectBehaviorsDir, 'test-behavior.yaml'), OVERRIDE_BEHAVIOR);
      const behavior = await registry.load('test-behavior');
      expect(behavior._tier).toBe('project');
      expect(behavior.version).toBe('1.1.0');
    });
  });

  describe('loadAll()', () => {
    it('should load all discovered behaviors', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'ops-toolset.yaml'), VALID_BEHAVIOR);
      const behaviors = await registry.loadAll();
      expect(behaviors.size).toBe(1);
    });

    it('should skip invalid behaviors with warning', async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'good.yaml'), VALID_BEHAVIOR);
      writeFileSync(join(frameworkBehaviorsDir, 'bad.yaml'), INVALID_BEHAVIOR_MISSING_NAME);
      const behaviors = await registry.loadAll();
      expect(behaviors.size).toBe(1); // only the valid one
    });
  });

  describe('getDirectives()', () => {
    beforeEach(async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'ops.yaml'), VALID_BEHAVIOR);
      await registry.loadAll();
    });

    it('should return directives for matching agent type', () => {
      const directives = registry.getDirectives('daemon');
      expect(directives).toHaveLength(2);
      expect(directives.map(d => d.id)).toEqual(['test-directive-1', 'test-directive-2']);
    });

    it('should return empty for non-matching agent type', () => {
      const directives = registry.getDirectives('web-agent');
      expect(directives).toHaveLength(0);
    });
  });

  describe('getToolset()', () => {
    beforeEach(async () => {
      writeFileSync(join(frameworkBehaviorsDir, 'ops.yaml'), VALID_BEHAVIOR);
      await registry.loadAll();
    });

    it('should return tools for matching agent type', () => {
      const tools = registry.getToolset('ralph-loop');
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.tool)).toEqual(['test-tool-1', 'test-tool-2']);
    });

    it('should return empty for non-matching agent type', () => {
      const tools = registry.getToolset('unknown');
      expect(tools).toHaveLength(0);
    });
  });

  describe('merge()', () => {
    it('should merge directives and tools from multiple behaviors', () => {
      const b1 = {
        name: 'b1',
        directives: [{ id: 'd1', rule: 'r1' }],
        tools: [{ tool: 't1', description: 'desc1' }],
      };
      const b2 = {
        name: 'b2',
        directives: [{ id: 'd2', rule: 'r2' }],
        tools: [{ tool: 't2', description: 'desc2' }],
      };

      const result = registry.merge([b1, b2]);
      expect(result.directives).toHaveLength(2);
      expect(result.toolset).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);
    });

    it.each([
      [10, 5],
      [10, undefined],
      [undefined, -1],
    ])('should select higher priority (%s over %s) independent of attachment order', (high, low) => {
      const winner = {
        name: 'safety',
        directives: [{ id: 'budget-gate', priority: high, rule: 'Keep the budget gate' }],
      };
      const loser = {
        name: 'reporting',
        directives: [{ id: 'budget-gate', priority: low, rule: 'Replace the budget gate' }],
      };

      for (const behaviors of [[winner, loser], [loser, winner]]) {
        const result = registry.merge(behaviors);
        expect(result.directives).toEqual([
          { ...winner.directives[0], _behaviorName: 'safety' },
        ]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("Directive 'budget-gate'");
        expect(result.warnings[0]).toContain(`'safety' (priority ${high ?? 0}) wins over 'reporting' (priority ${low ?? 0})`);
      }
    });

    it.each([
      [undefined, undefined],
      [undefined, 0],
      [5, 5],
    ])('should use later attachment for equal priorities (%s and %s)', (first, second) => {
      const b1 = {
        name: 'b1',
        directives: [{ id: 'shared', priority: first, rule: 'from b1' }],
      };
      const b2 = {
        name: 'b2',
        directives: [{ id: 'shared', priority: second, rule: 'from b2' }],
      };

      for (const behaviors of [[b1, b2], [b2, b1]]) {
        const later = behaviors[1];
        const result = registry.merge(behaviors);
        expect(result.directives).toEqual([
          { ...later.directives[0], _behaviorName: later.name },
        ]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain(`'${later.name}' (priority ${second ?? 0}) wins over '${behaviors[0].name}'`);
        expect(result.warnings[0]).toContain('later in attachment order');
      }
    });

    it('should report each losing directive when a higher-priority winner is retained', () => {
      const behaviors = [10, 5, 0].map(priority => ({
        name: `priority-${priority}`,
        directives: [{ id: 'shared', priority, rule: `from priority ${priority}` }],
      }));

      const result = registry.merge(behaviors);
      expect(result.directives).toEqual([
        { ...behaviors[0].directives[0], _behaviorName: 'priority-10' },
      ]);
      expect(result.warnings).toHaveLength(2);
      for (const [index, priority] of [5, 0].entries()) {
        expect(result.warnings[index]).toContain("Directive 'shared'");
        expect(result.warnings[index]).toContain(`'priority-10' (priority 10) wins over 'priority-${priority}' (priority ${priority})`);
      }
    });

    it('should warn on directive override (same id)', () => {
      const b1 = {
        name: 'b1',
        directives: [{ id: 'shared', rule: 'original' }],
        tools: [],
      };
      const b2 = {
        name: 'b2',
        directives: [{ id: 'shared', rule: 'override' }],
        tools: [],
      };

      const result = registry.merge([b1, b2]);
      expect(result.directives).toHaveLength(1);
      expect(result.directives[0].rule).toBe('override');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("'shared'");
    });

    it('should throw on tool name collision', () => {
      const b1 = {
        name: 'b1',
        directives: [],
        tools: [{ tool: 'shared-tool', description: 'from b1' }],
      };
      const b2 = {
        name: 'b2',
        directives: [],
        tools: [{ tool: 'shared-tool', description: 'from b2' }],
      };

      expect(() => registry.merge([b1, b2])).toThrow(/Tool name collision.*shared-tool/);
    });
  });

  describe('real ops-toolset.yaml integration', () => {
    it('should load the real ops-toolset.yaml from framework tier', async () => {
      const realRegistry = new BehaviorRegistry({
        projectRoot: join(import.meta.dirname, '../../..'),
        frameworkRoot: join(import.meta.dirname, '../../..'),
      });
      // Override user tier to avoid reading real user config
      realRegistry._tiers[2] = { name: 'user', path: '/nonexistent' };

      const behavior = await realRegistry.load('ops-toolset');
      expect(behavior.name).toBe('ops-toolset');
      expect(behavior.agentTypes).toContain('daemon');
      expect(behavior.directives).toHaveLength(5);
      expect(behavior.tools).toHaveLength(7);

      const validation = realRegistry.validate(behavior);
      expect(validation.valid).toBe(true);
    });

    it('should resolve directives for daemon agent type', async () => {
      const realRegistry = new BehaviorRegistry({
        projectRoot: join(import.meta.dirname, '../../..'),
        frameworkRoot: join(import.meta.dirname, '../../..'),
      });
      realRegistry._tiers[2] = { name: 'user', path: '/nonexistent' };

      await realRegistry.loadAll();
      const directives = realRegistry.getDirectives('daemon');
      expect(directives.length).toBeGreaterThanOrEqual(5);
      expect(directives.map(d => d.id)).toContain('process-group-kill');
      expect(directives.map(d => d.id)).toContain('budget-gate');
    });

    it('should resolve toolset for daemon agent type', async () => {
      const realRegistry = new BehaviorRegistry({
        projectRoot: join(import.meta.dirname, '../../..'),
        frameworkRoot: join(import.meta.dirname, '../../..'),
      });
      realRegistry._tiers[2] = { name: 'user', path: '/nonexistent' };

      await realRegistry.loadAll();
      const tools = realRegistry.getToolset('daemon');
      expect(tools.length).toBeGreaterThanOrEqual(7);
      expect(tools.map(t => t.tool)).toContain('process-list');
      expect(tools.map(t => t.tool)).toContain('budget-remaining');
    });
  });
});
