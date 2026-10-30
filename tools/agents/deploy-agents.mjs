#!/usr/bin/env node
/**
 * Deploy Agents and Commands - Orchestrator
 *
 * Deploy agents/commands from this repository to a target project.
 * Delegates to provider-specific modules for platform-specific deployment.
 *
 * Usage:
 *   node tools/agents/deploy-agents.mjs [options]
 *
 * Options:
 *   --source <path>          Source directory (defaults to repo root)
 *   --target <path>          Target directory (defaults to cwd)
 *   --scope <user|project>   Deployment scope (default: project)
 *   --user                  Shorthand for --scope user
 *   --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
 *   --deploy-commands        Deploy commands in addition to agents
 *   --deploy-skills          Deploy skills in addition to agents
 *   --deploy-rules           Deploy rules in addition to agents
 *   --commands-only          Deploy only commands (skip agents)
 *   --skills-only            Deploy only skills (skip agents)
 *   --strict                 Fail startup budget overruns before deployment promotion
  --report-only            Warn on startup budget overruns (migration default; CI remains strict)
  --rules-only             Deploy only rules (skip agents)
 *   --dry-run                Show what would be deployed without writing
 *   --force                  Overwrite existing files
 *   --provider <name>        Target provider: antigravity (agy), claude (default), openai, codex, cursor, opencode, copilot, factory, grokbot, grok-build, muse, pi, omp, deepseek-harness (dsh), warp, devin, hermes, openhuman, or openclaw
 *   --model <name>            Override model for all tiers (blanket)
 *   --reasoning-model <name> Override model for reasoning tasks
 *   --coding-model <name>    Override model for coding tasks
 *   --efficiency-model <name> Override model for efficiency tasks
 *   --model-tier <tier>      Override all artifacts with economy|standard|premium
 *   --as-agents-md               Aggregate to single AGENTS.md (OpenAI/Codex)
 *   --create-agents-md           Create/update AGENTS.md template
  --no-context-files           Preserve WORKSPACE.md, AIWG.md and AGENTS.md (including managed blocks)
 *   --skip-commands-migration    Skip deleting the commands directory (warns about duplicate TUI entries) (Factory/Codex/OpenCode/Cursor)
 *   --deploy-source <name>       Managed-marker source for deployed artifacts (default: bundled)
 *   --deploy-version <version>   Managed-marker version for deployed artifacts (default: source package.json)
 *
 * Modes:
 *   general       - Deploy only writing-quality addon agents and commands (alias: writing)
 *   writing       - Deploy only writing-quality addon agents (alias for general)
 *   sdlc          - Deploy only SDLC Complete framework agents and commands
 *   marketing     - Deploy only Media/Marketing Kit framework agents and commands (alias: mmk)
 *   media-curator - Deploy only Media Curator framework agents and commands
 *   research      - Deploy only Research Complete framework agents and commands
 *   both          - Deploy writing + SDLC (legacy compatibility)
 *   all           - Deploy all frameworks + addons (default)
 *
 * Providers:
 *   claude    - Claude Code (default) - .claude/agents/, .claude/commands/, .claude/skills/, .claude/rules/
 *   factory   - Factory AI - .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
 *   codex     - OpenAI Codex - .codex/agents/, .codex/commands/, .codex/skills/, .codex/rules/
 *   openai    - Alias for codex
 *   opencode  - OpenCode - .opencode/skill/, .opencode/rule/ (agents+commands not file-based)
 *   copilot   - GitHub Copilot - .github/agents/, .github/commands/, .github/skills/, .github/copilot-rules/
 *   cursor    - Cursor IDE - .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
 *   warp      - Warp Terminal - .warp/agents/, .warp/commands/, .warp/skills/, .warp/rules/ + WARP.md
 *   devin     - Devin Desktop - .windsurf/agents/, .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/
 *   windsurf  - Deprecated alias for devin
 *   openclaw  - OpenClaw - ~/.openclaw/agents/, ~/.openclaw/commands/, ~/.openclaw/skills/, ~/.openclaw/rules/, ~/.openclaw/behaviors/
 *   pi        - Pi Coding Agent - .agents/skills/, .pi/skills/, .pi/prompts/, AGENTS.md
 *   omp       - Oh My Pi - .omp/agents/, .omp/prompts/, .agents/skills/, .omp/AGENTS.md
 *   deepseek-harness - DeepSeek Harness - .agents/skills/, AGENTS.md, .dsh/aiwg.cordis.patch.yml
 *
 * Defaults:
 *   --source resolves relative to this script's repo root (../..)
 *   --target is process.cwd()
 *   --mode is 'all'
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const staticModelCatalog = _require('../../agentic/code/providers/model-catalog.v1.json');
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import { importImpl } from '../_resolve-impl.mjs';
const { resolveDeployVersion } = await importImpl(import.meta.url, 'providers/deploy-version.mjs');
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  addManagedMarker,
  collectBehaviorDirs,
  collectFrameworkArtifacts,
  contentHash,
  deployEmulatedBehaviors,
  getAddonSkillDirs,
  listSkillDirs,
  loadModelConfig,
  loadRuntimeModelCatalog,
  migrateCommandsDirectory,
  parseFrontmatter,
  resolveAiwgRoot,
  updateSidecarManifest,
} from './providers/base.mjs';

// ============================================================================
// Provider Registry
// ============================================================================

const PROVIDER_ALIASES = {
  agy: 'antigravity',
  'openai': 'codex',
  'devin': 'windsurf',
  'devin-desktop': 'windsurf',
  'devin-local': 'windsurf',
  'cascade': 'windsurf',
  'pi-coding-agent': 'pi',
  'oh-my-pi': 'omp',
  'dsh': 'deepseek-harness',
};

const AVAILABLE_PROVIDERS = ['antigravity', 'claude', 'factory', 'codex', 'opencode', 'copilot', 'cursor', 'pi', 'omp', 'deepseek-harness', 'warp', 'windsurf', 'hermes', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'muse'];

const UNSUPPORTED_PROVIDER_HINTS = {
  'devin-cli': [
    'Devin CLI has distinct rules/skills surfaces and is not a deployable AIWG provider yet.',
    'Use --provider devin for Devin Desktop deployments.',
  ],
};

const MIRRORED_STANDARD_COMMAND_SKILLS = new Set([
  'aiwg-setup-project',
  'aiwg-update-claude',
  'aiwg-update-agents-md',
  'sdlc-accelerate',
  'project-status',
  'intake-wizard',
  'intake-from-codebase',
  'intake-start',
  // Issue-workflow entry commands — invoked directly by users; mirror as
  // commands so they reach .opencode/command/, .claude/commands/, etc. (#1549).
  'address-issues',
  'issue-audit',
]);

const MIRRORED_KERNEL_COMMAND_SKILLS = new Set([
  'aiwg-refresh',
  'aiwg-doctor',
  'aiwg-status',
  'aiwg-help',
  'aiwg-regenerate',
  'aiwg-regenerate-claude',
  'aiwg-regenerate-codex',
  'aiwg-regenerate-opencode',
  'aiwg-regenerate-agents',
  'aiwg-issue',
  'aiwg-pr',
  'aiwg-mission',
  'use',
  'steward',
]);

function providerUsesSkillsNatively(providerName) {
  return ['antigravity', 'claude', 'cursor', 'deepseek-harness', 'hermes', 'openhuman', 'pi', 'omp'].includes(providerName);
}

function shouldMirrorStandardCommandSkill(skillName) {
  return (
    skillName.startsWith('flow-') ||
    MIRRORED_STANDARD_COMMAND_SKILLS.has(skillName)
  );
}

function shouldMirrorCommandSkill(providerName, skillName) {
  if (MIRRORED_KERNEL_COMMAND_SKILLS.has(skillName)) {
    return !providerUsesSkillsNatively(providerName);
  }

  return shouldMirrorStandardCommandSkill(skillName);
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

export function collectMirrorSkillDirs(srcRoot, mode, providerName) {
  const dirs = [];

  const directSkillsDir = path.join(srcRoot, 'skills');
  dirs.push(...listSkillDirs(directSkillsDir));

  // If --source itself is a skills directory, support that shape too.
  dirs.push(...listSkillDirs(srcRoot));

  const repoFrameworksRoot = path.join(srcRoot, 'agentic', 'code', 'frameworks');
  if (fs.existsSync(repoFrameworksRoot)) {
    const artifacts = collectFrameworkArtifacts(srcRoot, mode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    dirs.push(...artifacts.skills);

    // Pi's provider collector already deploys all eligible addon skills for
    // every root framework mode. Mirror the command-shaped addon skills in
    // that same root pass so `aiwg use` does not need to repeat the entire
    // deployment once per addon merely to produce these wrappers. Keep addon
    // skills after framework skills: this preserves the existing per-addon
    // winner when a framework and addon expose the same command name.
    if (mode === 'all'
      || (providerName === 'pi' && ['general', 'sdlc', 'both'].includes(mode))) {
      dirs.push(...getAddonSkillDirs(srcRoot));
    }
  }

  return uniquePaths(dirs);
}

function resolveCommandMirrorDir(provider, target) {
  const commandsPath = provider.paths?.commands;
  if (commandsPath) {
    return path.isAbsolute(commandsPath) ? commandsPath : path.join(target, commandsPath);
  }

  // Closest conventional location for providers whose primary command
  // surface is MCP/aggregation rather than a documented command directory.
  if (provider.name === 'hermes') {
    // #2119: HERMES_HOME is the single source of truth the running Hermes
    // runtime uses to locate its files — resolve the home the same way the
    // provider does instead of hardcoding $HOME/.hermes.
    const hermesHome = typeof provider.getHermesHome === 'function'
      ? provider.getHermesHome()
      : path.join(os.homedir(), '.hermes');
    return path.resolve(hermesHome, 'commands');
  }

  return null;
}

function commandFileExtensionForProvider(provider) {
  if (provider.name === 'copilot') return '.prompt.md';
  return '.md';
}

function resolveSkillCommandPolicy(commandHint = {}) {
  const legacy = String(commandHint.model || '').trim().toLowerCase();
  const legacyRole = legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency'
      : legacy ? 'coding' : null;
  const modelRole = commandHint.modelRole || legacyRole;
  if (!modelRole) return null;
  const modelTier = commandHint.modelTier
    || (modelRole === 'reasoning' ? 'premium'
      : modelRole === 'efficiency' ? 'economy' : 'standard');
  return {
    modelRole,
    modelTier,
    modelEffort: commandHint.modelEffort,
    modelRationale: commandHint.modelRationale,
  };
}

function parseSkillCommandHint(raw) {
  const { frontmatter } = parseFrontmatter(raw);
  const block = frontmatter?.match(/^commandHint:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] || '';
  const hint = {};
  for (const line of block.split('\n')) {
    const match = line.trim().match(/^(model|modelRole|modelTier|modelEffort|modelRationale):\s*(.+)$/);
    if (match) hint[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return hint;
}

function skillToCommandContent(skillDir) {
  const skillName = path.basename(skillDir);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { metadata, body } = parseFrontmatter(raw);
  const description = metadata.description || `Run AIWG skill ${skillName}`;
  const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
  const policyLines = policy ? [
    `aiwg-model-role: ${policy.modelRole}`,
    `aiwg-model-tier: ${policy.modelTier}`,
    ...(policy.modelEffort ? [`aiwg-model-effort: ${policy.modelEffort}`] : []),
    ...(policy.modelRationale ? [`aiwg-model-rationale: ${policy.modelRationale}`] : []),
  ] : [];

  return `---\nname: ${skillName}\ndescription: ${description}\n${policyLines.join('\n')}${policyLines.length ? '\n' : ''}---\n\n${body.trim()}\n`;
}

function mirrorSkillsAsCommands(provider, target, srcRoot, opts) {
  if (!opts.deployCommands && !opts.commandsOnly) return 0;

  const targetDir = resolveCommandMirrorDir(provider, target);
  if (!targetDir) return 0;

  const skillDirs = collectMirrorSkillDirs(srcRoot, opts.mode, provider.name)
    .filter((dir) => shouldMirrorCommandSkill(provider.name, path.basename(dir)));

  if (skillDirs.length === 0) return 0;
  if (!opts.dryRun) fs.mkdirSync(targetDir, { recursive: true });

  const ext = commandFileExtensionForProvider(provider);
  const deployedEntries = [];
  let count = 0;

  for (const skillDir of skillDirs) {
    const skillName = path.basename(skillDir);
    let content = skillToCommandContent(skillDir);
    if (typeof provider.transformCommand === 'function') {
      content = provider.transformCommand(path.join(skillDir, `${skillName}.md`), content, opts);
    }
    // #2507: mirrored wrappers used to be written with no ownership signal, so
    // AIWG could neither count them as deployed nor prune them when the source
    // skill went away — a later run reported its own 46 wrappers as unmanaged
    // artifacts the operator should delete. They carry the same managed marker
    // and sidecar entry as any other deployed command now.
    content = addManagedMarker(content, opts.deployVersion || 'unknown', opts.deploySource || 'bundled');

    const filename = `${skillName}${ext}`;
    const dest = path.join(targetDir, filename);
    if (opts.dryRun) {
      if (opts.verbose) console.log(`[dry-run] mirror skill command ${skillName} -> ${dest}`);
      const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      const policy = resolveSkillCommandPolicy(parseSkillCommandHint(raw));
      if (policy && opts.verbose) {
        const outcome = provider.name === 'claude' ? 'native'
          : provider.name === 'factory' ? 'informational' : 'unsupported';
        console.log(`[dry-run] skill model policy ${skillName}: ${outcome} (${policy.modelRole}/${policy.modelTier})`);
      }
    } else {
      fs.writeFileSync(dest, content, 'utf8');
    }
    deployedEntries.push({ filename, hash: contentHash(content), kind: 'skill-command' });
    count++;
  }

  if (deployedEntries.length > 0) {
    updateSidecarManifest(targetDir, deployedEntries, {
      dryRun: opts.dryRun,
      version: opts.deployVersion || 'unknown',
      source: opts.deploySource || 'bundled',
    });
  }

  return count;
}


export { bulkInstallOwnsFlatArtifacts } from './providers/stale-artifact-prune.mjs';
import { pruneStaleAiwgArtifacts } from './providers/stale-artifact-prune.mjs';

// ============================================================================
// Argument Parsing
// ============================================================================

export function parseArgs(args = process.argv.slice(2)) {
  const cfg = {
    source: null,
    userScope: false,
    target: process.cwd(),
    mode: 'all',  // 'general', 'sdlc', 'marketing', 'media-curator', 'research', 'both' (legacy), or 'all'
    dryRun: false,
    force: false,
    provider: 'claude',
    model: null,             // Blanket override for all tiers
    modelTier: null,         // Blanket canonical tier override
    reasoningModel: null,
    codingModel: null,
    efficiencyModel: null,
    asAgentsMd: false,
    createAgentsMd: false,
    contextFiles: true,
    projectScope: false,
    deployCommands: false,
    deploySkills: false,
    deployRules: false,
    deployBehaviors: false,      // Deploy behaviors (native on openclaw, emulated on others)
    commandsOnly: false,
    skillsOnly: false,
    rulesOnly: false,
    strict: false,
    reportOnly: true,
    kernelOnly: false,
    deferRuleProjection: false,
    additionalSources: [],
    filter: null,           // Glob pattern for agent names
    filterRole: null,       // Filter by role: reasoning|coding|efficiency
    save: false,            // Save model config to project models.json
    saveUser: false,        // Save model config to ~/.config/aiwg/models.json
    verbose: false,         // Show per-file deployment details
    quiet: false,           // Suppress all non-error output (for embedding in use.ts)
    asPlugin: false,        // Generate .factory-plugin/ bundle (Factory provider only)
    deployBehaviors: false, // Deploy behaviors in addition to agents
    skipCommandsMigration: false, // Skip commands → skills migration (warns about duplicates)
    warnOnSkippedCommandsMigration: true, // Emit the duplicate warning when the migration is skipped
    // Managed-marker provenance (#2502). Deployers that are not shipping the
    // bundled framework corpus (project-local bundles, in particular) must
    // override these so `aiwg refresh` does not mistake their artifacts for
    // stale copies of packaged ones.
    deploySource: null,           // Managed-marker source; defaults to 'bundled'
    listingBudget: false,         // Honor the provider startup-listing cap despite --copy-all (#2561)
    deployVersion: null,          // Managed-marker version; defaults to srcRoot package.json
    mcp: false,                   // #228: opt-in MCP settings profile (Muse provider)
    hooks: true,                  // #228: managed project hooks (Muse provider); --no-hooks opts out
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) cfg.source = path.resolve(args[++i]);
    else if (a === '--additional-source') {
      const source = args[++i];
      if (!source || source.startsWith('--')) throw new Error('--additional-source requires a source directory');
      cfg.additionalSources.push(path.resolve(source));
    }
    else if (a === '--target' && args[i + 1]) cfg.target = path.resolve(args[++i]);
    else if (a === '--mode' && args[i + 1]) cfg.mode = String(args[++i]).toLowerCase();
    else if (a === '--scope') {
      const scope = args[++i];
      if (scope !== 'user' && scope !== 'project') {
        throw new Error(`--scope expected 'user' or 'project', got '${scope ?? '(missing)'}'`);
      }
      cfg.userScope = scope === 'user';
      cfg.projectScope = scope === 'project';
    }
    else if (a === '--user') cfg.userScope = true;
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--force') cfg.force = true;
    else if ((a === '--provider' || a === '--platform') && args[i + 1]) cfg.provider = String(args[++i]).toLowerCase();
    else if (a === '--model' && args[i + 1]) cfg.model = args[++i];
    else if (a === '--model-tier' && args[i + 1]) cfg.modelTier = String(args[++i]).toLowerCase();
    else if ((a === '--reasoning-model' || a === '--reasoning') && args[i + 1]) cfg.reasoningModel = args[++i];
    else if ((a === '--coding-model' || a === '--coding') && args[i + 1]) cfg.codingModel = args[++i];
    else if ((a === '--efficiency-model' || a === '--efficiency') && args[i + 1]) cfg.efficiencyModel = args[++i];
    else if (a === '--as-agents-md') cfg.asAgentsMd = true;
    else if (a === '--create-agents-md') cfg.createAgentsMd = true;
    else if (a === '--deploy-commands') cfg.deployCommands = true;
    else if (a === '--deploy-skills') cfg.deploySkills = true;
    else if (a === '--deploy-rules') cfg.deployRules = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--commands-only') cfg.commandsOnly = true;
    else if (a === '--skills-only') cfg.skillsOnly = true;
    else if (a === '--rules-only') cfg.rulesOnly = true;
    else if (a === '--strict') { cfg.strict = true; cfg.reportOnly = false; }
    else if (a === '--allow-over-budget') cfg.allowOverBudget = true;
    else if (a === '--report-only') cfg.reportOnly = true;
    else if (a === '--kernel-only') cfg.kernelOnly = true;
    // Internal use orchestration: the final source owns rule presentation.
    else if (a === '--defer-rule-projection') cfg.deferRuleProjection = true;
    else if (a === '--deploy-behaviors') cfg.deployBehaviors = true;
    else if (a === '--filter' && args[i + 1]) cfg.filter = args[++i];
    else if (a === '--filter-role' && args[i + 1]) cfg.filterRole = args[++i];
    else if (a === '--save') cfg.save = true;
    else if (a === '--save-user') cfg.saveUser = true;
    else if (a === '--verbose' || a === '-v') cfg.verbose = true;
    else if (a === '--quiet' || a === '-q') cfg.quiet = true;
    else if (a === '--as-plugin') cfg.asPlugin = true;
    else if (a === '--skip-commands-migration') cfg.skipCommandsMigration = true;
    // Structural opt-out: skip the migration without claiming the operator declined it (#2541).
    else if (a === '--no-commands-warning') cfg.warnOnSkippedCommandsMigration = false;
    else if (a === '--copy-all' || a === '--copy-standard-skills') cfg.copyStandardSkills = true;
    // #228: Muse provider — explicit opt-in MCP settings profile, and the
    // managed-hooks opt-out (default on, mirroring the Claude autoInstall policy).
    else if (a === '--mcp') cfg.mcp = true;
    else if (a === '--no-hooks') cfg.hooks = false;
    else if (a === '--no-attribution') cfg.attribution = false;
    else if (a === '--no-context-files') cfg.contextFiles = false;
    else if (a === '--deploy-source' && args[i + 1]) cfg.deploySource = String(args[++i]);
    else if (a === '--listing-budget') cfg.listingBudget = true;
    else if (a === '--deploy-version' && args[i + 1]) cfg.deployVersion = String(args[++i]);
    else if (a === '--help' || a === '-h') {
      cfg.help = true;
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`
Deploy Agents and Commands

Usage:
  node tools/agents/deploy-agents.mjs [options]
  aiwg -deploy-agents [options]

Options:
  --source <path>          Source directory (defaults to repo root)
  --target <path>          Target directory (defaults to cwd)
  --scope <user|project>   Deployment scope (default: project)
  --user                  Shorthand for --scope user
  --mode <type>            Deployment mode: general, sdlc, marketing (alias: mmk), media-curator, research, both, or all (default)
  --deploy-commands        Deploy commands in addition to agents
  --deploy-skills          Deploy skills in addition to agents
  --deploy-rules           Deploy rules in addition to agents
  --commands-only          Deploy only commands (skip agents)
  --skills-only            Deploy only skills (skip agents)
  --rules-only             Deploy only rules (skip agents)
  --kernel-only            Deploy kernel skills and rules; prune managed bulk agents/commands
  --dry-run                Show what would be deployed without writing
  --force                  Overwrite existing files
  --provider <name>        Target provider (see below)
  --model <name>           Override model for all tiers (blanket)
  --reasoning-model <name> Override model for reasoning tasks (alias: --reasoning)
  --coding-model <name>    Override model for coding tasks (alias: --coding)
  --efficiency-model <name> Override model for efficiency tasks (alias: --efficiency)
  --model-tier <tier>      Override all artifacts with economy|standard|premium
  --filter <pattern>       Only deploy agents matching pattern (glob)
  --filter-role <role>     Only deploy agents of role: reasoning|coding|efficiency
  --save                   Save model config to project models.json
  --save-user              Save model config to ~/.config/aiwg/models.json
  --mcp                    Muse provider: opt in to the AIWG MCP settings profile
                           (merges the aiwg stdio server into user settings
                           mcp_servers; default off)
  --no-hooks               Muse provider: skip managed project hooks
                           (.muse/hooks.json; installed by default)
  --no-attribution         Claude provider: leave attribution settings untouched
  --as-agents-md               Aggregate to single AGENTS.md (Codex)
  --create-agents-md           Create/update AGENTS.md template
  --no-context-files           Preserve WORKSPACE.md, AIWG.md and AGENTS.md (including managed blocks)
  --skip-commands-migration    Skip deleting the commands directory before skills deployment
  --listing-budget             Honor the provider startup-listing cap even with --copy-all
  --deploy-source <name>       Managed-marker source stamped into deployed artifacts.
                               Defaults to 'bundled'. Deploys that do not ship the packaged
                               framework corpus (e.g. project-local bundles) MUST override
                               this so refresh's stale-artifact prune skips them (#2502).
  --deploy-version <version>   Managed-marker version stamped into deployed artifacts.
                               Defaults to the --source tree's package.json version.
  --copy-all                   Copy ALL skills per-project (legacy mirror at <provider>/.aiwg/skills/).
                               For aiwg use all, this also restores the legacy full agent,
                               command, and expanded-rule copy. Default bulk deployment is
                               kernel-only + index-driven discovery for the rest (#1217).
                               Use this for sandboxed runtimes / air-gapped corpora where
                               $AIWG_ROOT isn't readable from the agent's working dir.
                               Alias: --copy-standard-skills — rc.29 era).
                               (warns about duplicate entries in the provider command palette)

Model Override Examples:
  # Use sonnet for everything
  aiwg use sdlc --model sonnet

  # Override individual tiers
  aiwg use sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Use a specific model ID for coding tier
  aiwg use sdlc --provider factory --coding-model gpt-5.6-terra

  # Blanket with per-tier override (reasoning uses opus, others use sonnet)
  aiwg use sdlc --model sonnet --reasoning opus

  # Save overrides to project models.json for future deployments
  aiwg use sdlc --model sonnet --save

Model Precedence:
  CLI flags > project models.json > user ~/.config/aiwg/models.json > AIWG defaults

Shorthand Values:
  opus, sonnet, haiku, inherit — resolved per provider to full model IDs

Providers (all deploy agents, commands, skills, and rules):
  claude    - Claude Code (default)
              Paths: .claude/agents/, .claude/commands/, .claude/skills/, .claude/rules/
  factory   - Factory AI
              Paths: .factory/droids/, .factory/commands/, .factory/skills/, .factory/rules/
  codex     - OpenAI Codex (alias: openai)
              Paths: .codex/agents/, .codex/commands/, .codex/skills/, .codex/rules/
  opencode  - OpenCode
              Paths: .opencode/skill/, .opencode/rule/ (agents/commands not file-based in OpenCode)
  copilot   - GitHub Copilot
              Paths: .github/agents/, .github/commands/, .github/skills/, .github/copilot-rules/
  cursor    - Cursor IDE
              Paths: .cursor/agents/, .cursor/commands/, .cursor/skills/, .cursor/rules/
  warp      - Warp Terminal
              Paths: .warp/agents/, .warp/commands/, .warp/skills/, .warp/rules/ + WARP.md
  deepseek-harness - DeepSeek Harness (alias: dsh; experimental)
              Paths: AGENTS.md, .agents/skills/, .dsh/aiwg.cordis.patch.yml
  devin     - Devin Desktop (preferred; aliases: devin-desktop, windsurf)
              Paths: .windsurf/agents/, .windsurf/workflows/, .windsurf/skills/, .windsurf/rules/
  grokbot   - Grok Bot (AGENTS.md bridge; skills only with AIWG_GROKBOT_SKILLS_DIR)
  grok-build - Grok Build (experimental; .grok paths + $GROK_HOME; no bare grok alias)
  muse      - Muse Code (stable; AGENTS.md bridge; .agents/skills + XDG user root; managed hooks, opt-in --mcp; no aliases)
  hermes    - Hermes Agent (MCP-based integration)
              Skills: $HERMES_HOME/skills/ (user-global; defaults to ~/.hermes/skills/) | Agents: AGENTS.md
              Commands/Rules: served via MCP, not file-deployed

Modes:
  general       - Writing-quality addon agents and commands (alias: writing)
  sdlc          - SDLC Complete framework agents and commands
  marketing     - Media/Marketing Kit framework agents and commands (alias: mmk)
  media-curator - Media Curator framework agents and commands
  research      - Research Complete framework agents and commands
  both          - writing + SDLC (legacy compatibility)
  all           - All frameworks + addons (default)

Examples:
  # Deploy SDLC framework to Claude Code
  aiwg -deploy-agents --mode sdlc

  # Deploy to Factory with commands and AGENTS.md
  aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands --create-agents-md

  # Deploy to GitHub Copilot
  aiwg -deploy-agents --provider copilot --mode sdlc

  # Override model for all tiers
  aiwg -deploy-agents --mode sdlc --model sonnet

  # Override individual tiers
  aiwg -deploy-agents --mode sdlc --reasoning opus --coding sonnet --efficiency haiku

  # Dry run to preview deployment
  aiwg -deploy-agents --provider cursor --mode sdlc --dry-run
`);
}

// ============================================================================
// Provider Loading
// ============================================================================

/**
 * Resolve provider name (handle aliases)
 */
