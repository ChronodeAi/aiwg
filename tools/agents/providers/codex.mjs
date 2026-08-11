/**
 * OpenAI Codex Provider
 *
 * Deploys agents and commands for OpenAI Codex CLI. Commands are transformed
 * to prompts format via external script.
 *
 * Deployment paths:
 *   - Agents: <project>/.codex/agents/ (project-local)
 *   - Commands: ~/.codex/prompts/ (home directory, NOT project)
 *   - Skills: <project>/.agents/skills/ (project-local, cross-provider canonical)
 *   - Rules: <project>/.codex/rules/ (project-local, conventional)
 *
 * Skill path note (#766 regression fix):
 *   Codex (codex-rs/core-skills/src/loader.rs) scans the project-local
 *   `.agents/skills/` directory — the industry-standard, cross-provider path
 *   shared with OpenClaw, Warp, Copilot, and OpenCode. The legacy home-dir
 *   path `~/.codex/skills/` is deprecated. Earlier versions wrote BOTH, and
 *   because codex-rs scans both, every kernel skill appeared twice in the
 *   slash-command list (e.g. `/aiwg-regenerate` listed twice). We now write
 *   `.agents/skills/` only and prune the stale legacy home dir on deploy.
 *
 * Special features:
 *   - Model replacement (opus/sonnet/haiku -> gpt-5.4/gpt-5.5/gpt-5.4-mini)
 *   - --as-agents-md aggregation option
 *   - Delegates commands to deploy-prompts-codex.mjs (deploys to ~/.codex/prompts/)
 *   - Delegates skills to deploy-skills-codex.mjs (deploys to .agents/skills/)
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
const staticModelCatalog = _require('../../../agentic/code/providers/model-catalog.v1.json');
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { load as loadYaml } from 'js-yaml';
import { classifyModelRole, modelForRole } from './model-role.mjs';
import {
  ensureDir,
  listMdFiles,
  listMdFilesRecursive,
  writeFile,
  deployFiles,
  createAgentsMdFromTemplate,
  initializeFrameworkWorkspace,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonSkillDirs,
  getAddonRuleFiles,
  listSkillDirs,
  loadRuntimeModelCatalog,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  getFrameworksForMode,
  normalizeDeploymentMode,
  getRulesIndexPath,
  cleanupOldRuleFiles,
  filterCommandsAgainstSkills,
  collectFrameworkArtifacts,
  listOnDemandRuleFiles,
  writeOnDemandRuleIndex,
  deploySoulCompanions,
  parseFrontmatter,
  resolveAiwgRoot
} from './base.mjs';
const modelCatalog = loadRuntimeModelCatalog(staticModelCatalog);

// ============================================================================
// Provider Configuration
// ============================================================================

export const name = 'codex';
export const aliases = ['openai'];

export const paths = {
  agents: '.codex/agents/',
  commands: '.codex/commands/',  // Project-local mirror for conventional deployment
  // Skills sequestered under .codex/.aiwg/skills/ — index-driven discovery (#1212).
  skills: '.codex/.aiwg/skills/',
  rules: '.codex/rules/'
};

// Kernel skills (always-loaded) deploy to the project-local `.agents/skills/`
// directory — the cross-provider canonical path codex-rs natively scans. This
// is project-relative (joined with the deploy target), matching the other
// providers' kernel paths. The legacy home-dir path `~/.codex/skills/` is
// deprecated and pruned on deploy (#766 regression fix). The standard tier
// (when `--copy-all` is passed) lands alongside kernel skills; the
// deploy-skills-codex.mjs script filters non-kernel skills out by default (#1217).
export const kernelSkillsPath = '.agents/skills/';

// Legacy home-dir skills location written by AIWG versions prior to the #766
// regression fix. Pruned on every codex skill deploy so codex-rs stops listing
// each AIWG skill twice. Never touches non-AIWG (unmarked) skills.
const legacyHomeSkillsDir = path.join(os.homedir(), '.codex', 'skills');

export const support = {
  agents: 'native',
  commands: 'native',
  skills: 'native',
  rules: 'conventional'
};

export const capabilities = {
  skills: true,  // But deployed to home dir
  rules: true,
  aggregatedOutput: true,  // --as-agents-md
  yamlFormat: false
};

// ============================================================================
// Model Mapping
// ============================================================================

/**
 * Map model shorthand to OpenAI/GPT format
 */
