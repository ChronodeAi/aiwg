/**
 * BehaviorRegistry - Discovers, loads, validates, and merges behavior YAML files
 *
 * Three-tier discovery (later tiers override earlier):
 *   1. agentic/code/behaviors/     — framework-shipped (read-only)
 *   2. .aiwg/behaviors/            — project-local overrides
 *   3. ~/.config/aiwg/behaviors/   — user-level overrides
 *
 * @implements #515
 * @tests @test/unit/ralph-external/behavior-registry.test.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

const REQUIRED_FIELDS = ['name', 'version', 'agentTypes', 'directives', 'tools'];

export class BehaviorRegistry {
  /**
   * @param {object} options
   * @param {string} options.projectRoot - Project root directory
   * @param {string} [options.frameworkRoot] - AIWG framework root (defaults to projectRoot)
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.frameworkRoot = options.frameworkRoot || this.projectRoot;

    this._behaviors = new Map(); // name -> Behavior
    this._loaded = false;

    // Discovery tier paths (priority order, later wins)
    this._tiers = [
      { name: 'framework', path: join(this.frameworkRoot, 'agentic', 'code', 'behaviors') },
      { name: 'project', path: join(this.projectRoot, '.aiwg', 'behaviors') },
      { name: 'user', path: join(homedir(), '.config', 'aiwg', 'behaviors') },
    ];
  }

  /**
   * Discover all behavior YAML files across all tiers.
   * Returns array of file paths found.
   */
  async discover() {
    const discovered = [];

    for (const tier of this._tiers) {
      try {
        const entries = await readdir(tier.path);
        const yamlFiles = entries.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const file of yamlFiles) {
          discovered.push({ tier: tier.name, path: join(tier.path, file), file });
        }
      } catch (err) {
        // Directory doesn't exist — skip silently
        if (err.code !== 'ENOENT') throw err;
      }
    }

    return discovered;
  }

  /**
   * Load a single behavior by name.
   * Searches all tiers; last-found (highest tier) wins.
   */
  async load(name) {
    const discovered = await this.discover();
    const matching = discovered.filter(d => {
      const baseName = d.file.replace(/\.(yaml|yml)$/, '');
      return baseName === name;
    });

    if (matching.length === 0) {
      throw new Error(`Behavior '${name}' not found in any discovery tier`);
    }

    // Last match wins (highest tier)
    const entry = matching[matching.length - 1];
    const raw = await readFile(entry.path, 'utf-8');
    const parsed = YAML.parse(raw);

    const validation = this.validate(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid behavior '${name}': ${validation.errors.join(', ')}`);
    }

    parsed._tier = entry.tier;
    parsed._path = entry.path;
    return parsed;
  }

  /**
   * Load all discovered behaviors. Later tiers override earlier ones.
   */
  async loadAll() {
    const discovered = await this.discover();
    const byName = new Map();

    for (const entry of discovered) {
      try {
        const raw = await readFile(entry.path, 'utf-8');
        const parsed = YAML.parse(raw);

        const validation = this.validate(parsed);
        if (!validation.valid) {
          console.warn(`Skipping invalid behavior at ${entry.path}: ${validation.errors.join(', ')}`);
          continue;
        }

        parsed._tier = entry.tier;
        parsed._path = entry.path;

        if (byName.has(parsed.name)) {
          console.warn(
            `Behavior '${parsed.name}' from ${entry.tier} tier overrides ${byName.get(parsed.name)._tier} tier`
          );
        }
        byName.set(parsed.name, parsed);
      } catch (err) {
        console.warn(`Failed to load behavior at ${entry.path}: ${err.message}`);
      }
    }

    this._behaviors = byName;
    this._loaded = true;
    return byName;
  }

  /**
   * Get directives applicable to a given agent type.
   */
  getDirectives(agentType) {
    const directives = [];

    for (const behavior of this._behaviors.values()) {
      if (!this._matchesAgentType(behavior, agentType)) continue;

      for (const directive of behavior.directives || []) {
        directives.push({ ...directive, _behaviorName: behavior.name });
      }
    }

    return directives;
  }

  /**
   * Get toolset applicable to a given agent type.
   */
  getToolset(agentType) {
    const tools = [];

    for (const behavior of this._behaviors.values()) {
      if (!this._matchesAgentType(behavior, agentType)) continue;

      for (const tool of behavior.tools || []) {
        tools.push({ ...tool, _behaviorName: behavior.name });
      }
    }

    return tools;
  }

  /**
   * Validate a parsed behavior YAML against the required schema.
   */
  validate(behaviorYaml) {
    const errors = [];

    if (!behaviorYaml || typeof behaviorYaml !== 'object') {
      return { valid: false, errors: ['Behavior must be a non-null object'] };
    }

    for (const field of REQUIRED_FIELDS) {
      if (behaviorYaml[field] === undefined || behaviorYaml[field] === null) {
        errors.push(`Missing required field: '${field}'`);
      }
    }

    if (behaviorYaml.agentTypes && !Array.isArray(behaviorYaml.agentTypes)) {
      errors.push("'agentTypes' must be an array");
    }

    if (behaviorYaml.directives && !Array.isArray(behaviorYaml.directives)) {
      errors.push("'directives' must be an array");
    } else if (Array.isArray(behaviorYaml.directives)) {
      for (const [i, d] of behaviorYaml.directives.entries()) {
        if (!d.id) errors.push(`Directive at index ${i} missing 'id'`);
        if (!d.rule) errors.push(`Directive at index ${i} missing 'rule'`);
      }
    }

    if (behaviorYaml.tools && !Array.isArray(behaviorYaml.tools)) {
      errors.push("'tools' must be an array");
    } else if (Array.isArray(behaviorYaml.tools)) {
      for (const [i, t] of behaviorYaml.tools.entries()) {
        if (!t.tool) errors.push(`Tool at index ${i} missing 'tool'`);
        if (!t.description) errors.push(`Tool at index ${i} missing 'description'`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Merge multiple behaviors. Returns combined directives and toolset.
   * Directive collisions: highest priority wins (default 0), then later attachment.
   * Every collision warns with the winning and losing behaviors.
   * Toolset collisions: error.
   */
  merge(behaviors) {
    const directiveMap = new Map(); // id -> directive
    const toolMap = new Map(); // tool name -> tool
    const warnings = [];

    for (const behavior of behaviors) {
      for (const directive of behavior.directives || []) {
        const incoming = { ...directive, _behaviorName: behavior.name };
        const previous = directiveMap.get(directive.id);
        if (previous) {
          const incomingPriority = directive.priority ?? 0;
          const previousPriority = previous.priority ?? 0;
          const incomingWins = incomingPriority >= previousPriority;
          const winner = incomingWins ? incoming : previous;
          const loser = incomingWins ? previous : incoming;
          const reason = incomingPriority === previousPriority
            ? 'equal priority; later in attachment order'
            : 'higher priority';
          warnings.push(
            `Directive '${directive.id}': '${winner._behaviorName}' (priority ${winner.priority ?? 0}) ` +
            `wins over '${loser._behaviorName}' (priority ${loser.priority ?? 0}); ${reason}`
          );
          if (!incomingWins) continue;
        }
        directiveMap.set(directive.id, incoming);
      }

      for (const tool of behavior.tools || []) {
        if (toolMap.has(tool.tool)) {
          throw new Error(
            `Tool name collision: '${tool.tool}' defined in both ` +
            `'${toolMap.get(tool.tool)._behaviorName}' and '${behavior.name}'`
          );
        }
        toolMap.set(tool.tool, { ...tool, _behaviorName: behavior.name });
      }
    }

    return {
      directives: Array.from(directiveMap.values()),
      toolset: Array.from(toolMap.values()),
      warnings,
    };
  }

  /**
   * Get discovery tier info (for CLI display).
   */
  getTierInfo() {
    return this._tiers.map(t => ({ name: t.name, path: t.path }));
  }

  // --- Private ---

  _matchesAgentType(behavior, agentType) {
    if (!behavior.agentTypes || !Array.isArray(behavior.agentTypes)) return false;
    return behavior.agentTypes.includes(agentType) || behavior.agentTypes.includes('*');
  }
}
