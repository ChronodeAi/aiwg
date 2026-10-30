import fs from 'node:fs';
import path from 'node:path';

/** Resolve the selected corpus version before provider inputs are staged. */
export function resolveDeployVersion(root, explicitVersion, warn = console.warn) {
  const valid = value => typeof value === 'string' && value.trim() &&
    !/unknown|\s/i.test(value);
  if (valid(explicitVersion)) return explicitVersion;
  if (!explicitVersion) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (valid(pkg.version)) return pkg.version;
    } catch { /* Report missing, unreadable and invalid versions consistently. */ }
  }
  warn(`Unable to resolve AIWG deploy version from ${path.join(root, 'package.json')}; managed markers will use vunknown. Restore the package version or pass --deploy-version to the deployer.`);
  return 'unknown';
}
