/**
 * Git Adapter
 *
 * Base adapter for fetching packages from any Git URL.
 * Handles clone to cache, pull for refresh, and version tag checkout.
 *
 * Cache layout:
 *   ~/.cache/aiwg/packages/<owner>/<name>@<version>/
 *
 * @implements #557
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync } from 'fs';
import type { PackageRef, PackageSource, PackageRegistryAdapter, FetchOptions, PackageInfo } from '../types.js';
import { resolveSensitiveInput, type SensitiveInputOptions } from '../../auth/sensitive-input.js';
import { helperEnvironment, HELPER_ENV_ALLOWLIST } from '../../process/cli-command.mjs';

const execFileAsync = promisify(execFile);
// Deliberately separate from serializable sources, locks and provenance.
const credentials = new WeakMap<PackageSource, string>();

function hasTokenSource(input: SensitiveInputOptions): boolean {
  return Boolean(input.interactive || input.stdin || input.file !== undefined || input.store !== undefined || input.env !== undefined);
}

/** Explicit sources precede the established env/file lookup; no token means SSH. */
export async function resolvePackageToken(input: SensitiveInputOptions = {}, envName?: string, paths: string[] = []): Promise<string | undefined> {
  if (hasTokenSource(input)) return resolveSensitiveInput({ ...input, prefix: 'token' });
  if (envName && process.env[envName]) return resolveSensitiveInput({ prefix: 'token', env: envName });
  for (const file of paths) {
    if (existsSync(file)) return resolveSensitiveInput({ prefix: 'token', file });
  }
  return undefined;
}

// GitHub rejects Bearer on git smart HTTP; Basic with x-access-token works on GitHub and Gitea.
function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

function redact(value: string, token?: string): string {
  if (!token) return value;
  return [token, encodeURIComponent(token), basicCredential(token)]
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}

/**
 * Default cache root
 */
function getCacheRoot(): string {
  const xdgCache = process.env.XDG_CACHE_HOME;
  const base = xdgCache ? xdgCache : join(homedir(), '.cache');
  return join(base, 'aiwg', 'packages');
}

/**
 * Build cache path for a package at a specific version
 */
export function buildCachePath(owner: string, name: string, version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(getCacheRoot(), owner, `${name}@${safe}`);
}

/**
 * Run a git command, returning stdout
 */
async function git(args: string[], cwd?: string, authentication?: { config: string; token: string }): Promise<string> {
  const env = helperEnvironment(process.env, [...HELPER_ENV_ALLOWLIST, 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'XDG_CONFIG_HOME']);

  // Suppress interactive prompts
  env.GIT_TERMINAL_PROMPT = '0';
  if (authentication) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'include.path';
    env.GIT_CONFIG_VALUE_0 = authentication.config;
  }
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: 120_000 });
    return redact(stdout.trim(), authentication?.token);
  } catch (error) {
    // Never rethrow execFile's object: it carries raw stdout/stderr properties.
    throw new Error(redact(error instanceof Error ? error.message : 'Git command failed.', authentication?.token));
  }
}

/**
 * Detect the manifest type from a cloned package directory
 */
async function detectManifestType(
  cachePath: string
): Promise<'framework' | 'addon' | 'extension' | 'unknown'> {
  const manifestPath = join(cachePath, 'manifest.json');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as { type?: string };
    const t = manifest.type?.toLowerCase() ?? '';
    if (t === 'framework') return 'framework';
    if (t === 'addon') return 'addon';
    if (t === 'extension') return 'extension';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve the latest tag from a remote git repo
 */
async function resolveLatestTag(gitUrl: string, authentication?: { config: string; token: string }): Promise<string> {
  try {
    const output = await git(['ls-remote', '--tags', '--sort=-v:refname', gitUrl], undefined, authentication);
    const firstLine = output.split('\n')[0] ?? '';
    const match = firstLine.match(/refs\/tags\/(.+)/);
    if (match && match[1]) return match[1].replace(/\^{}$/, '');
  } catch {
    // fall through
  }
  return 'latest';
}

async function resolveRemoteCommit(gitUrl: string, requestedRef: string, authentication?: { config: string; token: string }): Promise<string | undefined> {
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requestedRef)) return requestedRef;
  const patterns = requestedRef === 'HEAD'
    ? ['HEAD']
    : [`refs/tags/${requestedRef}^{}`, `refs/tags/${requestedRef}`, `refs/heads/${requestedRef}`, requestedRef];
  try {
    const output = await git(['ls-remote', gitUrl, ...patterns], undefined, authentication);
    const rows = output.split('\n').filter(Boolean).map((line) => {
      const [oid = '', ref = ''] = line.split(/\s+/, 2);
      return { oid, ref };
    });
    const peeled = rows.find((row) => row.ref.endsWith('^{}'));
    const selected = peeled ?? rows[0];
    return selected && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(selected.oid)
      ? selected.oid
      : undefined;
  } catch {
    return undefined;
  }
}

