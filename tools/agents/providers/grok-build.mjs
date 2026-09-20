/**
 * Grok Build provider (experimental).
 * Project skills under `.grok/skills`; user home via $GROK_HOME (default ~/.grok).
 * Distinct from grokbot. No bare `grok` alias.
 *
 * Wave 1: native kernel skills + AGENTS.md bridge. Agents and rules are
 * indexed/deferred until #2577 (Grok discovers `.grok/agents` and
 * `.grok/rules`, but AIWG does not yet emit qualified writers for them).
 *
 * @issue #2575
 */

import path from 'node:path';
import os from 'node:os';
import {
  createAgentsMdFromTemplate,
  deploySkillsWithKernelRouting,
  collectFrameworkArtifacts,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  resolveAiwgRoot,
} from './base.mjs';

export const name = 'grok-build';
export const aliases = [];
export const paths = {
  // Agents/rules dirs exist in Grok Build, but Wave 1 does not write them.
  agents: '',
  skills: '.grok/skills',
  rules: '',
  hooks: '.grok/hooks',
  config: '.grok/config.toml',
};
export const kernelSkillsPath = '.grok/skills';
/** Standard-tier opt-in mirror (`--copy-all`) lives under the project .aiwg tree. */
export const standardSkillsPath = '.grok/.aiwg/skills';

export const support = {
  agents: 'indexed', // deferred native writer until #2577
  commands: false,
  skills: 'native',
  rules: 'indexed', // deferred native writer until #2577; host still loads AGENTS.md + .grok/rules hierarchically
};

export const capabilities = {
  skills: true,
  rules: false, // indexed/deferred — do not claim native rule transforms yet
  yamlFormat: false,
  aggregatedOutput: false,
  homeDirectoryDeploy: true,
  parallelCommandAndSkillSurfaces: false,
};

const GROK_HOME_ENV = 'GROK_HOME';

export function resolveGrokHome(env = process.env, userHome = os.homedir()) {
  const raw = (env[GROK_HOME_ENV] || '').trim();
  const candidate = raw || path.join(userHome, '.grok');
  if (candidate === '~') return null;
  let expanded = candidate;
  if (candidate.startsWith('~/')) expanded = path.join(userHome, candidate.slice(2));
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  if (!resolved || resolved === path.sep) return null;
  return resolved;
}

export function createAgentsMd(target, srcRoot, dryRun) {
  createAgentsMdFromTemplate(
    target,
    resolveAiwgRoot(srcRoot) || srcRoot,
    'grok-build/AGENTS.md.aiwg-template',
    dryRun,
  );
}

/**
 * Kernel skills → `.grok/skills` (always).
 * Standard skills → index-driven by default; `.grok/.aiwg/skills` with `--copy-all`.
 */
export function deploySkills(skillDirs, targetDir, opts = {}) {
  const kernelDest = path.join(targetDir, kernelSkillsPath);
  const standardDest = path.join(targetDir, standardSkillsPath);
  return deploySkillsWithKernelRouting(skillDirs, standardDest, kernelDest, {
    ...opts,
    copyStandardSkills: opts.copyStandardSkills === true,
  });
}

export function deployAgents() {
  return 0;
}

export function deployRules() {
  return 0;
}

export async function postDeploy(target, opts = {}) {
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    createAgentsMd(target, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    const home = resolveGrokHome(opts.env || process.env);
    console.log(
      `Grok Build (experimental): kernel skills → ${kernelSkillsPath}; ` +
        `standard skills index-driven (opt-in mirror → ${standardSkillsPath} with --copy-all); ` +
        `agents/rules indexed until #2577; user home → ${home || '(unresolved GROK_HOME)'}. ` +
        'Distinct from grokbot.',
    );
  }
}

export function getFileExtension() {
  return '.md';
}

export async function deploy(opts) {
  const mode = normalizeDeploymentMode(opts.mode);
  const skillDirs = [...getAddonSkillDirs(opts.srcRoot)];
  skillDirs.push(
    ...collectFrameworkArtifacts(opts.srcRoot, mode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    }).skills,
  );
  let count = 0;
  if (!opts.commandsOnly && !opts.rulesOnly) {
    const result = deploySkills(skillDirs, opts.target, opts);
    count += (result?.kernel ?? 0) + (result?.standardCopied ?? 0);
  }
  await postDeploy(opts.target, opts);
  return count;
}

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  standardSkillsPath,
  support,
  capabilities,
  resolveGrokHome,
  createAgentsMd,
  deploySkills,
  deployAgents,
  deployRules,
  postDeploy,
  getFileExtension,
  deploy,
};