function resolveProvider(name) {
  const candidate = String(name || '').trim().toLowerCase();
  const resolved = PROVIDER_ALIASES[candidate] || candidate;
  if (!AVAILABLE_PROVIDERS.includes(resolved)) {
    console.error(`Unknown provider: ${name}`);
    console.error(`Available providers: ${AVAILABLE_PROVIDERS.join(', ')}`);
    console.error(`Aliases: ${Object.entries(PROVIDER_ALIASES).map(([a, p]) => `${a} -> ${p}`).join(', ')}`);
    if (UNSUPPORTED_PROVIDER_HINTS[candidate]) {
      console.error('');
      for (const line of UNSUPPORTED_PROVIDER_HINTS[candidate]) console.error(line);
    }
    throw new Error(`Unknown provider: ${name}`);
  }
  return resolved;
}

/**
 * Dynamically load provider module
 */
async function loadProvider(providerName) {
  const resolved = resolveProvider(providerName);
  // Resolve against this module, not the caller's cwd: in-process callers
  // (including module runners such as Vitest) cannot resolve a bare relative
  // specifier held in a variable.
  const providerUrl = new URL(`./providers/${resolved}.mjs`, import.meta.url).href;

  try {
    const provider = await import(providerUrl);
    return provider.default || provider;
  } catch (err) {
    console.error(`Failed to load provider '${resolved}':`, err.message);
    throw err;
  }
}

