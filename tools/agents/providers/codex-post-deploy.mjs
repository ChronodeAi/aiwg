// Apply project settings and context after provider file deployment.
import { initializeFrameworkWorkspace } from './base.mjs';
import { createAgentsMd } from './codex.mjs';
import { deployConductorDataGuard } from './conductor-data-guard.mjs';

export async function postDeploy(targetDir, opts) {
  initializeFrameworkWorkspace(targetDir, opts.mode, opts.dryRun, opts.srcRoot);
  await deployConductorDataGuard(targetDir, 'codex', opts);

  if (opts.createAgentsMd) {
    if (opts.contextFiles !== false) createAgentsMd(targetDir, opts.srcRoot, opts.dryRun);
  }
}