export function mapModel(originalModel, modelCfg, modelsConfig) {
  const gptModels = {
    'opus': modelCatalog.providers.codex.roles.reasoning.id,
    'sonnet': modelCatalog.providers.codex.roles.coding.id,
    'haiku': modelCatalog.providers.codex.roles.efficiency.id
  };

  // Handle override models first
  if (modelCfg.reasoningModel || modelCfg.codingModel || modelCfg.efficiencyModel) {
    const mapped = modelForRole(originalModel, {
      reasoning: modelCfg.reasoningModel || gptModels.opus,
      coding: modelCfg.codingModel || gptModels.sonnet,
      efficiency: modelCfg.efficiencyModel || gptModels.haiku,
    }, { defaultRole: 'coding' });
    return mapped ?? originalModel;
  }

  return modelForRole(originalModel, {
    reasoning: gptModels.opus,
    coding: gptModels.sonnet,
    efficiency: gptModels.haiku,
  }, { defaultRole: 'coding' }) ?? originalModel;
}

function cleanYamlScalar(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * Render a standalone Codex custom-agent TOML file.
 *
 * Required fields follow the current Codex custom-agent contract:
 * name, description, and developer_instructions. Model controls are native
 * config.toml keys and inherit only when omitted.
 *
 * @implements #1802
 */
export function renderAgentToml(srcPath, content, models) {
  const { frontmatter, body } = parseFrontmatter(content);
  if (!frontmatter) {
    throw new Error(`Codex agent ${srcPath} is missing YAML frontmatter`);
  }
  const metadata = loadYaml(frontmatter) || {};

  const name = cleanYamlScalar(metadata.name) || path.basename(srcPath, '.md');
  const description = cleanYamlScalar(metadata.description);
  const instructions = body.trim();
  if (!description) throw new Error(`Codex agent ${srcPath} is missing description`);
  if (!instructions) throw new Error(`Codex agent ${srcPath} has no developer instructions`);

  const role = classifyModelRole(metadata.model, { defaultRole: 'coding' });
  const model = role === 'unknown' ? cleanYamlScalar(metadata.model) : models[role];
  const effortMatch = frontmatter.match(/^model-effort:\s*([^\n]+)$/m);
  const effort = effortMatch
    ? cleanYamlScalar(effortMatch[1])
    : { reasoning: 'high', coding: 'medium', efficiency: 'low' }[role];

  const lines = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(instructions)}`,
  ];
  if (model) lines.push(`model = ${tomlString(model)}`);
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Content Transformation
// ============================================================================

/**
 * Transform agent content for Codex
 */
export function transformAgent(srcPath, content, opts) {
  const { reasoningModel, codingModel, efficiencyModel } = opts;
  const catalogModels = modelCatalog.providers.codex.roles;

  const models = {
    reasoning: reasoningModel || catalogModels.reasoning.id,
    coding: codingModel || catalogModels.coding.id,
    efficiency: efficiencyModel || catalogModels.efficiency.id
  };

  return renderAgentToml(srcPath, content, models);
}

/**
 * Transform command content for Codex
 */
export function transformCommand(srcPath, content, opts) {
  return content;
}

// ============================================================================
// Deployment Functions
// ============================================================================

const CODEX_COMMAND_HELPER = path.join('tools', 'commands', 'deploy-prompts-codex.mjs');
const CODEX_SKILL_HELPER = path.join('tools', 'skills', 'deploy-skills-codex.mjs');
const DIRECT_ADDON_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODEX_MANAGED_TOML_MARKER_RE = /^# Generated by (PMOS|AIWG) for OpenAI Codex; AIWG-managed\.\r?\n/;
const LEGACY_PMOS_TOML_MARKER = '# Generated by bin/generate-codex-adapters.py; do not edit.';

function regularFileWithin(rootDir, candidatePath) {
  try {
    const root = fs.realpathSync(rootDir);
    const candidate = fs.realpathSync(candidatePath);
    const relative = path.relative(root, candidate);
    const contained = relative === '' || (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
    return contained && fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Codex deployment helper for either a full AIWG source tree or a
 * standalone project-local addon bundle.
 *
 * Project-local bundles intentionally contain only deployable artifacts, not
 * copies of AIWG's provider tooling. Prefer a bundle-local helper when one is
 * present for backwards compatibility, then fall back to the canonical helper
 * under a validated AIWG root. `resolveAiwgRoot()` accepts AIWG_ROOT only when
 * it contains the framework/addon tree, so an arbitrary environment path can
 * never become executable provider code.
 *
 * @param {string} srcRoot source tree or direct addon bundle
 * @param {string} helperRelativePath repository-relative helper path
 * @returns {string|null} canonical real path to the helper
 */
export function resolveCodexDeploymentHelper(srcRoot, helperRelativePath) {
  if (
    !helperRelativePath ||
    path.isAbsolute(helperRelativePath) ||
    String(helperRelativePath).split(/[\\/]+/).some((part) => part === '..')
  ) return null;

  const sourceRoot = path.resolve(srcRoot);
  const bundled = regularFileWithin(sourceRoot, path.join(sourceRoot, helperRelativePath));
  if (bundled) return bundled;

  const aiwgRoot = resolveAiwgRoot(sourceRoot);
  if (!aiwgRoot) return null;
  return regularFileWithin(aiwgRoot, path.join(aiwgRoot, helperRelativePath));
}

function hasDirectAddonShape(srcRoot) {
  return [
    path.join(srcRoot, 'agents'),
    path.join(srcRoot, 'commands'),
    path.join(srcRoot, 'skills'),
    path.join(srcRoot, 'rules'),
    path.join(srcRoot, 'codex', 'agents'),
  ].some((candidate) => fs.existsSync(candidate));
}

/**
 * Return the validated identity for a direct addon source, or null for an
 * ordinary AIWG/framework source tree. Direct addons fail closed when their
 * identity cannot safely become a provider artifact filename prefix.
 */
export function resolveDirectAddonId(srcRoot) {
  if (!hasDirectAddonShape(srcRoot)) return null;

  const manifestPath = path.join(srcRoot, 'manifest.json');
  let stat;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch {
    throw new Error(`Direct addon source ${srcRoot} requires manifest.json with a valid id`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !regularFileWithin(srcRoot, manifestPath)) {
    throw new Error(`Direct addon manifest must be a contained regular non-symlink file: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Direct addon manifest is not valid JSON: ${manifestPath}: ${error.message}`);
  }

  const id = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest.id
    : null;
  if (
    typeof id !== 'string' ||
    id.length > 64 ||
    !DIRECT_ADDON_ID_RE.test(id)
  ) {
    throw new Error(
      `Direct addon manifest id must be a lowercase kebab slug (max 64 chars): ${manifestPath}`
    );
  }
  return id;
}

function readTopLevelTomlString(content, key, srcPath) {
  let value = null;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (!match) continue;
    if (value !== null) {
      throw new Error(`Packaged Codex agent ${srcPath} defines ${key} more than once`);
    }
    try {
      value = JSON.parse(match[1]);
    } catch {
      throw new Error(
        `Packaged Codex agent ${srcPath} must define ${key} as a basic quoted string`
      );
    }
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Packaged Codex agent ${srcPath} requires nonempty ${key}`);
  }
  return value;
}

