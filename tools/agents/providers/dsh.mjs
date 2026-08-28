/**
 * DeepSeek Harness Provider
 *
 * DeepSeek Harness (github.com/deepseek-ai/deepseek-harness) is a plugin-based
 * agent harness on the Cordis kernel ("everything is a plugin", developer
 * preview). Its skill-filesystem provider natively scans project
 * `.agents/skills/` and user `$DSH_AGENTS_HOME|~/.agents/skills/` for SKILL.md
 * directory bundles, and loads workspace `AGENTS.md` prose into the system
 * prompt. AIWG deploys exactly those surfaces — no adapter layer required.
 *
 * What this provider DOES deploy (project scope):
 *   - Kernel skills:  .agents/skills/    (canonical always-loaded inventory)
 *   - Standard skills: .dsh/.aiwg/skills/ (bulk framework/addon payload;
 *     index-discoverable via aiwg discover/show but NOT flat-scanned by DSH,
 *     mirroring Codex's kernel pivot #1217 so session catalogs stay lean)
 *   - Agent presets: ($DSH_HOME|~/.dsh)/.agent-presets/<id>/ — DSH's named-agent
 *     compositions (packages/preset/agent-presets: agent.cordis.yml + preset.yml).
 *     Session-scoped; delegated children join the parent's preset (#1707).
 *   - AGENTS.md: managed AIWG section via BEGIN/END markers; operator content
 *     outside the markers is preserved (#1571)
 *
 * What this provider SKIPS:
 *   - Agent markdown dirs: DSH has no .md agent-file surface; personas ship as
 *     agent presets above and per-child persona shadowing (ChildComposition)
 *   - Commands: no separate command surface; user-invocable skills serve as commands
 *   - Rules: context is AGENTS.md prose; full bodies via `aiwg show rule <name>`
 *
 * See: docs/agents/providers/deepseek-harness.md
 */

import os from 'os';
import realFs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const _require = createRequire(import.meta.url);
let fs;
try { const gfs = _require('graceful-fs'); gfs.gracefulify(realFs); fs = realFs; } catch { fs = realFs; }
import path from 'path';
import {
  ensureDir,
  normalizeDeploymentMode,
  collectFrameworkArtifacts,
  getAddonSkillDirs,
  deploySkillsWithKernelRouting,
  pruneStaleAiwgSkills,
  computeAllKernelNames,
  createManagedMdFromTemplate,
} from './base.mjs';

// ============================================================================
// Provider Configuration
// ============================================================================

export const name = 'dsh';
export const aliases = [];

export const paths = {
  agents: 'AGENTS.md',                            // Managed AIWG section at project root
  commands: '',                                   // Not applicable — no separate command surface
  // Standard (bulk) skills under .dsh/.aiwg/skills/. The `.dsh/` root is DSH's
  // own project config namespace; only `.dsh/skills/` (not `.dsh/.aiwg/skills/`)
  // is scanned by its skill provider, so this payload stays index-only.
  skills: '.dsh/.aiwg/skills',
  rules: '',                                      // Inlined into AGENTS.md + reachable via `aiwg show rule`
};

// Kernel skills (always-loaded) deploy to DSH's canonical project scan root.
export const kernelSkillsPath = null; // Resolved per-target in deploy(): path.join(target, '.agents/skills')

// Resolved home directory this provider's paths were computed against, when
// home-relative (user scope). Project scope resolves against the target.
export const support = {
  agents: 'aggregated',      // Agents routed through the managed AGENTS.md section
  commands: 'none',          // No AIWG slash-command file surface
  skills: 'native',          // .agents/skills/ is the native project skill location
  rules: 'agents-md+cli',    // compressed in AGENTS.md; full bodies via CLI/MCP
};

export const capabilities = {
  skills: true,
  rules: false,
  aggregatedOutput: false,
  yamlFormat: false,
  homeDirectoryDeploy: false, // Project-scope deploy; --scope user mirrors kernel skills to ~/.agents/skills/
};

// ============================================================================
// Model Mapping
// ============================================================================

/** DSH models resolve through cordis.yml llm plugins; shorthands pass through. */
export function mapModel(shorthand, modelCfg, modelsConfig) {
  return shorthand;
}

// ============================================================================
// AGENTS.md Generation
// ============================================================================

