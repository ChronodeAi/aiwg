import { importImpl } from '../../_resolve-impl.mjs';
/**
 * Hermes Agent Provider
 *
 * Hermes Agent uses file-based deployment for context and skills. AIWG's MCP
 * server is an optional enrichment hook that Hermes can call when configured.
 *
 * What this provider DOES deploy:
 *   - Skills: $HERMES_HOME/skills/ (user-global, for agentic skills callable by Hermes)
 *   - AGENTS.md: project root (full AIWG routing guide referenced by .hermes.md)
 *
 * What this provider SKIPS:
 *   - Commands: Hermes has no AIWG slash-command file surface
 *   - Rules: .hermes/rules holds complete kernels and indexes, reached by startup hooks
 *
 * See: docs/integrations/hermes-quickstart.md
 */

import realFs from 'fs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import os from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  withRuleDeployment,
  ensureDir,
  listMdFiles,
  deploySkillDir,
  deploySkillsWithKernelRouting,
  isKernelSkill,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  deployFiles,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  collectFrameworkArtifacts,
  stripPlatformsFromContent,
} from './base.mjs';

import { assertContextBudget, generateAgentsMd, generateHermesMd } from './hermes-startup.mjs';
export { assertContextBudget, generateAgentsMd, generateHermesMd };
import { createHermesSkillLifecycle } from './hermes-skill-lifecycle.mjs';

// ============================================================================
// Hermes home resolution (HERMES_HOME) — #2119
// ============================================================================
//
// Mirrors `hermes_constants.get_hermes_home()` in the Hermes Agent runtime.
// Resolution order (upstream, hermes_constants.py:114-):
//   1. A context-local override installed in-process via
//      set_hermes_home_override() — AIWG runs in a separate node process and
//      cannot observe that token, so step 1 is intentionally NOT part of the
//      cross-process contract.
//   2. The process `HERMES_HOME` env var.
//   3. The platform-native default:
//        win32 → %LOCALAPPDATA%/hermes   (falls back to %USERPROFILE%/AppData/
//                  Local/hermes when LOCALAPPDATA is unset)
//        other → $HOME/.hermes
//
// AIWG reads the env var when `getHermesHome()` is invoked; the module-level
// constants below lock in the value captured at first use so every consumer
// (paths, kernels, orchestrate, legacy migration) sees the same resolved root
// for the life of the process.

/**
 * Resolve the Hermes home directory.
 *
 * Honors HERMES_HOME the way the running Hermes runtime does, so that
 * `aiwg use --provider hermes` writes skills under the same root the live
 * session scans. See #2119 — before this helper, the provider hardcoded
 * `os.homedir()/.hermes` and any operator running Hermes under a non-default
 * HERMES_HOME (multi-profile, hermes-role wrappers, dev containers) got a
 * silently divergent deployment.
 */
