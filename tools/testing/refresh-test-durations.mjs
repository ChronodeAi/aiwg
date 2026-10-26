#!/usr/bin/env node
/** Refresh durations from Vitest JSON reports, retaining entries from other shards. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { durationMapPath, readDurations, validateDurations } from './duration-sequencer.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function refreshDurations(reports, { root = repositoryRoot, previous = { defaultSeconds: 1, files: {} } } = {}) {
  validateDurations(previous);
  const files = { ...previous.files };
  let measured = 0;
  for (const report of reports) {
    if (!Array.isArray(report?.testResults) || !report.testResults.length) {
      throw new Error('Expected a nonempty Vitest JSON testResults array');
    }
    for (const result of report.testResults) {
      const milliseconds = result.durationSeconds === undefined
        ? result.endTime - result.startTime : result.durationSeconds * 1000;
      const validTime = result.durationSeconds === undefined
        ? Number.isFinite(result.startTime) && Number.isFinite(result.endTime)
        : Number.isFinite(result.durationSeconds);
      if (typeof result.name !== 'string' || !validTime || milliseconds < 0) {
        throw new Error('Each file needs a name and valid durationSeconds or startTime/endTime');
      }
      const file = path.relative(root, path.resolve(root, result.name)).split(path.sep).join('/');
      if (!file || file.startsWith('../') || path.isAbsolute(file)) {
        throw new Error(`Test file is outside the repository: ${result.name}`);
      }
      // Prefer this module's reporter, including imports, setup and all hooks.
      // Stock JSON excludes imports, setup and leading/trailing suite hooks.
      files[file] = Math.max(0.001, Math.round(milliseconds) / 1000);
      measured++;
    }
  }
  if (!measured) throw new Error('No file durations measured');
  return validateDurations({
    defaultSeconds: previous.defaultSeconds,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  });
}

// Optional Vitest reporter: use alongside "default" and/or "json". The three
// sequential phases include module imports, setup and tests with all hooks.
export default class FileDurationReporter {
  constructor({ outputFile = 'test-results/file-durations.json' } = {}) {
    this.outputFile = outputFile;
    this.root = repositoryRoot;
  }

  onInit(ctx) {
    this.root = ctx.config.root;
  }

  onTestRunEnd(modules) {
    const report = { testResults: modules.map(module => {
      const diagnostic = module.diagnostic();
      return {
        name: path.relative(this.root, module.moduleId).split(path.sep).join('/'),
        durationSeconds: ((diagnostic.duration ?? 0) + (diagnostic.collectDuration ?? 0)
          + (diagnostic.setupDuration ?? 0)) / 1000,
      };
    }) };
    const destination = path.resolve(this.root, this.outputFile);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sources = process.argv.slice(2);
    if (!sources.length) throw new Error('Usage: refresh-test-durations.mjs <vitest-report.json> [more-reports.json ...]');
    const durations = refreshDurations(sources.map(source => JSON.parse(readFileSync(source, 'utf8'))), {
      previous: readDurations(),
    });
    writeFileSync(durationMapPath, `${JSON.stringify(durations, null, 2)}\n`);
    console.log(`Updated ${Object.keys(durations.files).length} file durations in config/test-durations.json`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