function urlCacheIdentity(gitUrl: string): { owner: string; name: string } {
  const urlKey = gitUrl
    .replace(/^https?:\/\//, '')
    .replace(/^ssh:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[:/]/g, '_');
  const parts = urlKey.split('_').filter(Boolean);
  return {
    name: parts[parts.length - 1] ?? 'package',
    owner: parts[parts.length - 2] ?? 'unknown',
  };
}

/**
 * GitAdapter
 *
 * Handles any https:// or git@... URL directly.
 * Also serves as the base class for Gitea/GitHub shorthand adapters.
 */
export class GitAdapter implements PackageRegistryAdapter {
  readonly id: string = 'git';
  readonly name: string = 'Git (direct URL)';

  /**
   * Returns true for https:// or git@/ssh:// URLs, or git+https:// URLs
   */
  canResolve(ref: string): boolean {
    return (
      ref.startsWith('https://') ||
      ref.startsWith('http://') ||
      ref.startsWith('git@') ||
      ref.startsWith('ssh://') ||
      ref.startsWith('git+https://')
    );
  }

  async resolve(ref: PackageRef, options: FetchOptions = {}): Promise<PackageSource | null> {
    if (!ref.rawUrl) return null;
    const source = {
      gitUrl: ref.rawUrl,
      ref: ref.version,
      label: ref.rawUrl,
    };
    const token = await resolvePackageToken(options.tokenInput);
    return this.withToken(source, token);
  }

  protected withToken(source: PackageSource, token?: string): PackageSource {
    if (/^https?:\/\//.test(source.gitUrl)) {
      const url = new URL(source.gitUrl);
      if (url.username || url.password) throw new Error('Credentials in Git URLs are refused; use --token-stdin, --token-file, --token-store or --token-env.');
    }
    if (token) credentials.set(source, token);
    return source;
  }

  async fetch(source: PackageSource, options: FetchOptions = {}): Promise<string> {
    this.withToken(source);
    const token = credentials.get(source) ?? (hasTokenSource(options.tokenInput ?? {})
      ? await resolvePackageToken(options.tokenInput) : undefined);
    let privateDir: string | undefined;
    try {
      let authentication: { config: string; token: string } | undefined;
      if (token) {
        if (process.platform === 'win32') throw new Error('Git token authentication requires private temporary-file ACL validation on Windows; use SSH-agent authentication.');
        const url = new URL(source.gitUrl);
        if (url.protocol !== 'https:') throw new Error('Git token authentication requires HTTPS.');
        privateDir = await mkdtemp(join(tmpdir(), 'aiwg-git-credentials-'));
        const config = join(privateDir, 'config');
        // A path-only include survives NODE_DEBUG=child_process safely. The
        // origin-scoped header is transient and never saved in .git/config.
        await writeFile(config, `[http ${JSON.stringify(`${url.origin}/`)}]\n\textraHeader = ${JSON.stringify(`Authorization: Basic ${basicCredential(token)}`)}\n`, { mode: 0o600 });
        authentication = { config, token };
      }
      return await this.fetchAuthenticated(source, options, authentication);
    } finally {
      if (privateDir) await rm(privateDir, { recursive: true, force: true });
    }
  }

  private async fetchAuthenticated(source: PackageSource, options: FetchOptions, authentication?: { config: string; token: string }): Promise<string> {
    // Resolve discovery inputs before any deployment and cache by immutable
    // commit rather than by a movable tag/branch name (#2009).
    let requestedRef = source.ref;
    if (!requestedRef) {
      const latest = await resolveLatestTag(source.gitUrl, authentication);
      requestedRef = latest === 'latest' ? 'HEAD' : latest;
      source.ref = requestedRef;
    }
    const advertisedCommit = await resolveRemoteCommit(source.gitUrl, requestedRef, authentication);
    const { owner, name } = urlCacheIdentity(source.gitUrl);
    if (advertisedCommit) {
      const existing = buildCachePath(owner, name, advertisedCommit);
      if (!options.refresh && existsSync(join(existing, '.git'))) {
        const existingCommit = await git(['rev-parse', 'HEAD^{commit}'], existing, authentication);
        if (existingCommit !== advertisedCommit) throw new Error(`Immutable package cache mismatch at ${existing}`);
        return existing;
      }
    }

    const ownerDir = join(getCacheRoot(), owner);
    await mkdir(ownerDir, { recursive: true });
    const stage = await mkdtemp(join(ownerDir, `.${name}.resolve-`));
    try {
      await git(['clone', '--no-checkout', source.gitUrl, stage], undefined, authentication);
      await git(['checkout', '--detach', requestedRef], stage, authentication);
      const resolvedCommit = await git(['rev-parse', 'HEAD^{commit}'], stage, authentication);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolvedCommit)) {
        throw new Error(`Git resolved '${requestedRef}' to invalid commit '${resolvedCommit}'`);
      }
      if (advertisedCommit && resolvedCommit !== advertisedCommit) {
        throw new Error(`Git ref '${requestedRef}' moved during resolution (${advertisedCommit} -> ${resolvedCommit})`);
      }
      const cachePath = buildCachePath(owner, name, resolvedCommit);
      if (existsSync(join(cachePath, '.git'))) {
        const cachedCommit = await git(['rev-parse', 'HEAD^{commit}'], cachePath, authentication);
        if (cachedCommit !== resolvedCommit) throw new Error(`Immutable package cache mismatch at ${cachePath}`);
        await rm(stage, { recursive: true, force: true });
        return cachePath;
      }
      await rename(stage, cachePath);
      return cachePath;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  /** GitAdapter does not list packages */
  async list(): Promise<PackageInfo[]> {
    return [];
  }
}

export { detectManifestType };
