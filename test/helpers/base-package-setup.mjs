import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTemporaryHome } from './temporary-home.mjs';

// One genuine prepack per invocation, before workers start. No persistent cache:
// every run checks the current package/corpus and shares only immutable metadata.
export default async function setup(project) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { home, env, cleanup } = createTemporaryHome('aiwg-packaging-home-');
  try {
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
    const start = stdout.lastIndexOf('\n[');
    const packed = JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout)[0];
    if (!packed?.name || !Array.isArray(packed.files) || !packed.files.length) {
      throw new Error('Base package preparation produced no authoritative file manifest');
    }
    project.provide('basePackageManifest', packed);
    project.provide('basePackageHome', home);
    project.config.env = { ...project.config.env, ...env };
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