/**
 * Create or update the managed AIWG section in the project's AGENTS.md.
 *
 * DeepSeek Harness loads AGENTS.md verbatim, and projects frequently carry
 * hand-maintained instruction files there (the deepseek-harness repo itself
 * does). The managed-block writer preserves everything outside the
 * BEGIN/END markers and updates the AIWG section in place on redeploy.
 */
export function generateAgentsMd(agentCount, skillCount, targetDir, opts) {
  const { dryRun } = opts;
  createManagedMdFromTemplate(targetDir, 'AGENTS.md', opts.srcRoot, 'dsh/AGENTS.md.aiwg-template', dryRun, {
    sectionMarker: '<!-- AIWG SDLC Framework Integration -->',
    legacyHeading: '## AIWG SDLC Framework',
  });
  return 1;
}

// ============================================================================
// Skills Deployment
// ============================================================================

/**
 * Deploy skills with kernel-vs-standard routing:
 *   - kernel skills  → <target>/.agents/skills/    (natively scanned by DSH)
 *   - standard       → <target>/.dsh/.aiwg/skills/ (index-discoverable only)
 */
export function deploySkills(skillDirs, opts) {
  const standardDestDir = path.isAbsolute(paths.skills)
    ? paths.skills
    : path.join(opts.target || process.cwd(), paths.skills);
  const kernelDestDir = path.join(opts.target || process.cwd(), '.agents', 'skills');

  if (!opts.dryRun) {
    console.log(`  Deploying ${skillDirs.length} skills (kernel + standard split)...`);
  }

  deploySkillsWithKernelRouting(skillDirs, standardDestDir, kernelDestDir, opts);
}

// ============================================================================
// Agent Presets Deployment
// ============================================================================

/**
 * Resolve the DeepSeek Harness harness home exactly as
 * `packages/skill/skill-filesystem` and `packages/preset/agent-presets` do:
 * `$DSH_HOME`, defaulting to `~/.dsh`. Mirrors src/providers/dsh-home.ts
 * (resolveDshHarnessHome) — keep the two in sync.
 */
function resolveDshHarnessHome() {
  const configured = (process.env.DSH_HOME || '').trim();
  if (configured) return path.resolve(configured);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.dsh');
}

/** Corpus source dir holding preset directories (agent.cordis.yml + preset.yml). */
export const agentPresetsSourceDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'dsh', 'agent-presets'
);

/** DSH's user-level preset root (dsh-agent-presets USER_PRESET_DIR). */
export function dshAgentPresetsRoot() {
  return path.join(resolveDshHarnessHome(), '.agent-presets');
}

/**
 * `all`-mode runs invoke deploy() once per framework pass; presets are
 * harness-home artifacts, so deploy them once per process (idempotent either
 * way — this only avoids redundant copies).
 */
let presetsDeployedThisProcess = false;

/**
 * Deploy AIWG agent presets into DSH's user preset root. Discovery in
 * dsh-agent-presets re-reads roots on every call, so deployed presets are
 * visible to running and new sessions without a restart. Corpus copies win on
 * redeploy (they are the source of truth); operator-authored presets with
 * other ids are untouched.
 *
 * @returns {number} presets deployed (or that would deploy, in dry-run)
 */
export function deployAgentPresets(opts) {
  const { dryRun } = opts;
  const sourceRoot = opts.presetSourceDir || agentPresetsSourceDir;
  let sourceDirs = [];
  try {
    sourceDirs = fs.readdirSync(sourceRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return 0; // no presets shipped for this provider build
  }
  if (sourceDirs.length === 0) return 0;

  const destRoot = opts.presetDestRoot || dshAgentPresetsRoot();
  if (!dryRun && !opts.quiet) {
    console.log(`  Deploying ${sourceDirs.length} agent presets to ${destRoot}...`);
  }
  let deployed = 0;
  for (const id of sourceDirs) {
    const srcDir = path.join(sourceRoot, id);
    const destDir = path.join(destRoot, id);
    const files = ['agent.cordis.yml', 'preset.yml'].filter(f =>
      fs.existsSync(path.join(srcDir, f))
    );
    if (files.length === 0) continue;
    if (!dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of files) {
        // Write-then-rename so a crash mid-copy never leaves a truncated
        // composition behind (DSH discovery would surface it as a broken
        // roster row until the next deploy heals it).
        const tmpFile = path.join(destDir, `.${f}.aiwg-tmp`);
        fs.copyFileSync(path.join(srcDir, f), tmpFile);
        fs.renameSync(tmpFile, path.join(destDir, f));
      }
    } else if (!opts.quiet) {
      console.log(`  [dry-run] deploy preset ${id} -> ${destDir}`);
    }
    deployed++;
  }
  return deployed;
}

