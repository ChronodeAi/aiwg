/**
 * Code-shape gate configuration (`.aiwg/quality/gate.json`), glob matching and file discovery.
 *
 * When a base ref is given, the gate is always judged by the config at that ref: the
 * candidate change cannot loosen the evaluator that judges it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { git, gitLines, readFileAtRef } from './git.mjs';
import { hasLizardExtension } from './lizard.mjs';

export { readFileAtRef };

export const GATE_CONFIG_PATH = '.aiwg/quality/gate.json';

export const BOOTSTRAP_MESSAGE = [
  'no .aiwg/quality/gate.json. Bootstrap: (1) ADR adopting code-shape gates → merge;',
  '(2) aiwg run skill codebase-health -- --calibrate --write;',
  "(3) commit gate.json alone with trailer 'Evaluator-Change: ADR-NNN';",
  '(4) CI step from templates/deployment/code-shape-gate.*.yml',
].join(' ');

const emptyBand = () => ({ p70: 0, p80: 0, p90: 0 });

export function defaultGateConfig() {
  return {
    version: 1,
    calibration: { tool: 'lizard', tool_version: '', date: '', commit: '', functions: 0, files: 0, provisional: true },
    include: [],
    exclude: [
      '**/test/**', '**/tests/**', '**/*.test.*', '**/*.spec.*', '**/node_modules/**',
      '**/dist/**', '**/vendor/**', '**/build/**', '**/.aiwg/**',
    ],
    bands: { function_nloc: emptyBand(), function_ccn: emptyBand(), file_loc: emptyBand() },
    benchmark: { function_ccn: { moderate: 6, high: 8, very_high: 14 } },
    contracts: { command: null, frozen_edges_file: null, frozen_edge_regex: null },
    suppressions: {
      patterns: [
        '#\\s*noqa', '#\\s*type:\\s*ignore', 'eslint-disable', '@ts-ignore', '@ts-expect-error',
        '#\\s*pragma:\\s*no cover', '//\\s*nolint', '#\\s*pylint:\\s*disable',
      ],
      unused_command: null,
    },
    evaluator_surfaces: [
      '.aiwg/quality/**', '.aiwg/gates/abm-baseline.json', '.github/workflows/**', '.gitea/workflows/**', 'CODEOWNERS',
      '.github/CODEOWNERS', '.importlinter', '.dependency-cruiser.*', 'eslint.config.*', '.eslintrc*',
      'ruff.toml', 'pyproject.toml', 'setup.cfg', 'mypy.ini', 'tsconfig*.json', 'biome.json*',
    ],
    quality_commands: ['lint-imports', 'depcruise', 'codebase-health'],
    history: { window_commits: 500, max_files_per_commit: 50, min_cochange: 5, min_confidence: 0.5, min_commits: 50 },
  };
}

const KNOWN_KEYS = new Set(Object.keys(defaultGateConfig()));

/** Parse gate.json text: unknown top-level keys are an error; missing sections take defaults. */
export function parseGateConfig(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('gate.json: top level must be an object');
  }
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`gate.json: unknown key ${key}`);
  }
  const defaults = defaultGateConfig();
  const merged = { ...defaults, ...parsed };
  for (const key of ['calibration', 'contracts', 'suppressions', 'history', 'benchmark']) {
    merged[key] = { ...defaults[key], ...(parsed[key] || {}) };
  }
  merged.bands = { ...defaults.bands };
  for (const [metric, band] of Object.entries(parsed.bands || {})) {
    merged.bands[metric] = { ...emptyBand(), ...band };
  }
  return merged;
}

/** Load gate.json from `ref` (git show) or the working tree; null when absent. */
export function loadGateConfig(root, { ref } = {}) {
  let text;
  if (ref) {
    text = readFileAtRef(root, ref, GATE_CONFIG_PATH);
  } else {
    const file = path.join(root, GATE_CONFIG_PATH);
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  return text === null ? null : parseGateConfig(text);
}

/** Convert a glob (`**`, `*`, `?`) into an anchored, `/`-aware RegExp. */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();

export function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => {
    if (!pattern) return false;
    let re = globCache.get(pattern);
    if (!re) {
      re = globToRegExp(pattern);
      globCache.set(pattern, re);
    }
    return re.test(filePath);
  });
}

/** Whether `filePath` is measured under the config's include/exclude and lizard's languages. */
export function isMeasured(filePath, cfg) {
  if (!hasLizardExtension(filePath)) return false;
  if (cfg.include.length > 0 && !matchesAny(filePath, cfg.include)) return false;
  return !matchesAny(filePath, cfg.exclude);
}

/** Tracked files (at `ref` when given) filtered by extension, include and exclude. */
export function discoverFiles(root, cfg, { ref } = {}) {
  const files = ref
    ? gitLines(root, ['ls-tree', '-r', '--name-only', ref])
    : gitLines(root, ['ls-files']);
  return files.filter((file) => isMeasured(file, cfg));
}

export function writeGateConfig(root, cfg) {
  const file = path.join(root, GATE_CONFIG_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

export function isGitIgnored(root, relPath) {
  return git(root, ['check-ignore', '-q', relPath], { allowFail: true }) !== null;
}
