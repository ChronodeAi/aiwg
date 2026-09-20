/**
 * Grok Build provider (experimental).
 * Project skills under `.grok/skills`; user home via $GROK_HOME (default ~/.grok).
 * Distinct from grokbot. No bare `grok` alias.
 * @issue #2575
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createAgentsMdFromTemplate,
  ensureDir,
  deploySkillDir,
  collectFrameworkArtifacts,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  resolveAiwgRoot,
} from './base.mjs';

export const name = 'grok-build';
export const aliases = [];
export const paths = {
  agents: '.grok/agents',
  skills: '.grok/skills',
  rules: '.grok/rules',
  hooks: '.grok/hooks',
  config: '.grok/config.toml',
};
export const kernelSkillsPath = '.grok/skills';
export const support = { agents: 'native', commands: false, skills: 'native', rules: 'native' };
export const capabilities = {
  skills: true,
  rules: true,
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

export function deploySkills(skillDirs, targetDir, opts = {}) {
  const destination = path.join(targetDir, kernelSkillsPath);
  ensureDir(destination, opts.dryRun);
  const unique = [...new Set(skillDirs || [])];
  for (const skillDir of unique) deploySkillDir(skillDir, destination, opts);
  return unique.length;
}

export async function postDeploy(target, opts = {}) {
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    createAgentsMd(target, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    const home = resolveGrokHome(opts.env || process.env);
    console.log(
      `Grok Build (experimental): project skills → ${kernelSkillsPath}; ` +
        `user home → ${home || '(unresolved GROK_HOME)'}. Distinct from grokbot.`,
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
  if (!opts.commandsOnly && !opts.rulesOnly) count += deploySkills(skillDirs, opts.target, opts);
  await postDeploy(opts.target, opts);
  return count;
}

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  support,
  capabilities,
  resolveGrokHome,
  createAgentsMd,
  deploySkills,
  postDeploy,
  getFileExtension,
  deploy,
};
