#!/usr/bin/env node
/**
 * AIWG Deploy Command
 *
 * Deploys one or all installed frameworks to the current project.
 * Called by `aiwg sync` step 4 to re-deploy frameworks after an update.
 *
 * Usage:
 *   node tools/cli/deploy.mjs all [--provider <provider>]
 *   node tools/cli/deploy.mjs sdlc [--provider claude]
 *
 * @issue #683 (missing file caused aiwg sync to exit 254 silently)
 */

import { boundedExecSync } from '../../src/process/bounded-child-process.mjs';

function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function runDeploy() {
  const args = process.argv.slice(2);
  const framework = args.find(a => !a.startsWith('--')) || 'all';
  const provider = parseArg(args, '--provider');

  const providerFlag = provider ? ` --provider ${provider}` : '';
  const cmd = `aiwg use ${framework}${providerFlag}`;

  console.log(`Deploying: ${cmd}`);

  try {
    boundedExecSync(cmd, 'long', { stdio: 'inherit' });
  } catch (err) {
    console.error(`Deploy failed for '${framework}': ${err.message}`);
    process.exit(1);
  }
}

runDeploy().catch((err) => {
  console.error('Deploy error:', err.message);
  process.exit(1);
});