function validatePackagedCodexAgent(srcPath) {
  const content = fs.readFileSync(srcPath, 'utf8');
  for (const key of ['name', 'description', 'developer_instructions']) {
    readTopLevelTomlString(content, key, srcPath);
  }
}

/**
 * Discover provider-native Codex agent TOMLs shipped by a direct addon.
 * Every entry is validated before deployment so malformed or linked artifacts
 * cannot partially deploy a batch.
 */
export function listPackagedCodexAgentFiles(srcRoot, addonId) {
  if (
    typeof addonId !== 'string' ||
    addonId.length > 64 ||
    !DIRECT_ADDON_ID_RE.test(addonId)
  ) {
    throw new Error('Packaged Codex agent discovery requires a valid direct-addon id');
  }
  const agentsDir = path.join(srcRoot, 'codex', 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  const dirStat = fs.lstatSync(agentsDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Packaged Codex agents path must be a regular directory: ${agentsDir}`);
  }
  const realRoot = fs.realpathSync(srcRoot);
  const realAgentsDir = fs.realpathSync(agentsDir);
  const dirRelative = path.relative(realRoot, realAgentsDir);
  if (
    dirRelative === '..' ||
    dirRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(dirRelative)
  ) {
    throw new Error(`Packaged Codex agents path escapes the addon: ${agentsDir}`);
  }

  const escapedId = addonId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filenameRe = new RegExp(`^${escapedId}-[a-z0-9]+(?:-[a-z0-9]+)*\\.toml$`);
  const files = [];
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const srcPath = path.join(agentsDir, entry.name);
    const stat = fs.lstatSync(srcPath);
    if (
      !filenameRe.test(entry.name) ||
      entry.isSymbolicLink() ||
      stat.isSymbolicLink() ||
      !entry.isFile() ||
      !stat.isFile() ||
      !regularFileWithin(agentsDir, srcPath)
    ) {
      throw new Error(
        `Packaged Codex agent must be a contained regular non-symlink ` +
        `${addonId}-*.toml file: ${srcPath}`
      );
    }
    validatePackagedCodexAgent(srcPath);
    files.push(srcPath);
  }
  return files;
}

function directAddonDestinationGuard(addonId) {
  return ({ dest, filename, existingContent, incomingContent, sidecarEntry }) => {
    const sidecarOwned = sidecarEntry?.frameworkSlug === addonId;
    const markerMatch = existingContent.match(CODEX_MANAGED_TOML_MARKER_RE);
    const markerOwned = markerMatch?.[1] === 'AIWG' || (
      markerMatch?.[1] === 'PMOS' && addonId === 'pm-os'
    );
    const legacyMarkerPrefix = `${LEGACY_PMOS_TOML_MARKER}\n`;
    const incomingFirstLineEnd = incomingContent.indexOf('\n');
    const incomingFirstLine = incomingFirstLineEnd >= 0
      ? incomingContent.slice(0, incomingFirstLineEnd + 1)
      : incomingContent;
    const legacyPmosMigration =
      addonId === 'pm-os' &&
      /^pm-os-[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/.test(filename) &&
      existingContent.startsWith(legacyMarkerPrefix) &&
      CODEX_MANAGED_TOML_MARKER_RE.test(incomingContent) &&
      existingContent.slice(legacyMarkerPrefix.length) === incomingContent.slice(incomingFirstLine.length);
    if (sidecarOwned || markerOwned || legacyPmosMigration) return;
    throw new Error(
      `Refusing to replace unmanaged Codex agent ${filename} at ${dest}; ` +
      `only ${addonId}-owned sidecar entries or the strict AIWG-managed marker may be updated`
    );
  };
}

/**
 * Deploy agents to .codex/agents/
 */
export function deployAgents(agentFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.agents);
  ensureDir(destDir, opts.dryRun);
  return deployFiles(agentFiles, destDir, {
    ...opts,
    fileExtension: '.toml',
    injectPlatform: false,
  }, opts.packagedNativeAgents ? null : transformAgent);
}

/**
 * Deploy commands via external script
 *
 * NOTE: Codex prompts/commands go to ~/.codex/prompts/ (home directory)
 * not to the project directory. We do NOT pass --target to let the
 * script use its default home directory location.
 */
export async function deployCommands(targetDir, srcRoot, opts) {
  const scriptPath = resolveCodexDeploymentHelper(srcRoot, CODEX_COMMAND_HELPER);

  if (!scriptPath) {
    throw new Error(
      `Codex prompts deployment helper not found under source ${srcRoot} ` +
      `or a validated AIWG_ROOT`
    );
  }

  console.log('Delegating command deployment to deploy-prompts-codex.mjs (~/.codex/prompts/)...');

  return new Promise((resolve, reject) => {
    // NOTE: Do NOT pass --target - ordinary Codex prompts belong in
    // ~/.codex/prompts/ (home). Direct-addon helpers receive the project root
    // as separate routing metadata so they can intentionally own project-local
    // command surfaces without changing the canonical helper's target.
    const args = ['--source', srcRoot];
    const directAddon = resolveDirectAddonId(srcRoot) !== null;
    if (directAddon) {
      args.push('--project-root', path.resolve(targetDir));
      const aiwgRoot = resolveAiwgRoot(srcRoot);
      if (aiwgRoot) args.push('--aiwg-root', path.resolve(aiwgRoot));
    }
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.copyStandardSkills === true) args.push('--copy-all');

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: srcRoot
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deploy-prompts-codex.mjs exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

/**
 * Deploy skills via external script
 */
export async function deploySkills(targetDir, srcRoot, opts) {
  const scriptPath = resolveCodexDeploymentHelper(srcRoot, CODEX_SKILL_HELPER);

  if (!scriptPath) {
    throw new Error(
      `Codex skills deployment helper not found under source ${srcRoot} ` +
      `or a validated AIWG_ROOT`
    );
  }

  console.log('Delegating skill deployment to deploy-skills-codex.mjs...');

  // Deploy to the project-local .agents/skills/ — the SINGLE codex-scanned
  // target (industry-standard cross-provider path). Writing only here avoids
  // the duplicate slash-command bug that occurred when skills were ALSO
  // written to the legacy ~/.codex/skills/ home dir: codex-rs scans both, so
  // every kernel skill was listed twice (e.g. `/aiwg-regenerate`). See #766.
  const crossAgentSkillsDir = path.join(targetDir, '.agents', 'skills');
  console.log(`Deploying skills to ${crossAgentSkillsDir} (.agents/skills — codex-scanned path)...`);

  await new Promise((resolve, reject) => {
    const args = ['--source', srcRoot, '--target', crossAgentSkillsDir];
    const directAddon = resolveDirectAddonId(srcRoot) !== null;
    if (directAddon) {
      args.push('--project-root', path.resolve(targetDir));
      const aiwgRoot = resolveAiwgRoot(srcRoot);
      if (aiwgRoot) args.push('--aiwg-root', path.resolve(aiwgRoot));
    }
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force) args.push('--force');
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.copyStandardSkills === true) args.push('--copy-all');

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: srcRoot
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deploy-skills-codex.mjs exited with code ${code}`));
    });

    child.on('error', reject);
  });

  // Self-heal: prune AIWG-managed skill dirs left behind in the legacy
  // ~/.codex/skills/ home location by pre-fix versions, so codex-rs stops
  // listing each skill twice.
  pruneLegacyCodexSkills(opts);
}

