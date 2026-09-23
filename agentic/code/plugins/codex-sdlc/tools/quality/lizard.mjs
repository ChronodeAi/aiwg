/**
 * lizard adapter: parses `lizard --csv` output into per-function metrics.
 *
 * Dependency-free (node:* only) so it runs inside packaged plugins.
 */

import { spawnSync } from 'node:child_process';

export const LIZARD_EXTENSIONS = [
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.cs', '.kt', '.swift', '.rb', '.php', '.scala', '.m',
];

const BATCH_SIZE = 200;
const INSTALL_HINT = 'lizard not found. Install: pipx install lizard  (or: python3 -m pip install lizard)';

export function hasLizardExtension(file) {
  const dot = file.lastIndexOf('.');
  return dot >= 0 && LIZARD_EXTENSIONS.includes(file.slice(dot).toLowerCase());
}

/** Physical line count of a file's text. */
export function fileLoc(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Split one CSV record; lizard double-quotes text fields and replaces embedded `"` with `'`. */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

/**
 * Parse `lizard --csv` output. Columns (no header unless -V):
 * NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end
 */
export function parseLizardCsv(text) {
  const functions = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('NLOC,')) continue;
    const f = splitCsvLine(line);
    if (f.length < 11) continue;
    const [nloc, ccn, , params] = f.slice(0, 4).map(Number);
    if (!Number.isFinite(nloc) || !Number.isFinite(ccn)) continue;
    functions.push({
      file: f[6],
      name: f[7],
      longName: f[8],
      startLine: Number(f[9]),
      endLine: Number(f[10]),
      nloc,
      ccn,
      params,
    });
  }
  return functions;
}

function spawnLizard(args, cwd) {
  const direct = spawnSync('lizard', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (!direct.error) return direct;
  if (direct.error.code !== 'ENOENT') throw direct.error;
  const viaPython = spawnSync('python3', ['-m', 'lizard', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (viaPython.error?.code === 'ENOENT' || (viaPython.status !== 0 && /No module named lizard/.test(viaPython.stderr))) {
    throw new Error(INSTALL_HINT);
  }
  if (viaPython.error) throw viaPython.error;
  return viaPython;
}

/** Run lizard over `files` (paths relative to `cwd`); returns FunctionMetric[]. */
export function runLizard(files, { cwd = process.cwd() } = {}) {
  const functions = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const result = spawnLizard(['--csv', ...files.slice(i, i + BATCH_SIZE)], cwd);
    if (result.status !== 0 && !result.stdout) {
      throw new Error(`lizard failed (exit ${result.status}): ${result.stderr.trim()}`);
    }
    functions.push(...parseLizardCsv(result.stdout));
  }
  return functions;
}

export function lizardVersion() {
  try {
    const result = spawnLizard(['--version'], process.cwd());
    return (result.stdout || '').trim();
  } catch {
    return '';
  }
}
