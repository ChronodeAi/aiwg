// Reconcile skill-relative and bundle-root support assets after provider deployment.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canDeploySkill, sameSkillOwner, extractFrameworkSlug } from '../../providers/skill-ownership.mjs';
import { resolveOmpPaths } from '../../providers/omp-paths.mjs';
import { deployedSkillRoots } from '../../providers/deployed-skill-roots.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';

async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

const SKILL_SUPPORT_REFERENCE = /(?:^|[\s`('"\[])((?:templates|references|scripts|assets)\/[A-Za-z0-9._@/+\-]*[A-Za-z0-9_@/+\-])(?=$|[.?!\s`)'"\],:;])/gm;

/** Copy one support file, preserving its executable bit. */
async function copySkillSupportFile(source: string, destination: string, skillDir?: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, (await fs.stat(source)).mode & 0o777);
  // Extend the shared copier's receipt for bundle-root assets too. Adapters
  // without that receipt keep their own ownership and cleanup contract.
  if (!skillDir) return;
  const manifestPath = path.join(skillDir, '.aiwg-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { return; }
  if (!manifest.skillSource || !manifest.managed?.['SKILL.md']) return;
  manifest.managed[path.relative(skillDir, destination)] = {
    ...manifest.managed['SKILL.md'],
    hash: `sha256:${createHash('sha256').update(await fs.readFile(destination)).digest('hex')}`,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Materialize a directory-valued support-asset reference (#2503).
 *
 * Applies the same rules the single-file path applies, per entry: symlinks are
 * refused rather than followed (a link inside a bundle can point anywhere), and
 * file modes are preserved so script packs stay executable. Empty directories
 * are still created — a reference to an empty pack is odd but not an error.
 */
async function copySkillSupportTree(
  source: string,
  destination: string,
  sourceSkillMd: string,
  reference: string,
  deployFile: ((from: string, to: string) => void) | null,
  skillDir?: string,
): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const label = reference.replace(/\/+$/, '');
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `unsafe skill support asset '${label}/${entry.name}' referenced by ${sourceSkillMd}: symbolic links are not deployed`,
      );
    }
    if (entry.isDirectory()) {
      await copySkillSupportTree(from, to, sourceSkillMd, `${label}/${entry.name}`, deployFile, skillDir);
      continue;
    }
    if (!entry.isFile()) continue;
    if (deployFile) {
      deployFile(from, to);
      continue;
    }
    await copySkillSupportFile(from, to, skillDir);
  }
}

/**
 * Skill-relative support files may live beside the skill or at the bundle root
 * (plugin payloads commonly share report templates). Materialize
 * only paths explicitly named by SKILL.md, and fail closed on missing or
 * unsafe sources so a deployed instruction can never point at absent assets.
 */
