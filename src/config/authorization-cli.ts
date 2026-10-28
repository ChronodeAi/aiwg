// Exposes HITL inspection, validation, preview, enable/revoke and signed receipts under config/steward.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AiwgError, EXIT_CODES } from '../cli/errors.js';
import { getProjectDir, readAiwgConfig, writeAiwgConfig } from './aiwg-config.js';
import { ensureAuthorization, loadHitlLayers } from '../policy/hitl-config.js';
import { resolveHitlAuthorization } from '../policy/hitl.js';
import { validateHitlPolicy } from '../policy/hitl-validation.js';
import type { HitlPolicy } from '../policy/hitl-types.js';

export const authorizationUsage = `aiwg config authorization (also aiwg steward authorization)
  inspect | validate [--target DIRECTORY]
  preview --action-file FILE [--target DIRECTORY]
  enable --policy-file FILE [--target DIRECTORY]
  revoke [--profile NAME] [--target DIRECTORY]
  receipt --action-file FILE [--target DIRECTORY]
Preview is read-only. Receipt writes the decision to the existing signed effect ledger;
it does not perform the proposed action. Action files cannot supply session authorization.`;
const usageError = (message: string) => new AiwgError({ code: 'ERR_AUTHORIZATION_USAGE', message, exitCode: EXIT_CODES.USAGE });
async function jsonFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw usageError('Authorization JSON input could not be read or parsed'); }
}
export async function authorizationCli(args: string[], cwd = process.cwd()): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(authorizationUsage); return; }
  const [operation, ...rest] = args;
  const flags: Record<string, string> = {};
  const allowed = ['--target', ...(operation === 'enable' ? ['--policy-file'] : []),
    ...(['preview', 'receipt'].includes(operation) ? ['--action-file'] : []), ...(operation === 'revoke' ? ['--profile'] : [])];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || flags[rest[i]]) throw usageError('Invalid authorization option');
    flags[rest[i]] = rest[i + 1];
  }
  const target = resolve(getProjectDir({ cwd }, rest));
  if (operation === 'inspect' || operation === 'validate') {
    const loaded = await loadHitlLayers(target);
    console.log(JSON.stringify(operation === 'inspect' ? loaded : { valid: true, layers: loaded.layers.length }, null, 2));
    return;
  }
  if (operation === 'preview' || operation === 'receipt') {
    if (!flags['--action-file']) throw usageError('--action-file is required');
    const action = await jsonFile(resolve(cwd, flags['--action-file']));
    const loaded = await loadHitlLayers(target);
    const context = { now: new Date().toISOString(), layers: loaded.layers };
    if (operation === 'preview') console.log(JSON.stringify(resolveHitlAuthorization(action, context), null, 2));
    else {
      const { effectSession, openLedger } = await import('../effects/host.js');
      const { recordHitlAuthorization } = await import('../policy/hitl-receipt.js');
      const session = await effectSession(loaded.projectDir, 'custom');
      console.log(JSON.stringify(await recordHitlAuthorization(openLedger(session), action, context), null, 2));
    }
    return;
  }
  if (operation !== 'enable' && operation !== 'revoke') throw usageError('Unknown authorization operation');
  const config = await readAiwgConfig(target);
  if (!config) throw usageError('No project config found; initialize project config first');
  const authorization = ensureAuthorization(config);
  if (operation === 'enable') {
    if (!flags['--policy-file']) throw usageError('--policy-file is required');
    const policy = await jsonFile(resolve(cwd, flags['--policy-file']));
    const errors = validateHitlPolicy(policy);
    if (policy === undefined || errors.length) throw usageError('Invalid authorization.hitl policy');
    authorization.hitl = { ...(policy as HitlPolicy), enabled: true };
  } else if (authorization.hitl) {
    if (flags['--profile']) {
      if (!Object.hasOwn(authorization.hitl.profiles, flags['--profile'])) throw usageError('Unknown authorization profile');
      delete authorization.hitl.profiles[flags['--profile']];
    } else authorization.hitl.enabled = false;
  }
  await writeAiwgConfig(target, config);
  console.log(JSON.stringify({ operation, enabled: authorization.hitl?.enabled ?? false }));
}