// ============================================================================
// Main Deploy Function
// ============================================================================

export async function deploy(opts) {
  const {
    srcRoot,
    target,
    mode,
    deploySkills: shouldDeploySkills,
    skillsOnly,
    dryRun,
    createAgentsMd: shouldCreateAgentsMd,
  } = opts;

  const normalizedMode = normalizeDeploymentMode(mode);

  if (!opts.quiet) {
    console.log(`\n=== DeepSeek Harness Provider ===`);
    console.log(`Target: ${target}`);
    console.log(`Kernel skills: ${path.join(target, '.agents', 'skills')}`);
    console.log(`Standard skills: ${path.join(target, '.dsh', '.aiwg', 'skills')}`);
    console.log(`Mode: ${mode}`);
    console.log(`Architecture: DSH → skill catalog / CLI → AIWG`);
    console.log('');
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  if ((shouldDeploySkills || skillsOnly) && !opts.commandsOnly && !opts.rulesOnly) {
    const allSkillDirs = [];

    // Addon skills when deploying everything
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
      const skillOpts = {
        ...opts,
        provider: name, // ensure deploySkillDir's injectPlatform branch runs
        target,
      };
      deploySkills(allSkillDirs, skillOpts);

      // Prune stale AIWG-managed kernel skills from the scanned root.
      // computeAllKernelNames returns null without a locatable AIWG tree
      // (e.g. project-local bundle deploys) — skip rather than operate on
      // an empty desired set.
      const kernelNames = computeAllKernelNames(srcRoot);
      if (kernelNames != null) {
        pruneStaleAiwgSkills(path.join(target, '.agents', 'skills'), [...kernelNames], opts);
      }
    } else if (!opts.quiet) {
      console.log('  No skills found to deploy');
    }
  }

  // ── Agent presets (DSH named-agent compositions, user root) ───────────────
  // Presets are harness-home artifacts every DSH session can pick, so they are
  // independent of project scope — but they ship from THIS provider's install
  // root only. `all`-mode re-invokes this deployer once per framework/addon/
  // extension pass with a different --source; the install-root check keeps
  // presets to the main pass (the memo covers any remaining second main pass).
  let presetCount = 0;
  const isInstallRootPass = Boolean(
    opts.srcRoot && fs.existsSync(path.join(opts.srcRoot, 'tools', 'agents', 'providers', 'dsh', 'agent-presets'))
  );
  if (!opts.commandsOnly && !opts.rulesOnly && isInstallRootPass && !presetsDeployedThisProcess) {
    presetCount = deployAgentPresets(opts);
    presetsDeployedThisProcess = true;
  }

  // ── AGENTS.md managed section (opt-in, mirroring codex --create-agents-md) ─
  // DSH projects frequently carry hand-maintained AGENTS.md files; never touch
  // one unless the operator asked. `aiwg-regenerate` is the other entry point.
  if (shouldCreateAgentsMd && !skillsOnly && !opts.commandsOnly && !opts.rulesOnly) {
    const artifacts = collectFrameworkArtifacts(srcRoot, normalizedMode, {
      includeAgents: true,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    });
    const agentCount = (artifacts.agents || []).length;
    const skillCount = (artifacts.skills || []).length;
    generateAgentsMd(agentCount, skillCount, target, { ...opts, srcRoot });
  }

  // ── Post-deployment hint ───────────────────────────────────────────────────
  if (!opts.quiet) {
    console.log('');
    console.log(`Kernel skills root: ${path.join(target, '.agents', 'skills')}`);
    if (presetCount > 0) {
      console.log(`Agent presets: ${presetCount} deployed to ${dshAgentPresetsRoot()} (pick one when starting a session; children inherit it).`);
    }
    console.log('Rules are surfaced through AGENTS.md; full bodies via `aiwg show rule <name>`.');
    console.log('Optional: connect AIWG MCP via @deepseek-ai/dsh-mcp-client in cordis.yml (`aiwg mcp serve`).');
    console.log('See: docs/agents/providers/deepseek-harness.md');
  }
}
