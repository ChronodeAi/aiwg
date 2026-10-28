// Loads governing workspace/member policies without merging or broadening their grants.
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { getConfigPath, readAiwgConfigCandidate, type AiwgConfig } from '../config/aiwg-config.js';
import type { AuthorizationConfig } from './authorization.js';
import type { HitlLayer } from './hitl-types.js';

export function ensureAuthorization(config: AiwgConfig): AuthorizationConfig {
  return config.authorization ??= { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [] };
}
const inside = (child: string, root: string): boolean => {
  const path = relative(root, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};
async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalDirectory(parent), basename(path));
  }
}
/** Each config boundary narrows grants. A member without HITL policy cannot inherit approval. */
export async function loadHitlLayers(start: string): Promise<{ projectDir: string; layers: HitlLayer[] }> {
  const layers: HitlLayer[] = [];
  const seen = new Set<string>();
  let current = await canonicalDirectory(resolve(start));
  let projectDir: string | undefined;
  let child: string | undefined;
  while (true) {
    if (seen.has(current)) throw new Error('Cyclic HITL workspace membership');
    seen.add(current);
    const config = await readAiwgConfigCandidate(current);
    if (config) {
      projectDir ??= current;
      if (child && config.repos) {
        const root = await canonicalDirectory(resolve(current, config.workspace?.root ?? '.'));
        const members = await Promise.all(config.repos.map(repo => canonicalDirectory(resolve(root, repo.path))));
        if (!members.some(member => inside(child!, member))) {
          throw new Error('HITL workspace does not declare this member');
        }
      }
      layers.unshift({ source: getConfigPath(current), policy: config.authorization?.hitl });
      child = current;
      if (config.workspace?.member_of) {
        current = await canonicalDirectory(resolve(current, config.workspace.member_of));
        const parent = await readAiwgConfigCandidate(current);
        if (!parent?.repos) throw new Error('HITL workspace.member_of must name a workspace manifest');
        continue;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { projectDir: projectDir ?? resolve(start), layers };
}
