#!/usr/bin/env node
// Changed-code coverage gate for orchestration: thresholds apply to changed
// files only (diffed against the merge base), never repo-wide.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Pure config/resolver/admission validators first; a file matching both lists
// is a validator. CLI handlers and test/tooling files are out of scope.
export const VALIDATOR_PREFIXES = [
  'src/models/', 'src/config/', 'src/mission-protocol/', 'src/serve/shared-host-',
];
export const ADAPTER_PREFIXES = ['tools/ralph-external/', 'src/serve/', 'src/mcp/'];
export const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js', '.cjs']);
export const VALIDATOR_THRESHOLDS = { statements: 90, branches: 85 };
export const ADAPTER_THRESHOLDS = { branches: 80 };
// Unit suites own validator/admission arithmetic and adapter/recovery behavior;
// conformance timing runs in its own lane and is out of this gate.
export const FOCUSED_TESTS = [
  'test/unit/serve/**/*.test.ts',
  'test/unit/models/**/*.test.ts',
  'test/unit/config/**/*.test.ts',
  'test/unit/mission-protocol/**/*.test.ts',
  'test/unit/mcp/**/*.test.ts',
  'test/unit/ralph-external/**/*.test.ts',
  'test/unit/ralph-external/**/*.test.mjs',
];
export const REPORT_PARENT = 'test-results/orchestration-changed-coverage';

export function classifyChangedFile(file) {
  const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').includes('..')) return null;
  if (![...SOURCE_EXTENSIONS].some(extension => normalized.endsWith(extension))) return null;
  if (/(^|\/)(test|tests|__tests__)\//.test(normalized)
    || /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(normalized)) return null;
  if (VALIDATOR_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'validators';
  if (ADAPTER_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'adapters-recovery';
  return null;
}

export function splitChangedFiles(files) {
  const buckets = { validators: [], 'adapters-recovery': [], outOfScope: [] };
  for (const file of [...new Set(files)].sort()) {
    buckets[classifyChangedFile(file) ?? 'outOfScope'].push(file);
  }
  return buckets;
}

export function gitLines(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
}

export function resolveMergeBase(runGit = gitLines, env = process.env) {
  if (env.ORCHESTRATION_COVERAGE_BASE?.trim()) return env.ORCHESTRATION_COVERAGE_BASE.trim();
  const head = runGit(['rev-parse', 'HEAD'])?.[0];
  for (const ref of ['origin/main', 'main', 'master']) {
    const base = runGit(['merge-base', 'HEAD', ref])?.[0];
    // On main itself the merge base is HEAD, which would diff to nothing.
    if (base && base !== head) return base;
  }
  // Post-merge CI on main: the change under test is HEAD against its first parent.
  return runGit(['rev-parse', '--verify', 'HEAD^1'])?.[0] ?? null;
}

export function listChangedFiles(base, runGit = gitLines) {
  const tracked = runGit(['diff', '--name-only', '--no-renames', base]) ?? [];
  const untracked = runGit(['ls-files', '--others', '--exclude-standard']) ?? [];
  return [...new Set([...tracked, ...untracked].map(line => String(line).trim()).filter(Boolean))].sort();
}

export function bucketConfig(bucket, files) {
  return {
    thresholds: bucket === 'validators' ? VALIDATOR_THRESHOLDS : ADAPTER_THRESHOLDS,
    include: files,
    reportsDirectory: `${REPORT_PARENT}/${bucket}`,
  };
}

function runVitestBucket(bucket, files) {
  const { thresholds, reportsDirectory } = bucketConfig(bucket, files);
  fs.mkdirSync(path.join(root, REPORT_PARENT), { recursive: true });
  const configPath = path.join(root, REPORT_PARENT, `${bucket}.config.mjs`);
  fs.writeFileSync(configPath, `import base from ${JSON.stringify('../../config/vitest.config.js')};
export default { ...base, test: { ...base.test, include: ${JSON.stringify(FOCUSED_TESTS)},
  coverage: { enabled: true, provider: 'v8', include: ${JSON.stringify(files)},
    exclude: ['test/**'], reporter: ['text', 'json-summary'],
    reportsDirectory: ${JSON.stringify(reportsDirectory)},
    thresholds: { perFile: true, ...${JSON.stringify(thresholds)} } } } };
`);
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath], {
    cwd: root, encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  for (const [stream, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    if (text) process[stream].write(text);
  }
  if (result.error || result.signal || result.status !== 0) {
    console.error(`orchestration-changed-coverage: ${bucket} bucket failed (${files.length} changed files)`);
    return 1;
  }
  console.log(`orchestration-changed-coverage: ${bucket} bucket passed (${files.length} changed files)`);
  return 0;
}

export function runGate({ base, runGit = gitLines, env = process.env } = {}) {
  const baseline = base ?? resolveMergeBase(runGit, env);
  if (!baseline) {
    // CI must never pass this gate vacuously (a shallow clone has no parent to diff against).
    if (env.CI) {
      console.error('orchestration-changed-coverage: no baseline ref available in CI; fetch at least the parent commit');
      return 1;
    }
    console.log('orchestration-changed-coverage: no baseline ref available; skipping changed-file gate');
    return 0;
  }
  const { validators, 'adapters-recovery': adapters, outOfScope } = splitChangedFiles(listChangedFiles(baseline, runGit));
  console.log(`orchestration-changed-coverage: base ${baseline}, ${validators.length} validator, ${adapters.length} adapter/recovery, ${outOfScope.length} out-of-scope changed files`);
  if (!validators.length && !adapters.length) {
    console.log('orchestration-changed-coverage: no changed files in scope; gate passes');
    return 0;
  }
  if (validators.length && runVitestBucket('validators', validators)) return 1;
  if (adapters.length && runVitestBucket('adapters-recovery', adapters)) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf('--base');
  process.exitCode = runGate(flag >= 0 ? { base: process.argv[flag + 1] } : {});
}
