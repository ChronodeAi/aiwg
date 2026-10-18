import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Identify a bundled owner independently of the installation prefix. */
export function extractFrameworkSlug(source) {
  if (typeof source !== 'string') return null;
  return source.replace(/\\/g, '/').match(/agentic\/code\/(?:frameworks|addons)\/([^/]+)\//)?.[1] ?? null;
}

function sourceSegment(source) {
  if (!source) return null;
  const normalized = source.replace(/\\/g, '/');
  return normalized.match(/(?:agentic\/code|\.aiwg)\/(?:frameworks|addons|extensions)\/.+$/)?.[0]
    ?? normalized.match(/[^/]+\/skills\/[^/]+$/)?.[0] ?? null;
}

/** Slugs survive install moves; legacy receipts fall back to source identity. */
export function sameSkillOwner(receipt, skillSource, frameworkSlug = extractFrameworkSlug(`${skillSource}/SKILL.md`)) {
  const existingSlug = receipt?.managed?.['SKILL.md']?.frameworkSlug;
  if (existingSlug && frameworkSlug) return existingSlug === frameworkSlug;
  if (receipt?.skillSource && path.resolve(receipt.skillSource) === path.resolve(skillSource)) return true;
  if (existingSlug || frameworkSlug || !receipt?.skillSource) return false;
  const segment = sourceSegment(skillSource);
  return Boolean(segment && path.basename(receipt.skillSource) === path.basename(skillSource)
    && sourceSegment(receipt.skillSource) === segment);
}

/** Frameworks outrank addons; peers retain ownership unless explicitly forced. */
export function canDeploySkill(receipt, skillSource, { force = false } = {}) {
  const owner = receipt?.managed?.['SKILL.md']?.frameworkSlug || receipt?.skillSource;
  if (!owner || sameSkillOwner(receipt, skillSource)) return true;
  const incoming = extractFrameworkSlug(`${skillSource}/SKILL.md`) || skillSource;
  const isFramework = /(?:^|\/)agentic\/code\/frameworks\//.test(skillSource.replace(/\\/g, '/'));
  const wasAddon = /(?:^|\/)agentic\/code\/addons\//.test((receipt.skillSource || '').replace(/\\/g, '/'));
  const replace = force || (isFramework && wasAddon);
  console.warn(`Skill deploy collision: '${path.basename(skillSource)}' is owned by ${owner}; ${incoming} ${replace ? 'taking ownership' : 'skipped'}`);
  return replace;
}

/** Remove unchanged recorded files, allowing symlinks above (but never inside) the skill root. */
export function pruneRecordedSkillFiles(skillDir, managed, desired, opts = {}) {
  if (opts.dryRun) return;
  for (const [relative, record] of Object.entries(managed || {})) {
    if (desired.has(relative)) continue;
    const target = path.resolve(skillDir, relative);
    if (!target.startsWith(`${path.resolve(skillDir)}${path.sep}`)) continue;
    try {
      const expected = path.resolve(fs.realpathSync(skillDir), relative);
      let current = target;
      let symlink = false;
      while (current !== path.resolve(skillDir)) {
        if (fs.lstatSync(current).isSymbolicLink()) { symlink = true; break; }
        current = path.dirname(current);
      }
      if (symlink || fs.realpathSync(target) !== expected || !fs.lstatSync(target).isFile()) continue;
      if (`sha256:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}` !== record.hash) continue;
      fs.unlinkSync(target);
      let parent = path.dirname(target);
      while (parent !== path.resolve(skillDir)) {
        try { fs.rmdirSync(parent); } catch { break; }
        parent = path.dirname(parent);
      }
    } catch { /* missing, modified, or unreadable files are left alone */ }
  }
}

/** Release only the receipt's owner. Return null for foreign/unrecorded skills. */
export function releaseSkillOwnership(skillDir, owner, opts = {}) {
  if (!fs.existsSync(skillDir) || !fs.lstatSync(skillDir).isDirectory()) return null;
  const manifestPath = path.join(skillDir, '.aiwg-manifest.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return null; }
  if (!receipt.managed?.['SKILL.md']) return null;
  const slug = receipt.managed['SKILL.md'].frameworkSlug;
  // A bundle owns every receipt whose source lies inside its root, wherever
  // its layout (plugin payloads included) puts the skill directory.
  const insideRoot = owner.sourceRoot && receipt.skillSource
    && !path.relative(path.resolve(owner.sourceRoot), path.resolve(receipt.skillSource)).startsWith('..')
    && !path.isAbsolute(path.relative(path.resolve(owner.sourceRoot), path.resolve(receipt.skillSource)));
  if (!insideRoot && (slug ? slug !== owner.frameworkSlug
    : !owner.skillSource || !sameSkillOwner(receipt, owner.skillSource, null))) return null;
  if (opts.dryRun) return false;
  pruneRecordedSkillFiles(skillDir, receipt.managed, new Set(), opts);
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(path.join(skillDir, '.aiwg-managed'), { force: true });
  try { fs.rmdirSync(skillDir); return true; } catch { return false; }
}
