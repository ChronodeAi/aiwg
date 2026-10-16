import path from 'node:path';
import { getProviderArtifactPathStrings, getProviderKernelSkillPath } from './provider-definitions.js';
import { resolveGrokbotSkillsDir } from './grokbot-paths.js';

/** All shared-copier tiers, including adapter mirrors. */
export function deployedSkillRoots(target: string, provider: string): string[] {
  const roots = [(getProviderArtifactPathStrings(provider) ?? getProviderArtifactPathStrings('claude'))?.skills,
    getProviderKernelSkillPath(provider) || getProviderKernelSkillPath('claude')];
  if (provider === 'muse') roots.push('.agents/.aiwg/skills');
  if (provider === 'grok-build') roots.push('.grok/.aiwg/skills');
  if (provider === 'grokbot') {
    const root = resolveGrokbotSkillsDir();
    if (root) roots.push(root, path.join(root, '.aiwg', 'skills'));
  }
  return [...new Set(roots.filter((root): root is string => Boolean(root))
    .map(root => path.isAbsolute(root) ? root : path.join(target, root)))];
}