export async function reconcileDeployedSkillAssets(
  bundlePath: string,
  target: string,
  provider: string,
  options: { strictReferences?: boolean; scope?: 'user' | 'project'; skipUndeployed?: boolean; force?: boolean } = {},
): Promise<void> {
  const strictReferences = options.strictReferences ?? true;
  const skillsRoot = path.join(bundlePath, 'skills');
  let skillDirs: string[];
  try {
    skillDirs = (await fs.readdir(skillsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }
  const deployRoots = provider === 'omp' && options.scope === 'user'
    ? [path.join(resolveOmpPaths({ cwd: target }).agentDir, 'skills')]
    : deployedSkillRoots(target, provider);

  for (const skillName of skillDirs) {
    const sourceSkillDir = path.join(skillsRoot, skillName);
    const sourceSkillMd = path.join(sourceSkillDir, 'SKILL.md');
    let content: string;
    try { content = await fs.readFile(sourceSkillMd, 'utf8'); } catch { continue; }
    // Check each deployed tier independently: a foreign mirror must not block
    // support assets for a tier already owned by this source.
    const ownedRoots: string[] = [];
    for (const root of deployRoots) {
      const skillDir = path.join(root, skillName);
      try {
        const manifestPath = path.join(skillDir, '.aiwg-manifest.json');
        const receipt = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (!canDeploySkill(receipt, sourceSkillDir, options)) continue;
        if (!sameSkillOwner(receipt, sourceSkillDir)) {
          receipt.skillSource = path.resolve(sourceSkillDir);
          const slug = extractFrameworkSlug(sourceSkillMd);
          for (const record of Object.values(receipt.managed ?? {}) as Array<{ frameworkSlug?: string }>) {
            if (slug) record.frameworkSlug = slug;
            else delete record.frameworkSlug;
          }
          await fs.writeFile(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`);
        }
      } catch { /* adapters without shared ownership receipts keep their own contract */ }
      if (await fileExists(path.join(skillDir, 'SKILL.md'))) ownedRoots.push(root);
    }
    if (ownedRoots.length === 0) continue;
    if (options.skipUndeployed && !(await Promise.all(ownedRoots.map(root =>
      fileExists(path.join(root, skillName, 'SKILL.md'))))).some(Boolean)) continue;
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const declaredEntrypoint = frontmatter
      .match(/^[ \t]+entrypoint:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    const declaredEntrypoints = new Set(declaredEntrypoint ? [declaredEntrypoint] : []);
    const references = [...new Set([
      ...content.matchAll(SKILL_SUPPORT_REFERENCE),
    ].map(match => match[1]).concat([...declaredEntrypoints]))];
    for (const relative of references) {
      const normalized = path.posix.normalize(relative);
      if (normalized !== relative || normalized.startsWith('../') || path.isAbsolute(normalized)) {
        throw new Error(`unsafe skill support reference '${relative}' in ${sourceSkillMd}`);
      }
      const candidates = [path.join(sourceSkillDir, normalized), path.join(bundlePath, normalized)];
      let source: string | undefined;
      let sourceIsDirectory = false;
      for (const candidate of candidates) {
        try {
          const stat = await fs.lstat(candidate);
          if (stat.isSymbolicLink()) continue;
          // A reference may name a whole support directory (a templates pack,
          // a references folder). Rejecting those as "missing" aborted the
          // bundle deploy over a path that was present all along (#2503).
          if (stat.isFile() || stat.isDirectory()) {
            source = candidate;
            sourceIsDirectory = stat.isDirectory();
            break;
          }
        } catch { /* try bundle-root fallback */ }
      }
      if (!source) {
        if (strictReferences || declaredEntrypoints.has(relative)) {
          throw new Error(`missing skill support asset '${relative}' referenced by ${sourceSkillMd}`);
        }
        continue;
      }
      if (sourceIsDirectory && declaredEntrypoints.has(relative)) {
        throw new Error(
          `skill entrypoint '${relative}' in ${sourceSkillMd} resolves to a directory; an entrypoint must be a file`,
        );
      }

      let deployedSkillRoot: string | undefined;
      for (const root of ownedRoots) {
        // The deployer may select the bulk or kernel tier; use the tier that
        // actually contains this skill's transformed SKILL.md.
        if (await fileExists(path.join(root, skillName, 'SKILL.md'))) {
          deployedSkillRoot = root;
          break;
        }
      }
      if (!deployedSkillRoot) throw new Error(`deployed skill '${skillName}' not found while reconciling support assets`);
      const destination = path.join(deployedSkillRoot, skillName, ...normalized.split('/'));
      const deployFile = provider === 'omp'
        ? await (async (): Promise<(from: string, to: string) => void> => {
          const adapter = await import(pathToFileURL(path.join(await getFrameworkRoot(), 'tools/agents/providers/omp.mjs')).href);
          return (from, to) => adapter.deploySkillSupportAsset(from, to, { quiet: true });
        })()
        : null;
      if (sourceIsDirectory) {
        await copySkillSupportTree(source, destination, sourceSkillMd, relative, deployFile, path.join(deployedSkillRoot, skillName));
        continue;
      }
      if (deployFile) {
        deployFile(source, destination);
        continue;
      }
      await copySkillSupportFile(source, destination, path.join(deployedSkillRoot, skillName));
    }
  }
}