export function getHermesHome() {
  const env = (process.env.HERMES_HOME || '').trim();
  if (env) {
    // Match upstream's Path(env) contract exactly. Hermes does not expand a
    // leading `~` or resolve relative values here; both remain relative to the
    // process working directory when the path is consumed.
    return env;
  }
  if (process.platform === 'win32') {
    const localAppData = (process.env.LOCALAPPDATA || '').trim();
    return localAppData
      ? path.join(localAppData, 'hermes')
      : path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

// The value captured below is the target any running Hermes session with the
// same environ would use as its scan root.
const HERMES_HOME = getHermesHome();

// ============================================================================
// Provider Configuration
// ============================================================================

export const name = 'hermes';
export const aliases = [];

export const paths = {
  agents: 'AGENTS.md',                           // Aggregated routing guide at project root
  commands: '',                                   // Not applicable — no AIWG slash-command file surface
  // Standard skills under <HERMES_HOME>/skills/.aiwg/ — child of Hermes's
  // scanned root, recursively discovered (verified `agent/skill_utils.py:478-489`,
  // os.walk follows subdirs except .git/.github/.hub/.archive).
  //
  // HERMES_HOME honors the process env var and falls back to $HOME/.hermes
  // (win32: %LOCALAPPDATA%/hermes), matching hermes_constants.get_hermes_home().
  // #2119: previously hardcoded os.homedir() — wrong for any operator running
  // Hermes under a non-default HERMES_HOME (multi-profile, hermes-role, etc.).
  skills: path.resolve(HERMES_HOME, 'skills', '.aiwg'),
  rules: '.hermes/rules',                                      // Complete files reached through the startup hook
};

// Kernel skills (always-loaded) deploy to the platform-native dir.
// Standard skills land in the .aiwg/ subdirectory under the same root —
// Hermes recursively walks the skill root (verified against upstream v0.13.0,
// `agent/skill_utils.py:478-489`).
export const kernelSkillsPath = path.resolve(HERMES_HOME, 'skills');

// Resolved home directory this provider's paths were computed against.
// Consumers (deploy verification, doctor, status) should use this rather than
// re-reading os.homedir() to stay consistent with the deploy target.
export const hermesHome = HERMES_HOME;
export const { updateBundledManifest, migrateLegacySkillPath } = createHermesSkillLifecycle({ getHermesHome, paths, kernelSkillsPath });

export const support = {
  agents: 'aggregated',      // Agents aggregated into lean AGENTS.md
  commands: 'indexed',       // Full command bodies via aiwg discover/show; no native file loader
  skills: 'native',          // $HERMES_HOME/skills/ is the native skill location
  rules: 'prose-hook',      // RULES-INDEX and complete local kernel files
};

export const capabilities = {
  skills: true,
  rules: false,
  aggregatedOutput: true,
  yamlFormat: false,
  homeDirectoryDeploy: true,  // Skills deploy to home dir
};

/**
 * Project portable Agent Skills metadata into Hermes's native frontmatter.
 *
 * The portable Agent Skills contract restricts `metadata` values to strings,
 * while Hermes expects tags at `metadata.hermes.tags`. AIWG stores the tag
 * list as a comma-separated `metadata.hermes-tags` string in source and
 * performs the provider-specific projection only in the deployed copy.
 */
export function transformHermesSkillContent(content) {
  const stripped = stripPlatformsFromContent(content);
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return stripped;

  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    return stripped;
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return stripped;
  }

  const metadata = frontmatter.metadata;
  const encodedTags = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata['hermes-tags']
    : undefined;
  if (typeof encodedTags !== 'string') return stripped;

  const tags = encodedTags.split(',').map((tag) => tag.trim()).filter(Boolean);
  delete metadata['hermes-tags'];
  metadata.hermes = { tags };

  const body = stripped.slice(match[0].length);
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body}`;
}

// ============================================================================
// Model Mapping (not applicable — Hermes uses local Ollama models)
// ============================================================================

export function mapModel(shorthand, modelCfg, modelsConfig) {
  return shorthand;
}

// ============================================================================
// AGENTS.md Generation
// ============================================================================

// ============================================================================
// Skills Deployment
// ============================================================================

/**
 * Deploy skills with kernel-vs-standard routing (#1212/#1216).
 *
 * Skills are user-global in Hermes, deployed once, available in all
 * projects. Kernel routing per the cross-provider pattern:
 *   - kernel skills → $HERMES_HOME/skills/         (platform-native, always-loaded)
 *   - standard      → $HERMES_HOME/skills/.aiwg/   (recursively walked by Hermes)
 */
export function deploySkills(skillDirs, opts) {
  const standardDestDir = paths.skills;
  const kernelDestDir = opts.kernelSkillsPath || kernelSkillsPath;

  if (!opts.dryRun) {
    console.log(`  Deploying ${skillDirs.length} skills (kernel + standard split)...`);
  }

  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, opts);
}

// ============================================================================
// Main Deploy Function
// ============================================================================

export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath, assertContextBudget }, deploySelected);
}

async function deploySelected(opts) {
  const {
    srcRoot,
    target,
    mode,
    deploySkills: shouldDeploySkills,
    skillsOnly,
    dryRun,
  } = opts;

  const normalizedMode = normalizeDeploymentMode(mode);

  if (!opts.quiet) {
    console.log(`\n=== Hermes Agent Provider ===`);
    console.log(`Target: ${target}`);
    console.log(`Skills: ${paths.skills}`);
    console.log(`Mode: ${mode}`);
    console.log(`Architecture: Hermes → MCP → AIWG`);
    console.log('');
  }

  // ── Legacy skill path migration (#1316 / S5) ───────────────────────────────
  // Earlier AIWG versions deployed standard skills to ~/.hermes/.aiwg/skills/
  // (sibling of Hermes's scanned root — invisible to Hermes). #1314 moved
  // them to ~/.hermes/skills/.aiwg/ (recursively scanned). This helper
  // detects the legacy path and removes it after the new path is populated,
  // preventing operator confusion and curator-bait.
  if (!skillsOnly || shouldDeploySkills) {
    migrateLegacySkillPath(opts);
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  if ((shouldDeploySkills || skillsOnly) && !opts.commandsOnly && !opts.rulesOnly) {
    const allSkillDirs = [];

    // Addon skills, including a direct addon source (#2873, #3035).
    allSkillDirs.push(...getAddonSkillDirs(srcRoot));

    // Framework skills
    const artifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    allSkillDirs.push(...(artifacts.skills || []));

    if (allSkillDirs.length > 0) {
      // Hermes's skill loader reads `platforms:` as an OS gate
      // (linux / macos / windows). AIWG's shared deploy path injects
      // `[hermes]` into that field, which then filters every skill out
      // on Linux. Strip the field post-injection — hermes documents
      // "absent field = all platforms" as its default. This leaves the
      // other providers' `transformSkillMd` pipeline untouched.
      const skillOpts = {
        ...opts,
        provider: 'hermes', // ensure deploySkillDir's injectPlatform branch runs
        transformSkillMd: transformHermesSkillContent,
      };
      deploySkills(allSkillDirs, skillOpts);
    } else if (!opts.quiet) {
      console.log('  No skills found to deploy');
    }

    // Holistic post-deploy cleanup of stale AIWG-managed kernel skills.
    // Uses the global kernel set (walks all source frameworks/addons),
    // not just this-call's skillDirs, because aiwg use invokes
    // deploy-agents.mjs multiple times. Hermes augments the canonical
    // set with `aiwg-orchestrate` (#1242) — the orchestrate skill is a
    // template-driven convenience install (not part of any framework's
    // skills/), so without this exemption the prune would delete it
    // every time it's auto-installed.
    // `computeAllKernelNames` returns null when no AIWG framework/addon tree
    // can be located (e.g. project-local bundle deploy without AIWG_ROOT).
    // Skip both the prune and the manifest update in that case rather than
    // operate on an empty desired set (#123).
    const kernelNames = computeAllKernelNames(srcRoot);
    if (kernelNames != null) {
      const desiredKernel = [...kernelNames, 'aiwg-orchestrate'];
      pruneStaleAiwgSkills(opts.kernelSkillsPath || kernelSkillsPath, desiredKernel, opts);

      // Register kernel skills in Hermes's bundled manifest so the Curator
      // (v0.12.0+, 7-day archival cycle) does not archive them. Standard
      // skills under `.aiwg/` are already protected by the dot-prefix rule
      // in tools/skill_usage.py:241-243. (#1317 / S6)
      updateBundledManifest(desiredKernel, opts);
    }
  }

  // ── AGENTS.md + .hermes.md ─────────────────────────────────────────────────
  // Generate the legacy scaffold; activation projection replaces it with the minimal hook.
  // AND .hermes.md thin pointer (resolves #1319 doc-debt, was claimed in
  // CHANGELOG but not previously implemented).
  if (opts.contextFiles !== false && !skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
    const artifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: true,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    const agentCount = (artifacts.agents || []).length;
    const skillCount = (artifacts.skills || []).length;
    generateAgentsMd(agentCount, skillCount, target, opts);
    generateHermesMd(target, opts);
  }

  // ── aiwg-orchestrate convenience skill (#1242) ──────────────────────────────
  // First-deploy-only copy: lays down the delegate_task wrapper at
  // $HERMES_HOME/skills/aiwg-orchestrate/SKILL.md if it isn't already present.
  // The skill provides ~95% per-workflow context reduction by routing AIWG
  // calls through Hermes's `delegate_task` instead of inline MCP. Idempotent
  // on re-run — operator edits are preserved across `aiwg use` invocations.
  if (!skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
    deployAiwgOrchestrateSkill(srcRoot, opts);
  }

  // ── Post-deployment hint ───────────────────────────────────────────────────
  if (!opts.quiet) {
    console.log('');
    console.log(`Skills root: ${kernelSkillsPath}`);
    console.log('Rules are in .hermes/rules; read RULES-INDEX.md and every listed kernel file before task work.');
    console.log('Optional: configure config.yaml to connect AIWG MCP server.');
    console.log('See: docs/integrations/hermes-quickstart.md (optional MCP setup)');
  }

  // ── Consumer visibility check (#2119) ──────────────────────────────────────
  // The running Hermes runtime reads skills from get_skills_dir(), which is
  // HERMES_HOME/skills (hermes_constants.get_hermes_home: context-local
  // override → HERMES_HOME env → $HOME/.hermes). AIWG can observe only ITS
  // own process environment, so this check reports which root AIWG resolved
  // and warns when that root may be invisible to a Hermes session the
  // operator launched elsewhere (custom HERMES_HOME, hermes-role wrapper).
  //
  // Before #2119 this was a silent failure: AIWG wrote to $HOME/.hermes/skills
  // unconditionally and `aiwg status --probe` reported healthy even when the
  // live session scanned a different HERMES_HOME.
  if (!dryRun && !opts.quiet) {
    const envHome = (process.env.HERMES_HOME || '').trim();
    const hermesActive = Boolean(
      process.env.HERMES_SESSION_ID ||
      (process.env.AI_AGENT || '').includes('hermes')
    );
    if (hermesActive && !envHome) {
      console.warn(`Warning: HERMES_HOME is not set in this AIWG process — deployed skills landed under \`${kernelSkillsPath}\` (default $HOME/.hermes).`);
      console.warn('  If your running Hermes session uses a non-default HERMES_HOME, it CANNOT see these skills.');
      console.warn('  Re-run with the matching value: HERMES_HOME=<that value> aiwg use --provider hermes');
    }
  }
}