/**
 * Remove AIWG-managed skill directories from the legacy ~/.codex/skills/ home
 * location. Earlier AIWG versions deployed kernel skills there in addition to
 * .agents/skills/; since codex-rs scans both, this produced duplicate
 * slash-command entries (#766 half-fix regression). Only directories carrying
 * the `.aiwg-managed` marker are removed — user-authored skills are never
 * touched. The now-empty legacy dir is removed if AIWG owned everything in it.
 */
export function pruneLegacyCodexSkills(opts = {}, legacyDir = legacyHomeSkillsDir) {
  let entries;
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return 0; // legacy dir absent — nothing to prune
  }

  let pruned = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(legacyDir, ent.name);
    // `aiwg-mcp` was deployed before marker files existed and its malformed
    // pre-fix SKILL.md is rejected by Codex before AIWG can self-heal. The
    // exact retired name is safe to claim; all other unmarked skills remain
    // user-owned.
    const isKnownPreMarkerLegacySkill = ent.name === 'aiwg-mcp';
    if (
      !isKnownPreMarkerLegacySkill &&
      !fs.existsSync(path.join(skillDir, '.aiwg-managed'))
    ) continue; // leave user skills alone
    if (opts.dryRun) {
      console.log(`[dry-run] would prune legacy AIWG skill ${skillDir}`);
    } else {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    pruned++;
  }

  if (pruned > 0) {
    console.log(`Pruned ${pruned} AIWG-managed skill${pruned === 1 ? '' : 's'} from legacy ~/.codex/skills/ (now deployed to .agents/skills/).`);
    if (!opts.dryRun) {
      // Remove the legacy dir only if AIWG owned everything in it.
      try {
        if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
      } catch { /* non-empty (user skills remain) — keep it */ }
    }
  }
  return pruned;
}

