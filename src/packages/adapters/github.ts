/**
 * GitHub Adapter
 *
 * Resolves "github:owner/name[@version]" shorthands against github.com.
 *
 * Authentication:
 *   - SSH clone: uses default SSH agent
 *   - HTTPS clone: resolves explicit sources, otherwise reads token from GITHUB_TOKEN env or ~/.aiwg/credentials/github
 *
 * @implements #557
 */

import { join } from 'path';
import { homedir } from 'os';
import { GitAdapter, resolvePackageToken } from './git.js';
import type { PackageRef, PackageSource, FetchOptions } from '../types.js';

const GITHUB_HOST = 'github.com';

/**
 * GitHubAdapter
 *
 * Handles "github:owner/repo[@version]" shorthands.
 */
export class GitHubAdapter extends GitAdapter {
  override readonly id: string = 'github';
  override readonly name: string = 'GitHub (shorthand)';

  /**
   * Matches "github:owner/repo" and "github:owner/repo@version"
   */
  override canResolve(ref: string): boolean {
    return ref.startsWith('github:');
  }

  override async resolve(ref: PackageRef, options: FetchOptions = {}): Promise<PackageSource | null> {
    if (!ref.owner || !ref.name) return null;

    const token = await resolvePackageToken(options.tokenInput, 'GITHUB_TOKEN', [join(homedir(), '.aiwg', 'credentials', 'github')]);

    let gitUrl: string;
    if (token) {
      gitUrl = `https://${GITHUB_HOST}/${ref.owner}/${ref.name}.git`;
    } else {
      gitUrl = `git@${GITHUB_HOST}:${ref.owner}/${ref.name}.git`;
    }

    return this.withToken({
      gitUrl,
      ref: ref.version,
      label: `github.com/${ref.owner}/${ref.name}${ref.version ? `@${ref.version}` : ''}`,
    }, token);
  }

  override async fetch(source: PackageSource, options: FetchOptions = {}): Promise<string> {
    return super.fetch(source, options);
  }
}
