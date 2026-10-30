import { explicitResourceToken } from "./config.js";
import { createCredentialStore } from "./credential-store.js";
import { resolveSensitiveInput, sensitiveInputOptions, type SensitiveInputOptions, type SensitiveInputDependencies } from "./sensitive-input.js";
import type { CredentialStore } from "./types.js";

/**
 * Resolve credentials for protected release downloads. Explicit compatibility
 * inputs take precedence over interactive-login credentials.
 */
export function createResourceCredentialProvider(
  env: NodeJS.ProcessEnv = process.env,
  store?: CredentialStore,
  source: SensitiveInputOptions = {},
  dependencies: SensitiveInputDependencies = {},
): () => Promise<string | null> {
  const hasSource = source.interactive || source.stdin || source.file !== undefined || source.store !== undefined || source.env !== undefined;
  // A command may fetch several manifests and bodies. Never consume stdin or
  // ask for the same explicit credential more than once, including on failure.
  let resolvedSource: Promise<string> | undefined;
  return async () => {
    if (hasSource) return resolvedSource ??= resolveSensitiveInput(
      { ...source, prefix: 'resource-token' }, { ...dependencies, environment: env });
    const explicit = await explicitResourceToken(env);
    if (explicit) return explicit;
    const selected = store ?? createCredentialStore();
    try {
      return (await selected.load())?.accessToken ?? null;
    } catch (error) {
      // A workstation without the platform keychain helper must retain access
      // to public releases. Invalid/corrupt stored credentials still fail loud.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

/** Parse once before command-specific positional parsing or helper forwarding. */
export async function prepareResourceCredentials(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  store?: CredentialStore,
  dependencies: SensitiveInputDependencies = {},
): Promise<{ args: string[]; credentialProvider: () => Promise<string | null>; omitEnv: string[] }> {
  const source = sensitiveInputOptions(args, 'resource-token');
  const remaining: string[] = [];
  const valueFlags = ['--resource-token-file', '--resource-token-store', '--resource-token-env'];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') { remaining.push(...args.slice(index)); break; }
    if (valueFlags.includes(token)) { index++; continue; }
    if (valueFlags.some(flag => token.startsWith(`${flag}=`)) ||
        token === '--resource-token-stdin' || token === '--resource-token-interactive') continue;
    remaining.push(token);
  }
  const credentialProvider = createResourceCredentialProvider(env, store, source, dependencies);
  if (source.interactive || source.stdin || source.file !== undefined || source.store !== undefined || source.env !== undefined) {
    await credentialProvider();
  }
  return { args: remaining, credentialProvider, omitEnv: ['AIWG_RESOURCE_TOKEN', ...(source.env ? [source.env] : [])] };
}