/**
 * Deploy rules to .codex/rules/
 */
export function deployRules(ruleFiles, targetDir, opts) {
  const destDir = path.join(targetDir, paths.rules);
  ensureDir(destDir, opts.dryRun);
  cleanupOldRuleFiles(destDir, opts);
  return deployFiles(ruleFiles, destDir, opts, transformCommand);
}

/**
 * Aggregate agents to single AGENTS.md file
 */
export function aggregateToAgentsMd(agentFiles, destPath, opts) {
  const blocks = [];
  for (const f of agentFiles) {
    let content = fs.readFileSync(f, 'utf8');
    content = transformAgent(f, content, opts);
    if (!content.endsWith('\n')) content += '\n';
    blocks.push(content);
  }
  const out = blocks.join('\n');
  if (opts.dryRun) console.log(`[dry-run] write ${destPath}`);
  else fs.writeFileSync(destPath, out, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), destPath)} with ${agentFiles.length} agents`);
}

// ============================================================================
// AGENTS.md
// ============================================================================

/**
 * Create/update AGENTS.md from Codex template
 */
export function createAgentsMd(target, srcRoot, dryRun) {
  createAgentsMdFromTemplate(target, srcRoot, 'codex/AGENTS.md.aiwg-template', dryRun);
}

// ============================================================================
// Plugin Bundle Generator
// ============================================================================

/**
 * Generate a Codex plugin bundle for AIWG SDLC.
 *
 * Creates:
 *   <targetDir>/agentic/code/plugins/sdlc/.codex-plugin/plugin.json  — Codex plugin manifest
 *   <targetDir>/.agents/plugins/marketplace.json        — Repo marketplace entry
 *
 * @param {string} targetDir - Root directory where bundle is written
 * @param {{ dryRun?: boolean, srcRoot?: string, version?: string }} opts
 */
export function generatePluginBundle(targetDir, opts = {}) {
  const { dryRun = false, srcRoot = process.cwd(), version: overrideVersion } = opts;

  // Resolve version: opts.version > package.json > 'unknown'
  let version = overrideVersion;
  if (!version) {
    try {
      const pkgPath = path.join(srcRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      // Strip pre-release suffix so it stays CalVer-compliant
      version = (pkg.version || 'unknown').replace(/-.*$/, '');
    } catch {
      version = 'unknown';
    }
  }

  // ---- plugin.json --------------------------------------------------------
  const pluginManifest = {
    name: 'aiwg-sdlc',
    version,
    description:
      'Complete Software Development Lifecycle framework with 180+ specialized agents for requirements, architecture, security, testing, and deployment.',
    author: 'AIWG',
    homepage: 'https://aiwg.io',
    repository: 'https://github.com/jmagly/aiwg',
    license: 'MIT',
    skills: './skills/',
    keywords: ['sdlc', 'aiwg', 'agents', 'architecture', 'security', 'testing', 'deployment']
  };

  const pluginJsonDir = path.join(targetDir, 'agentic', 'code', 'plugins', 'sdlc', '.codex-plugin');
  const pluginJsonPath = path.join(pluginJsonDir, 'plugin.json');

  if (dryRun) {
    console.log(`[dry-run] would write ${pluginJsonPath}`);
  } else {
    fs.mkdirSync(pluginJsonDir, { recursive: true });
    fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginManifest, null, 2) + '\n', 'utf8');
  }

  // ---- marketplace.json ---------------------------------------------------
  const marketplace = {
    name: 'aiwg-local',
    interface: {
      displayName: 'AIWG Plugins'
    },
    plugins: [
      {
        name: 'aiwg-sdlc',
        source: {
          path: './agentic/code/plugins/sdlc',
          source: 'local'
        },
        policy: {
          installation: 'AVAILABLE'
        },
        category: 'Development'
      }
    ]
  };

  const marketplaceDir = path.join(targetDir, '.agents', 'plugins');
  const marketplacePath = path.join(marketplaceDir, 'marketplace.json');

  if (dryRun) {
    console.log(`[dry-run] would write ${marketplacePath}`);
  } else {
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf8');
  }
}

// ============================================================================
// Post-Deployment
// ============================================================================

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);

  if (opts.createAgentsMd) {
    createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
}

// ============================================================================
// File Extension
// ============================================================================

export function getFileExtension(type) {
  return '.md';
}

// ============================================================================
// Main Deploy Function
// ============================================================================

/**
 * Main deployment function for Codex provider
 */
export async function deploy(opts) {
  const {
    srcRoot,
    target,
    mode,
    deployCommands: shouldDeployCommands,
    deploySkills: shouldDeploySkills,
    deployRules: shouldDeployRules,
    commandsOnly,
    skillsOnly,
    rulesOnly,
    dryRun,
    asAgentsMd,
    asPlugin,
    createAgentsMd: shouldCreateAgentsMd
  } = opts;

  console.log(`\n=== OpenAI Codex Provider ===`);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${mode}`);

  // Collect source files based on mode
  const agentFiles = [];
  const ruleFiles = [];
  const normalizedMode = normalizeDeploymentMode(mode);

  // Check for addon-style directory structure (direct agents/ and rules/
  // subdirs). Handles deployment when --source points at a project-local
  // bundle (.aiwg/extensions/<name>/) rather than $AIWG_ROOT. Mirrors the
  // reference implementation in claude.mjs (#124). Commands and skills are
  // resolved from srcRoot inside deployCommands/deploySkills, so only agents
  // and rules need the explicit short-circuit here.
  const directAddonId = resolveDirectAddonId(srcRoot);
  const isAddonSource = directAddonId !== null;
  let packagedNativeAgents = false;

  if (isAddonSource) {
    const packagedAgents = listPackagedCodexAgentFiles(srcRoot, directAddonId);
    const addonAgentsDir = path.join(srcRoot, 'agents');
    if (packagedAgents.length > 0) {
      agentFiles.push(...packagedAgents);
      packagedNativeAgents = true;
    } else if (fs.existsSync(addonAgentsDir)) {
      agentFiles.push(...listMdFiles(addonAgentsDir));
    }

    if (shouldDeployRules || rulesOnly) {
      const addonRulesDir = path.join(srcRoot, 'rules');
      if (fs.existsSync(addonRulesDir)) {
        ruleFiles.push(...listMdFiles(addonRulesDir));
      }
    }
  }

  // Frameworks discovered from manifests/directory structure
  const frameworks = getFrameworksForMode(srcRoot, normalizedMode);
  for (const framework of frameworks) {
    if (framework.components.agents.exists) {
      agentFiles.push(...listMdFiles(framework.components.agents.path));
    }

    if (framework.id === 'sdlc-complete' && framework.components.rules.exists) {
      // Use consolidated RULES-INDEX.md for SDLC rules when available.
      const indexPath = getRulesIndexPath(srcRoot);
      if (indexPath) {
        ruleFiles.push(indexPath);
        continue;
      }
    }

    if (framework.components.rules.exists) {
      ruleFiles.push(...listMdFiles(framework.components.rules.path));
    }
  }

  // All addons (dynamically discovered)
  if (normalizedMode === 'general' || normalizedMode === 'sdlc' || normalizedMode === 'both' || normalizedMode === 'all') {
    agentFiles.push(...getAddonAgentFiles(srcRoot));
    ruleFiles.push(...getAddonRuleFiles(srcRoot));
  }

  // Collect soul companion files
  const soulArtifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
    includeAgents: false,
    includeCommands: false,
    includeSkills: false,
    includeRules: false
  });
  const soulFiles = [...(soulArtifacts.souls || [])];

  // Deploy based on flags
  if (!commandsOnly && !skillsOnly && !rulesOnly) {
    if (asAgentsMd) {
      // Aggregate to single AGENTS.md
      const destPath = path.join(target, 'AGENTS.md');
      console.log(`\nAggregating ${agentFiles.length} agents to AGENTS.md...`);
      aggregateToAgentsMd(agentFiles, destPath, opts);
    } else {
      console.log(`\nDeploying ${agentFiles.length} agents...`);
      const directAddonAgentOpts = directAddonId
        ? {
            filenamePrefix: `${directAddonId}-`,
            artifactOwner: directAddonId,
            existingDestinationGuard: directAddonDestinationGuard(directAddonId),
            packagedNativeAgents,
          }
        : {};
      deployAgents(agentFiles, target, { ...opts, ...directAddonAgentOpts });
    }

    // Deploy soul companion files alongside agents
    if (soulFiles.length > 0) {
      const destDir = path.join(target, paths.agents);
      ensureDir(destDir, opts.dryRun);
      console.log(`\nDeploying ${soulFiles.length} soul files...`);
      deploySoulCompanions(soulFiles, destDir, opts);
    }
  }

  if (shouldDeployCommands || commandsOnly) {
    console.log(`\nDeploying commands...`);
    await deployCommands(target, srcRoot, opts);
  }

  if (shouldDeploySkills || skillsOnly) {
    console.log(`\nDeploying skills to .agents/skills/...`);
    await deploySkills(target, srcRoot, opts);
  }

  if (shouldDeployRules || rulesOnly) {
    console.log(`\nDeploying ${ruleFiles.length} rules...`);
    deployRules(ruleFiles, target, opts);

    // On-demand index (#1675): list the MEDIUM/LOW rules tier-gated out of the
    // always-on set so agents can fetch them via `aiwg show rule`.
    const onDemandCount = writeOnDemandRuleIndex(
      path.join(target, paths.rules),
      listOnDemandRuleFiles(srcRoot),
      opts,
    );
    if (onDemandCount > 0) {
      console.log(`  On-demand rules (not inlined): ${onDemandCount} → RULES-ONDEMAND.md`);
    }
  }

  // Post-deployment
  await postDeploy(target, { ...opts, createAgentsMd: shouldCreateAgentsMd });

  // Plugin bundle (opt-in via --as-plugin)
  if (asPlugin) {
    console.log('\nGenerating Codex plugin bundle...');
    generatePluginBundle(target, { dryRun, srcRoot });
  }

  console.log('\n=== Codex deployment complete ===\n');
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  support,
  capabilities,
  transformAgent,
  transformCommand,
  mapModel,
  resolveCodexDeploymentHelper,
  deployAgents,
  deployCommands,
  deploySkills,
  deployRules,
  aggregateToAgentsMd,
  createAgentsMd,
  postDeploy,
  getFileExtension,
  generatePluginBundle,
  deploy
};
