// Collect declared local-only inputs and refuse explicit conductor tool references before execution.
import { realpathSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';

// Literal project-relative files or directory subtrees; no globs, traversal or rule syntax.
export const LOCAL_ONLY_PATH_PATTERN = '^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9_.@+,-]+(?:/[A-Za-z0-9_.@+,-]+)*$(?![\\s\\S])';
export const validLocalOnlyPath = value => typeof value === 'string' && new RegExp(LOCAL_ONLY_PATH_PATTERN).test(value);

export function collectLocalOnlyPaths(policy, parallelism) {
  const policies = [policy?.dataPolicy, ...Object.values(policy?.dataClasses ?? {}),
    ...Object.values(parallelism?.groupTemplates ?? {}).map(group => group.dataPolicy),
    ...Object.values(parallelism?.groups ?? {}).map(group => group.dataPolicy)];
  const paths = policies.flatMap(data => data?.localOnlyPaths ?? []);
  if (!paths.every(validLocalOnlyPath)) throw new Error('Invalid dataPolicy.localOnlyPaths: expected literal project-relative paths');
  return [...new Set(paths)].sort();
}

// Resolve existing symlink ancestors without opening file contents (also handles absent leaves).
function canonical(file) {
  try { return realpathSync(file); } catch {
    const parent = dirname(file);
    return parent === file ? file : resolve(canonical(parent), relative(parent, file));
  }
}
const contains = (base, file) => file === base || file.startsWith(base + sep);

export function conductorToolDenial(event, root, paths) {
  const input = event.tool_input ?? {};
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : root;
  const protectedPaths = paths.flatMap(file => [resolve(root, file), canonical(resolve(root, file))]);
  const denied = candidate => {
    if (typeof candidate !== 'string' || !candidate) return false;
    const file = resolve(cwd, candidate);
    return protectedPaths.some(base => contains(base, file) || contains(base, canonical(file)));
  };
  if ([input.file_path, input.path].some(denied)) return 'AIWG: local-only task input is unavailable to this conductor';
  if (typeof input.command === 'string') {
    // Covers literal/quoted paths, compound commands and common redirections. This is
    // deliberately conservative, not a shell interpreter or a filesystem sandbox.
    const command = input.command;
    const tokens = command.match(/[^\s"'`;&|<>()]+/g) ?? [];
    if (paths.some(file => command.includes(file)) || tokens.some(token => denied(token) || denied(token.split('=').at(-1)))) {
      return 'AIWG: command references a local-only task input';
    }
  }
  return null;
}

export function runConductorDataHook(root, paths) {
  try {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('oversized event');
    const event = JSON.parse(raw);
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string'
      || !event.tool_input || typeof event.tool_input !== 'object') throw new Error('invalid event');
    const reason = conductorToolDenial(event, root, paths);
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }) + '\n');
  } catch {
    process.stderr.write('AIWG local-only guard: refusing malformed tool event\n');
    process.exitCode = 2;
  }
}
