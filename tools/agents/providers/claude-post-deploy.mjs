// Apply project settings and context after provider file deployment.
import fs from 'node:fs';
import path from 'node:path';
import { initializeFrameworkWorkspace, ensureDir } from './base.mjs';
import { deployHookFile } from './claude.mjs';
import { deployConductorDataGuard } from './conductor-data-guard.mjs';

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
  await deployConductorDataGuard(targetDir, 'claude', opts);

  // Claude-specific post-deployment (settings.json, etc.)
  const claudeDir = path.join(targetDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // If settings.json doesn't exist, create a minimal one
  if (!fs.existsSync(settingsPath) && !opts.dryRun) {
    ensureDir(claudeDir);
    const settings = {
      version: '1.0',
      created: new Date().toISOString(),
      aiwg: {
        enabled: true,
        mode: opts.mode || 'all'
      }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('Created .claude/settings.json');
  }

  // Hook file architecture: write AIWG.md and wire @AIWG.md into CLAUDE.md
  if (opts.srcRoot && opts.contextFiles !== false) {
    deployHookFile(targetDir, opts);
  }
}
