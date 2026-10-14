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

import { importImpl } from '../_resolve-impl.mjs';
import { isMain } from '../_is-main.mjs';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const { cliCommand } = await importImpl(import.meta.url, 'process/cli-command.mjs');

function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

export async function runDeploy(args = process.argv.slice(2)) {
  const framework = args.find(a => !a.startsWith('--')) || 'all';
  const provider = parseArg(args, '--provider');

  const deployArgs = ['use', framework];
  if (provider) deployArgs.push('--provider', provider);
  const cmd = `aiwg ${deployArgs.join(' ')}`;

  console.log(`Deploying: ${cmd}`);

  try {
    const [file, argv] = cliCommand('aiwg', deployArgs);
    boundedExecFileSync(file, argv, 'long', { stdio: 'inherit' });
  } catch (err) {
    console.error(`Deploy failed for '${framework}': ${err.message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  runDeploy().catch((err) => {
    console.error('Deploy error:', err.message);
    process.exit(1);
  });
}
