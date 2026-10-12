import { getProviderDefinition } from '../../providers/provider-definitions.js';
import { resolveActiveProvider } from '../provider-resolution.js';

/** Shared strict provider selection for commands that act on one provider. */
export async function providerCommandOptions(args: string[], cwd: string, valueFlags: string[] = []) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (![...valueFlags, '--provider'].includes(flag) || flags[flag] !== undefined) throw new Error('Unknown or duplicate option');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    flags[flag] = value;
  }
  // resolveActiveProvider falls back for unknown explicit IDs; commands must not.
  if (flags['--provider'] && !getProviderDefinition(flags['--provider'])) throw new Error('Unknown provider');
  const resolved = await resolveActiveProvider({ cwd, explicitProvider: flags['--provider'] });
  const provider = resolved.provider && getProviderDefinition(resolved.provider);
  if (!provider) throw new Error('Select one provider with --provider');
  return { provider, flags };
}
