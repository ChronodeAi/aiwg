// Count bundle artifacts from native files and activation-selected rule receipts.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function countDeployedBundleRules(bundlePath: string, target: string, deployPath: string): Promise<number> {
  if (!deployPath) return 0;
  const destination = path.resolve(target, deployPath);
  let selected: string[] = [];
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(destination, '.aiwg-manifest.json'), 'utf8'));
    selected = Array.isArray(receipt.ruleSources) ? receipt.ruleSources : [];
  } catch { /* Legacy deployments have only native files. */ }
  let sources: string[];
  try { sources = (await fs.readdir(path.join(bundlePath, 'rules'))).filter(name => name.endsWith('.md')); }
  catch { return 0; }
  let count = 0;
  for (const name of sources) {
    if (selected.includes(path.resolve(bundlePath, 'rules', name))) { count++; continue; }
    for (const extension of ['.md', '.mdc']) {
      try { await fs.access(path.join(destination, path.basename(name, '.md') + extension)); count++; break; }
      catch { /* A catalog-only, unselected rule is not deployed. */ }
    }
  }
  return count;
}

export async function countDeployedBundleFiles(
  bundlePath: string, subdir: string, target: string, deployPath: string, extensions: string[],
): Promise<number> {
  if (!deployPath) return 0;
  let names: string[];
  try { names = (await fs.readdir(path.join(bundlePath, subdir))).filter(name => name.endsWith('.md')); }
  catch { return 0; }
  let count = 0;
  for (const name of names) {
    for (const extension of extensions) {
      try {
        await fs.access(path.join(path.resolve(target, deployPath), path.basename(name, '.md') + extension));
        count++;
        break;
      } catch { /* Only count artifacts actually written by this bundle. */ }
    }
  }
  return count;
}
