import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isInteractive } from '../cli/env.js';
import { askString, createSecretPromptInterface } from '../cli/prompt-utils.js';
import { createSecretStore, type SecretStore } from './credential-store.js';

/** Named raw values share the native store used by auth login, in a separate service. */
export const SENSITIVE_VALUE_SERVICE = 'aiwg.sensitive-values';
export function namedSensitiveStore(name: string): SecretStore {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error('Sensitive value store name must contain only letters, digits, dots, underscores or hyphens (1–128 characters).');
  }
  return createSecretStore({ service: SENSITIVE_VALUE_SERVICE, account: name });
}

export interface SensitiveInputOptions {
  prefix?: string;
  interactive?: boolean;
  stdin?: boolean;
  file?: string;
  store?: string;
  env?: string;
  signal?: AbortSignal;
}
export interface SensitiveInputDependencies {
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  environment?: NodeJS.ProcessEnv;
  readEnv?: (name: string) => string | undefined;
  readFile?: (pathname: string) => Promise<string>;
  readStore?: (name: string) => Promise<string | null | undefined>;
  readStdin?: () => Promise<string>;
  prompt?: (label: string) => Promise<string>;
}

/** Extract references, never literal values, from the standard command options. */
export function sensitiveInputOptions(args: string[], prefix = 'value'): SensitiveInputOptions {
  const result: SensitiveInputOptions = { prefix };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') break;
    for (const source of ['file', 'store', 'env'] as const) {
      const flag = `--${prefix}-${source}`;
      if (token !== flag && !token.startsWith(`${flag}=`)) continue;
      const value = token === flag ? args[++index] : token.slice(flag.length + 1);
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (result[source] !== undefined) throw new Error(`${flag} may only be given once`);
      result[source] = value;
    }
    if (token === `--${prefix}-stdin`) result.stdin = true;
    if (token === `--${prefix}-interactive`) result.interactive = true;
  }
  return result;
}

/** Extracted from MCP profile login: validate the opened descriptor, never a later path read. */
export async function readPrivateValueFile(filePath: string, flag = '--value-file'): Promise<string> {
  if (process.platform === 'win32') throw new Error(`${flag}: private-file input requires native ACL validation on Windows; use stdin or the OS store.`);
  try {
    const pre = await lstat(filePath);
    if (pre.isSymbolicLink()) throw new Error('file is a symlink; refusing to follow it');
    // Reject FIFOs/devices before open, which could otherwise wait indefinitely.
    if (!pre.isFile()) throw new Error('not a regular file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`${flag}: ${code === 'ENOENT' ? 'file does not exist' : code ? 'cannot stat private file' : (error as Error).message}.`);
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new Error(`${flag}: cannot open private file (symlinks are refused).`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${flag}: not a regular file.`);
    if (stat.nlink !== 1) throw new Error(`${flag}: more than one hard link; refusing to read it.`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${flag}: file is not owned by the current user.`);
    }
    if ((stat.mode & 0o077) !== 0) throw new Error(`${flag}: file must not allow group or other access (chmod 600).`);
    return (await handle.readFile({ encoding: 'utf8' })).trim();
  } finally {
    await handle.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Explicit entry, stdin, private file, native-store reference, named shell variable.
 * No implicit stdin consumption, env discovery or store probing. An empty selected
 * source is an error, never permission to try a less preferred source.
 */
export async function resolveSensitiveInput(options: SensitiveInputOptions = {}, dependencies: SensitiveInputDependencies = {}): Promise<string> {
  const prefix = options.prefix ?? 'value';
  const terminal = dependencies.isTTY ?? isInteractive();
  const choices = `--${prefix}-interactive, --${prefix}-stdin, --${prefix}-file <path>, --${prefix}-store <name>, or --${prefix}-env <name>`;
  const explicitSource = options.stdin || options.file !== undefined || options.store !== undefined || options.env !== undefined;
  let value: string | null | undefined;
  let source: string;
  if (options.interactive || (!explicitSource && terminal)) {
    if (!terminal) throw new Error(`An interactive terminal is required; supply ${choices}.`);
    source = `--${prefix}-interactive`;
    if (dependencies.prompt) value = await dependencies.prompt(prefix);
    else {
      const rl = createSecretPromptInterface();
      try {
        process.stderr.write(`Enter ${prefix} (hidden): `);
        value = await askString(rl, '', '', options.signal);
      } finally { rl.close(); process.stderr.write('\n'); }
    }
  } else if (options.stdin) {
    source = `--${prefix}-stdin`;
    if (dependencies.stdinIsTTY ?? dependencies.isTTY ?? Boolean(process.stdin.isTTY)) throw new Error(`${source} requires piped input, not a terminal.`);
    value = await (dependencies.readStdin ?? readStdin)();
  } else if (options.file !== undefined) {
    source = `--${prefix}-file`;
    value = await (dependencies.readFile ? dependencies.readFile(options.file) : readPrivateValueFile(options.file, source));
  } else if (options.store !== undefined) {
    source = `--${prefix}-store`;
    try { value = await (dependencies.readStore ? dependencies.readStore(options.store) : namedSensitiveStore(options.store).loadSecret()); }
    catch { throw new Error(`${source}: native store entry could not be read.`); }
  } else if (options.env !== undefined) {
    source = `--${prefix}-env`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.env)) throw new Error(`${source} requires a shell variable name.`);
    value = dependencies.readEnv ? dependencies.readEnv(options.env) : (dependencies.environment ?? process.env)[options.env];
  } else {
    throw new Error(`A sensitive value requires an interactive terminal, or a key supplied via ${choices}.`);
  }
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${source} received no key (input is empty or not set${options.env && source.endsWith('-env') ? `: ${options.env}` : ''}).`);
  if (trimmed.length > 16384 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${source} requires one non-empty line (at most 16384 characters).`);
  return trimmed;
}