// ============================================================================
// Curator protection (#1317 / S6)
// ============================================================================

// ============================================================================
// aiwg-orchestrate auto-install (#1242)
// ============================================================================

/**
 * Copy the aiwg-orchestrate skill template to $HERMES_HOME/skills/ on first
 * deploy. Skip if a SKILL.md already exists — preserves operator edits and
 * any prior version they're running. Errors during the copy are non-fatal:
 * the rest of the deploy must succeed even if the home dir is read-only or
 * the template is missing in this checkout.
 */
function deployAiwgOrchestrateSkill(srcRoot, opts) {
  const templatePath = path.join(
    srcRoot,
    'agentic',
    'code',
    'frameworks',
    'sdlc-complete',
    'templates',
    'hermes',
    'skills',
    'aiwg-orchestrate',
    'SKILL.md',
  );

  if (!fs.existsSync(templatePath)) {
    if (!opts.quiet) {
      console.log('  aiwg-orchestrate template not present in this build — skipping auto-install');
    }
    return;
  }

  const destDir = path.join(opts.kernelSkillsPath || kernelSkillsPath, 'aiwg-orchestrate');
  const destPath = path.join(destDir, 'SKILL.md');

  if (fs.existsSync(destPath)) {
    if (!opts.quiet) {
      console.log(`  aiwg-orchestrate already present at ${destPath} — operator copy preserved`);
    }
    return;
  }

  if (opts.dryRun) {
    if (!opts.quiet) {
      console.log(`  [dry-run] Would install aiwg-orchestrate to ${destPath}`);
    }
    return;
  }

  try {
    ensureDir(destDir);
    const content = fs.readFileSync(templatePath, 'utf8');
    // Defensive: the template is hermes-specific and should not carry a
    // `platforms:` field (hermes reads that as an OS gate). Strip it if a
    // future template regression reintroduces one so this orphan path
    // stays consistent with the main deploy pipeline.
    fs.writeFileSync(destPath, transformHermesSkillContent(content), 'utf8');
    if (!opts.quiet) {
      console.log(`  Installed aiwg-orchestrate to ${destPath} (delegate_task wrapper, 95% context reduction)`);
    }
  } catch (err) {
    if (!opts.quiet) {
      console.log(`  aiwg-orchestrate auto-install skipped: ${err.message}`);
    }
  }
}

// ============================================================================
// File Extension
// ============================================================================

export function getFileExtension(type) {
  return '.md';
}

// ============================================================================
// Content Transformation (passthrough for Hermes — skills use their own format)
// ============================================================================

export function transformAgent(srcPath, content, opts) {
  return content;
}

export function transformCommand(srcPath, content, opts) {
  return content;
}
