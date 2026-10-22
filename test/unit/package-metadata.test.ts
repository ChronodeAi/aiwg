import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { gte, major } from 'semver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readJson(file: string) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

describe('package metadata install hygiene (#1274)', () => {
  it('keeps deprecated native prebuild plumbing out of the default install tree', () => {
    const lock = readJson('package-lock.json');
    const packages = lock.packages ?? {};

    expect(packages['node_modules/prebuild-install']).toBeUndefined();
  });

  it('keeps install-heavy native feature packages as optional peers', () => {
    const pkg = readJson('package.json');

    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('better-sqlite3');
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('@xenova/transformers');
    expect(pkg.peerDependencies ?? {}).toHaveProperty('better-sqlite3');
    expect(pkg.peerDependencies ?? {}).toHaveProperty('@xenova/transformers');
    expect(pkg.peerDependenciesMeta?.['better-sqlite3']?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta?.['@xenova/transformers']?.optional).toBe(true);
  });
});

describe('Dependabot security floors (#3413)', () => {
  it.each([
    ['package-lock.json', 'vite', '8.2.4'],
    ['apps/cockpit/package-lock.json', 'vite', '6.4.4'],
    ['apps/cockpit/web/package-lock.json', 'vite', '6.4.4'],
    ['apps/web/package-lock.json', 'vite', '6.4.4'],
    ['package-lock.json', '@vitest/mocker', '4.1.12'],
    ['apps/cockpit/package-lock.json', '@vitest/mocker', '4.1.12'],
    ['apps/cockpit/web/package-lock.json', '@vitest/mocker', '4.1.12'],
    ['vscode-extension/package-lock.json', 'markdown-it', '14.3.3'],
  ])('%s keeps every copy of %s at a patched version', (file, name, minimum) => {
    const lock = readJson(file);
    expect(lock.lockfileVersion).toBe(3);
    const versions = Object.entries(lock.packages as Record<string, { version?: string }>)
      .filter(([entry]) => entry.endsWith(`node_modules/${name}`))
      .map(([, entry]) => entry.version!);

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      // Vite's security fixes are backported separately to each release line.
      const floor = name === 'vite' && major(version) === 8 ? '8.2.4' : minimum;
      expect(gte(version, floor), `${file}: ${name}@${version} must be >=${floor}`).toBe(true);
    }
  });
});