// ============================================================================
// Model Shorthand Resolution
// ============================================================================

/**
 * Resolve a shorthand model value to a full model ID
 *
 * If the value is a known shorthand (opus, sonnet, haiku, inherit), resolve it
 * through the provider's shorthand map. Otherwise treat it as a literal model ID.
 *
 * @param {string|null} value - CLI flag value (e.g., "opus" or "claude-opus-5")
 * @param {object} shorthandMap - Provider shorthand map (e.g., { opus: "claude-opus-5" })
 * @param {object} modelsConfig - Full models config from loadModelConfig()
 * @param {string} provider - Provider name
 * @param {string} tier - Tier name: "reasoning", "coding", or "efficiency"
 * @returns {string|null} Resolved model ID or null if input was null
 */
function resolveShorthand(value, shorthandMap, modelsConfig, provider, tier) {
  if (!value) return null;

  const clean = value.toLowerCase().replace(/['"]/g, '');

  // Check shorthand map first
  if (shorthandMap[clean]) return shorthandMap[clean];

  // Check provider-specific tier config (e.g., modelsConfig.factory.reasoning.model)
  const providerConfig = modelsConfig?.[provider];
  if (providerConfig?.[tier]?.model && clean === tier) {
    return providerConfig[tier].model;
  }

  // Not a shorthand — return as literal model ID
  return value;
}

// ============================================================================
// Model Configuration Persistence
// ============================================================================

/**
 * Save model configuration to project or user config file
 * @param {object} cfg - Configuration with model overrides
 * @param {string} providerName - Provider name for provider-specific config
 */
async function saveModelConfig(cfg, providerName) {
  // Build config object with only the provided overrides
  const modelConfig = {};
  if (cfg.modelTier) {
    modelConfig.defaults = { tier: cfg.modelTier };
  }

  // Provider-specific tier configuration
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    modelConfig[providerName] = {};
    if (cfg.reasoningModel) {
      modelConfig[providerName].reasoning = { model: cfg.reasoningModel };
    }
    if (cfg.codingModel) {
      modelConfig[providerName].coding = { model: cfg.codingModel };
    }
    if (cfg.efficiencyModel) {
      modelConfig[providerName].efficiency = { model: cfg.efficiencyModel };
    }
  }

  // Shorthand mappings
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    modelConfig.shorthand = {};
    if (cfg.reasoningModel) modelConfig.shorthand.opus = cfg.reasoningModel;
    if (cfg.codingModel) modelConfig.shorthand.sonnet = cfg.codingModel;
    if (cfg.efficiencyModel) modelConfig.shorthand.haiku = cfg.efficiencyModel;
  }

  // Determine target path
  let targetPath;
  if (cfg.saveUser) {
    const configDir = path.join(os.homedir(), '.config', 'aiwg');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    targetPath = path.join(configDir, 'models.json');
  } else {
    targetPath = path.join(cfg.target, 'models.json');
  }

  // Merge with existing config if it exists
  let existingConfig = {};
  if (fs.existsSync(targetPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  // Deep merge: existing config + new overrides
  const mergedConfig = deepMerge(existingConfig, modelConfig);

  // Write the config
  fs.writeFileSync(targetPath, JSON.stringify(mergedConfig, null, 2) + '\n', 'utf8');
  console.log(`\nModel configuration saved to: ${targetPath}`);
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ============================================================================
// Commands → Skills Migration
// ============================================================================

/**
 * Ask the user whether to delete the provider's commands directory before
 * deploying skills. Skipped automatically when not running in a TTY (CI/pipe)
 * or when --quiet is set.
 *
 * @param {object} cfg - Parsed CLI config
 * @param {object} provider - Loaded provider module
 * @param {string} targetDir - Resolved target directory
 * @returns {Promise<boolean>} true = proceed with migration, false = skip
 */
async function promptCommandsMigration(cfg, provider, targetDir, interactive = process.stdout.isTTY) {
  // Home-directory providers share commands across projects — do not delete.
  if (provider.capabilities?.homeDirectoryDeploy) return false;
  // Some providers intentionally expose both surfaces with different runtime
  // semantics. Pi prompt templates (/name) are not aliases for Agent Skills
  // (/skill:name), so command-to-skill migration would destroy valid prompts.
  if (provider.capabilities?.parallelCommandAndSkillSurfaces) return false;

  const commandsRelPath = provider.paths?.commands;
  if (!commandsRelPath) return false;

  const commandsDir = path.join(targetDir, commandsRelPath);
  if (!fs.existsSync(commandsDir)) return false;

  const entries = fs.readdirSync(commandsDir).filter(e => e.endsWith('.md'));
  if (entries.length === 0) return false;

  // Non-interactive context: migrate silently.
  if (cfg.quiet || !interactive) return true;

  const rel = path.relative(process.cwd(), commandsDir);
  console.log(`\n⚠  Commands → Skills Migration`);
  console.log(`   ${rel} contains ${entries.length} legacy command file(s).`);
  console.log(`   AIWG now serves these as skills (.claude/skills/).`);
  console.log(`   Keeping both causes duplicate entries in the Claude Code command palette.`);
  console.log('');

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Remove commands directory and migrate? [Y/n] ', ans => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (answer === 'n' || answer === 'no') {
    console.log('');
    console.log('   Skipping migration. Run `aiwg use` again without --skip-commands-migration');
    console.log(`   to clean up, or delete ${rel} manually.`);
    console.log('');
    return false;
  }

  return true;
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function main(args = process.argv.slice(2), internal = {}) {
  const cfg = parseArgs(args);
  if (cfg.help) { printHelp(); return 0; }
  const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);

  // Resolve source directory (default to repo root relative to this script)
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename);
  const srcRoot = cfg.source || path.resolve(scriptDir, '..', '..');

  // Validate source directory
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`Source directory not found: ${srcRoot}`);
  }

  // Validate target directory
  if (!fs.existsSync(cfg.target)) {
    console.log(`Creating target directory: ${cfg.target}`);
    fs.mkdirSync(cfg.target, { recursive: true });
  }

  // Normalize mode aliases
  if (cfg.mode === 'writing') cfg.mode = 'general';
  if (cfg.mode === 'mmk') cfg.mode = 'marketing';

  // Apply --model blanket override: sets all three tiers unless individually overridden
  if (cfg.modelTier) {
    const tierRole = cfg.modelTier === 'economy' ? 'efficiency'
      : cfg.modelTier === 'premium' || cfg.modelTier === 'max-quality' ? 'reasoning'
        : cfg.modelTier === 'standard' ? 'coding' : null;
    if (!tierRole) throw new Error(`Invalid --model-tier: ${cfg.modelTier}`);
    const catalogProvider = cfg.provider === 'openai' ? 'codex' : cfg.provider;
    const providerCatalog = modelCatalog.providers[catalogProvider];
    if (!providerCatalog) throw new Error(`No model catalog entry for --model-tier provider ${cfg.provider}`);
    cfg.model = providerCatalog.roles[tierRole].id;
  }
  if (cfg.model) {
    if (!cfg.reasoningModel) cfg.reasoningModel = cfg.model;
    if (!cfg.codingModel) cfg.codingModel = cfg.model;
    if (!cfg.efficiencyModel) cfg.efficiencyModel = cfg.model;
  }

  // Load model configuration (project > user > AIWG defaults)
  const modelsConfig = loadModelConfig(srcRoot);

  // Resolve shorthand values in CLI flags using provider-specific config
  if (cfg.reasoningModel || cfg.codingModel || cfg.efficiencyModel) {
    const resolvedProvider = resolveProvider(cfg.provider);
    const providerShorthand = modelsConfig?.[`${resolvedProvider}_shorthand`] || modelsConfig?.shorthand || {};

    cfg.reasoningModel = resolveShorthand(cfg.reasoningModel, providerShorthand, modelsConfig, resolvedProvider, 'reasoning');
    cfg.codingModel = resolveShorthand(cfg.codingModel, providerShorthand, modelsConfig, resolvedProvider, 'coding');
    cfg.efficiencyModel = resolveShorthand(cfg.efficiencyModel, providerShorthand, modelsConfig, resolvedProvider, 'efficiency');
  }

  if (!cfg.quiet) {
    console.log(`\n=== AIWG Agent Deployment ===`);
    console.log(`Provider: ${cfg.provider}`);
    console.log(`Source: ${srcRoot}`);
    console.log(`Target: ${cfg.target}`);
    console.log(`Mode: ${cfg.mode}`);
    if (cfg.dryRun) console.log(`Dry run: enabled`);
    if (cfg.filter) console.log(`Filter: ${cfg.filter}`);
    if (cfg.filterRole) console.log(`Filter role: ${cfg.filterRole}`);
    if (cfg.model) console.log(`Model (all tiers): ${cfg.model}`);
    if (cfg.modelTier) console.log(`Canonical tier override: ${cfg.modelTier}`);
    if (cfg.reasoningModel) console.log(`Reasoning model: ${cfg.reasoningModel}`);
    if (cfg.codingModel) console.log(`Coding model: ${cfg.codingModel}`);
    if (cfg.efficiencyModel) console.log(`Efficiency model: ${cfg.efficiencyModel}`);
    if (cfg.save) console.log(`Save to project: enabled`);
    if (cfg.saveUser) console.log(`Save to user config: enabled`);
  }

  // Load provider module
  const provider = await loadProvider(cfg.provider);
  if (cfg.additionalSources.length && provider.name !== 'omp') throw new Error('--additional-source requires the OMP provider');
  for (const source of cfg.additionalSources) {
    if (!fs.statSync(source).isDirectory()) throw new Error(`Additional source is not a directory: ${source}`);
  }
  if (!cfg.quiet) console.log(`\nLoaded provider: ${provider.name}`);

  // Build options for provider
  const opts = {
    srcRoot,
    target: cfg.target,
    ...(cfg.userScope ? { userScope: true } : {}),
    mode: cfg.mode,
    // Provider aliases are selectors, not artifact identities. Passing the
    // canonical id keeps generated frontmatter byte-identical for devin,
    // devin-desktop, and the deprecated windsurf selector.
    provider: resolveProvider(cfg.provider),
    dryRun: cfg.dryRun,
    force: cfg.force,
    reasoningModel: cfg.reasoningModel,
    codingModel: cfg.codingModel,
    efficiencyModel: cfg.efficiencyModel,
    modelsConfig,
    modelCatalog,
    // Warnings belong to this pass, just as they do in an isolated CLI run.
    warnedCommandsDirs: new Set(),
    asAgentsMd: cfg.asAgentsMd,
    createAgentsMd: cfg.contextFiles && cfg.createAgentsMd,
    contextFiles: cfg.contextFiles,
    deployCommands: cfg.kernelOnly ? false : cfg.deployCommands,
    deploySkills: cfg.kernelOnly ? true : cfg.deploySkills,
    deployRules: !cfg.deferRuleProjection && (cfg.kernelOnly || cfg.deployRules),
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    commandsOnly: cfg.commandsOnly,
    skillsOnly: cfg.skillsOnly || cfg.kernelOnly,
    rulesOnly: cfg.rulesOnly,
    strict: cfg.strict,
    reportOnly: cfg.reportOnly,
    allowOverBudget: cfg.allowOverBudget === true,
    kernelOnly: cfg.kernelOnly,
    deferRuleProjection: cfg.deferRuleProjection,
    additionalSources: cfg.additionalSources,
    filter: cfg.filter,
    filterRole: cfg.filterRole,
    save: cfg.save,
    saveUser: cfg.saveUser,
    verbose: cfg.verbose,
    quiet: cfg.quiet,
    asPlugin: cfg.asPlugin,
    deployBehaviors: cfg.kernelOnly ? false : cfg.deployBehaviors,
    skipCommandsMigration: cfg.skipCommandsMigration,
    warnOnSkip: cfg.warnOnSkippedCommandsMigration !== false,
    // #1217 / #1219: --copy-all flag forces legacy per-project mirror
    // for the standard tier. Default is no-copy + index-driven discovery.
    // Replaces the legacy AIWG_COPY_STANDARD_SKILLS env var (removed rc.30).
    // Default (#1217) is no-copy + index-driven discovery.
    copyStandardSkills: cfg.copyStandardSkills === true,
    // #228: Muse provider hooks/MCP profile surface.
    mcp: cfg.mcp === true,
    hooks: cfg.hooks !== false,
    attribution: cfg.attribution !== false,
    listingBudget: cfg.listingBudget === true,
    deployVersion: resolveDeployVersion(resolveAiwgRoot(srcRoot) || srcRoot, cfg.deployVersion),
    deploySource: cfg.deploySource || 'bundled',
  };
  if (provider.name === 'hermes' && cfg.projectScope && !cfg.userScope) {
    throw new Error('Hermes does not support --scope project: skills are discovered only under HERMES_HOME/skills (default ~/.hermes/skills). Use --scope user or an isolated HERMES_HOME profile shared with Hermes.');
  }
  // Deferred kernel source passes must not load the projection dependency
  // graph. Preparation still owns their staged deployment when a hook is active.
  const preparationActive = cfg.kernelOnly && cfg.deferRuleProjection
    ? Boolean(globalThis[Symbol.for('aiwg.provider-preparation-hook.v1')])
    : (await import('./providers/rule-delivery.mjs')).isRuleDeploymentPreparationActive();

  // Commands → Skills migration: prompt then delete the commands directory
  // so stale command files don't create duplicates in the provider TUI.
  if (!preparationActive && !internal.finalizeOnly) {
    if (!cfg.dryRun && !cfg.skipCommandsMigration) {
      const doMigrate = await promptCommandsMigration(cfg, provider, cfg.target, internal.capture ? false : process.stdout.isTTY);
      if (doMigrate) {
        const commandsRelPath = provider.paths?.commands;
        if (commandsRelPath) {
          migrateCommandsDirectory(path.join(cfg.target, commandsRelPath), opts);
        }
      } else {
        // User said no — flip the flag so the provider knows to emit the duplicate warning
        opts.skipCommandsMigration = true;
      }
    } else if (cfg.skipCommandsMigration) {
      // Flag was passed explicitly — emit the duplicate warning now via a dry migration call
      const commandsRelPath = provider.paths?.commands;
      if (commandsRelPath && !provider.capabilities?.homeDirectoryDeploy) {
        migrateCommandsDirectory(path.join(cfg.target, commandsRelPath), opts);
      }
    }
  }

  // Concurrent deployment runs this parent-owned preflight before any child
  // snapshots its inputs. Migration can remove a provider command tree, so it
  // must remain on the same side of the transaction boundary as serial deploy.
  if (internal.preflightOnly) return;

  // Delegate to provider
  try {
    if (!internal.finalizeOnly) {
      if (cfg.kernelOnly && (!cfg.deferRuleProjection || preparationActive)
        && !['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw', 'pi', 'copilot', 'factory', 'opencode', 'windsurf', 'antigravity', 'muse', 'omp', 'grok-build'].includes(provider.name)) {
        const { deployWithRuleDelivery } = await import('./providers/rule-delivery.mjs');
        await deployWithRuleDelivery(opts, provider, staged => provider.deploy(staged));
      } else await provider.deploy(opts);
    }
    if (preparationActive) return;

    // User settings are outside staging: write only after a real promotion.
    if (provider.name === 'claude' && cfg.userScope && !cfg.dryRun && cfg.attribution !== false) {
      const { installAiwgHooks } = await importImpl(import.meta.url, 'extensions/claude-hooks-installer.js');
      const result = await installAiwgHooks({ projectPath: os.homedir(), frameworkRoot: srcRoot, hooks: false });
      for (const warning of result?.warnings || []) console.warn(`Claude settings: ${warning}`);
    }

    const mirroredCommandCount = mirrorSkillsAsCommands(provider, cfg.target, srcRoot, opts);
    if (mirroredCommandCount > 0 && !cfg.quiet) {
      console.log(`  Mirrored: ${mirroredCommandCount} skill command wrapper${mirroredCommandCount === 1 ? '' : 's'}`);
    }

    // Prune stale AIWG-managed agents/commands/rules whose source was renamed
    // or removed (the flat-file analogue of the skills holistic prune). #1627.
    pruneStaleAiwgArtifacts(provider, cfg.target, srcRoot, opts, cfg.source);

    if (!['claude', 'codex', 'cursor', 'hermes', 'warp', 'openclaw'].includes(provider.name) && !opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
      const behaviorDirs = collectBehaviorDirs(srcRoot);
      const behaviorCount = deployEmulatedBehaviors(behaviorDirs, provider.name, cfg.target, opts);
      if (behaviorCount > 0 && !cfg.quiet) {
        console.log(`  Deployed: ${behaviorCount} behavior emulation${behaviorCount === 1 ? '' : 's'}`);
      }
    }

    // Save model configuration if requested
    if ((cfg.save || cfg.saveUser) && !cfg.dryRun) {
      await saveModelConfig(cfg, provider.name);
    }

    if (!cfg.quiet) console.log(`\n=== Deployment complete ===\n`);
  } catch (err) {
    if (preparationActive || internal.finalizeOnly) throw err;
    console.error(`\nDeployment failed:`, err.message);
    if (cfg.dryRun) {
      console.error('(dry-run mode - no files were modified)');
    }
    return 1;
  }
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()) ?? 0; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
