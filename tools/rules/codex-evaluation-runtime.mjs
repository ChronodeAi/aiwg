// Shared, explicit Codex CLI transport. Importing this module performs no inference.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProcess } from 'node:child_process';
import { parseTrace } from './run-rule-probes.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'AIWG_ROOT', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH'];
const WRITABLE_ENV_KEYS = ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH'];
const RUNTIME_FILES = new Set(['.sandbox_migration', 'installation_id', 'models_cache.json']);
const RUNTIME_DATABASE = /^(?:goals_1|logs_2|memories_1|queue_1|state_5)\.sqlite(?:-(?:shm|wal))?$/;
const DIAGNOSTIC_BYTES = 1024 * 1024;

function boundedText(value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  if (bytes.length <= DIAGNOSTIC_BYTES) return { text: bytes.toString('utf8'), bytes: bytes.length, truncated: false };
  return { text: bytes.subarray(0, DIAGNOSTIC_BYTES).toString('utf8'), bytes: bytes.length, truncated: true };
}
function withDiagnostic(error, result, phase) {
  if (error?.diagnostic) return error;
  const stdout = boundedText(result?.stdout), stderr = boundedText(result?.stderr);
  let trace = null;
  if (!stdout.truncated && stdout.text.trim()) {
    try { trace = parseTrace(stdout.text, 'codex'); } catch { /* Retain raw bounded streams when the trace is incomplete. */ }
  }
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.diagnostic = { schema: 'aiwg-codex-evaluation-failure/v1', phase,
    status: Number.isInteger(result?.status) ? result.status : null, stdout, stderr, trace };
  return wrapped;
}

// Own the process group so timeouts terminate Codex and ordinary descendants.
export function runCodex(executable, args, _tier, options) {
  if (process.platform === 'win32') throw new Error('Codex comparison requires POSIX process-group isolation');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let size = 0, stdout = '', stderr = '', finished = false, failure = null, grace;
    const timer = setTimeout(() => stop(new Error('Codex execution timed out')), options.timeout);
    const stop = error => {
      if (finished || failure) return;
      failure = error; clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process exited */ }
      grace = setTimeout(() => {
        if (finished) return; finished = true;
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(withDiagnostic(new Error('Could not confirm Codex process-group exit after SIGKILL'), { stdout, stderr }, 'transport'));
      }, 3000);
    };
    child.on('error', () => stop(new Error('Codex process failed to start')));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > options.maxBuffer) return stop(new Error('Codex output exceeded the limit'));
      if (stream === child.stdout) stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) stop(new Error('Codex stdin failed')); });
    child.stdin.end(options.input);
    child.on('close', status => {
      if (finished) return; clearTimeout(timer);
      if (!failure) { finished = true; resolve({ status, stdout, stderr }); return; }
      // close establishes direct-child exit and closed pipes. Check the owned
      // process group is gone before reporting a successful termination.
      const confirm = () => {
        if (finished) return;
        try { process.kill(-child.pid, 0); setTimeout(confirm, 25); }
        catch (error) {
          if (error.code !== 'ESRCH') return;
          finished = true; clearTimeout(grace); reject(withDiagnostic(failure, { status, stdout, stderr }, 'transport'));
        }
      };
      confirm();
    });
  });
}
// Caller supplies an isolated environment and a separately located existing account.
export async function runCodexEvaluation({ cwd, prompt, model, effort, accountHome, executable: supplied, envOverrideAllowed: env, spawn = runCodex }) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw new Error('A pinned Codex model identifier is required');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A prompt is required');
  if (!EFFORTS.has(effort)) throw new Error('A supported explicit effort is required');
  if (!supplied || !path.isAbsolute(supplied)) throw new Error('An absolute Codex executable is required');
  const executable = fs.realpathSync(supplied);
  if (!fs.statSync(executable).isFile()) throw new Error('Codex executable must be a regular file');
  for (const key of ['HOME', 'TMPDIR']) if (!env?.[key] || !path.isAbsolute(env[key])) throw new Error(`Missing isolated ${key}`);
  if (!path.isAbsolute(cwd)) throw new Error('An absolute fixture working directory is required');
  if (!path.isAbsolute(accountHome ?? '')) throw new Error('Explicit account-home authentication is required');
  const account = fs.realpathSync(accountHome);
  if (!fs.statSync(account).isDirectory() || account === '/' || (fs.statSync(account).mode & 0o077) !== 0 || (process.getuid && fs.statSync(account).uid !== process.getuid())) throw new Error('Account home must be private');
  const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  const authPath = path.join(account, 'auth.json');
  const authStat = fs.lstatSync(authPath);
  const authTarget = env.AIWG_RELEASE_CODEX_AUTH_TARGET;
  let authRoot = account;
  if (authStat.isSymbolicLink()) {
    if (!authTarget || !path.isAbsolute(authTarget) || fs.realpathSync(authPath) !== fs.realpathSync(authTarget)) throw new Error('Account auth symlink requires the explicit matching canonical target');
    const target = fs.realpathSync(authTarget), stat = fs.statSync(target);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Canonical auth target must be a private owned regular file');
    authRoot = path.dirname(target);
    const parent = fs.statSync(authRoot);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) throw new Error('Canonical auth root must be private');
  } else if (!authStat.isFile() || (authStat.mode & 0o077) !== 0 || (process.getuid && authStat.uid !== process.getuid()) || authTarget) {
    throw new Error('Account home must contain only a regular auth.json or explicitly declared symlink');
  }
  const isolationRoot = fs.realpathSync(path.dirname(env.HOME));
  for (const root of [account, authRoot]) if (within(root, isolationRoot) || within(isolationRoot, root)) throw new Error('Account home and canonical auth root must be separate from the fixture');
  if ([account, authRoot].some(root => within(root, executable))) throw new Error('Codex executable must be outside denied account and canonical auth roots');
  const inventory = root => {
    const found = [];
    const visit = (dir, relative = '') => {
      for (const name of fs.readdirSync(dir).sort()) {
        const rel = path.join(relative, name), entry = path.join(dir, name), stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) throw new Error('System skill inventory cannot contain symlinks');
        if (stat.isDirectory()) { found.push([rel, 'directory']); visit(entry, rel); }
        else if (stat.isFile()) found.push([rel, 'file', hash(fs.readFileSync(entry))]);
        else throw new Error('System skill inventory contains an unexpected file type');
      }
    };
    visit(root); return JSON.stringify(found);
  };
  const skillsReference = env.AIWG_RELEASE_CODEX_SKILLS_REFERENCE;
  let sealedSkills = null;
  if (skillsReference) {
    if (!path.isAbsolute(skillsReference)) throw new Error('System skills reference must be absolute');
    const ref = fs.realpathSync(skillsReference), refStat = fs.lstatSync(skillsReference);
    if (!refStat.isDirectory() || (refStat.mode & 0o077) !== 0 || (process.getuid && refStat.uid !== process.getuid())) throw new Error('System skills reference must be a private owned directory');
    if (!fs.statSync(ref).isDirectory() || within(account, ref) || within(isolationRoot, ref) || within(authRoot, ref)) throw new Error('System skills reference must be a separate directory');
    sealedSkills = inventory(ref);
  }
  const checkAccount = () => {
    const accountNow = fs.statSync(account);
    if (!accountNow.isDirectory() || (accountNow.mode & 0o077) !== 0 || (process.getuid && accountNow.uid !== process.getuid())) throw new Error('Account home must remain private and owned');
    const entries = fs.readdirSync(account);
    for (const entry of entries) {
      if (entry === 'auth.json') continue;
      const target = path.join(account, entry), stat = fs.lstatSync(target);
      const owned = !process.getuid || stat.uid === process.getuid();
      if ((RUNTIME_FILES.has(entry) || RUNTIME_DATABASE.test(entry)) && stat.isFile() && !stat.isSymbolicLink() && owned && (stat.mode & 0o111) === 0) continue;
      if (['tmp', 'shell_snapshots'].includes(entry) && stat.isDirectory() && !stat.isSymbolicLink() && owned) { inventory(target); continue; }
      if (entry === 'skills' && stat.isDirectory() && !stat.isSymbolicLink() && sealedSkills !== null) {
        const children = fs.readdirSync(target);
        if (children.length !== 1 || children[0] !== '.system' || !fs.lstatSync(path.join(target, '.system')).isDirectory() || inventory(path.join(target, '.system')) !== sealedSkills) throw new Error('Account system skills differ from sealed reference');
        continue;
      }
      throw new Error('Account home must contain only a regular auth.json or explicitly declared symlink and qualified runtime state');
    }
    if (authStat.isSymbolicLink()) {
      if (!fs.lstatSync(authPath).isSymbolicLink() || fs.realpathSync(authPath) !== fs.realpathSync(authTarget)) throw new Error('Account auth symlink changed');
      const target = fs.realpathSync(authTarget), targetStat = fs.statSync(target), rootStat = fs.statSync(path.dirname(target));
      if (!targetStat.isFile() || (targetStat.mode & 0o077) !== 0 || (process.getuid && targetStat.uid !== process.getuid())
        || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0 || (process.getuid && rootStat.uid !== process.getuid())) throw new Error('Canonical auth target must remain private and owned');
    } else {
      const current = fs.lstatSync(authPath);
      if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0 || (process.getuid && current.uid !== process.getuid())) throw new Error('Account auth file changed');
    }
  };
  checkAccount();
  const canonical = value => {
    if (!path.isAbsolute(value)) throw new Error('Fixture paths must be absolute');
    let ancestor = value;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Fixture path has no existing ancestor');
      ancestor = parent;
    }
    return path.join(fs.realpathSync(ancestor), path.relative(ancestor, value));
  };
  const realCwd = canonical(cwd);
  if (!fs.statSync(realCwd).isDirectory() || !within(isolationRoot, realCwd)) throw new Error('Working directory must be within fixture isolation root');
  const childEnv = {};
  for (const key of ENV_KEYS.filter(key => key !== 'PATH')) {
    if (typeof env[key] !== 'string') continue;
    const value = canonical(env[key]);
    if (!within(isolationRoot, value)) throw new Error(`Fixture ${key} must be within isolation root`);
    childEnv[key] = value;
  }
  for (const key of ['HOME', 'TMPDIR']) if (!fs.statSync(childEnv[key]).isDirectory()) throw new Error(`Fixture ${key} must be a directory`);
  const writableRoots = [...new Set(WRITABLE_ENV_KEYS.map(key => childEnv[key]).filter(Boolean))];
  const protectedRoots = [realCwd, childEnv.AIWG_ROOT, childEnv.AIWG_HOME, account, authRoot].filter(Boolean);
  for (const writable of writableRoots) {
    if (writable === childEnv.HOME || within(writable, childEnv.HOME)) throw new Error('Writable fixture paths must not include the sample home');
    if (protectedRoots.some(root => within(root, writable) || within(writable, root))) throw new Error('Writable fixture paths must not overlap project, package, or account roots');
    fs.mkdirSync(writable, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(writable);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(writable) !== writable || (process.getuid && stat.uid !== process.getuid())) throw new Error('Writable fixture paths must be owned real directories');
  }
  const trustedHost = new Set(['/usr/bin', '/bin', path.dirname(process.execPath)].map(dir => fs.realpathSync(dir)));
  const pathEntries = [];
  for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(entry) || !fs.existsSync(entry)) continue;
    const value = fs.realpathSync(entry);
    if ([account, authRoot].some(root => within(root, value) || within(value, root) && !trustedHost.has(value))) throw new Error('PATH overlaps account home');
    if (!fs.statSync(value).isDirectory()) throw new Error('PATH entry must be a directory');
    if (within(isolationRoot, value) || trustedHost.has(value)) pathEntries.push(value);
  }
  childEnv.PATH = [...new Set(pathEntries)].join(path.delimiter);
  childEnv.CODEX_HOME = account;
  // Reintroduce only the fixture-specific environment for model-invoked shells.
  const shellEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== 'CODEX_HOME'));
  const shellEnvToml = `{${Object.entries(shellEnv).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
  const finalRoot = fs.mkdtempSync(path.join(env.TMPDIR, 'codex-final-'));
  const finalPath = path.join(finalRoot, 'last-message.txt');
  try {
    const filesystemPermissions = [...new Set([account, authRoot])].map(root => `${JSON.stringify(root)}="deny"`)
      .concat(writableRoots.map(root => `${JSON.stringify(root)}="write"`));
    const args = ['--no-daemon', '--disable', 'apps', '--disable', 'plugins', 'exec', '--json', '--model', model, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-c', 'cli_auth_credentials_store="file"', '-c', 'approval_policy="never"', '-c', 'default_permissions="eval"', '-c', 'permissions.eval.extends=":read-only"', '-c', `permissions.eval.filesystem={${filesystemPermissions.join(',')}}`, '-c', 'shell_environment_policy.inherit="none"', '-c', `shell_environment_policy.set=${shellEnvToml}`, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`, '-o', finalPath, '-'];
    const binaryHash = hash(fs.readFileSync(executable));
    const runtimeHash = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
    const parserHash = hash(fs.readFileSync(fileURLToPath(new URL('./run-rule-probes.mjs', import.meta.url))));
    let result;
    try { result = await spawn(executable, args, 'long', { cwd: realCwd, env: childEnv, input: prompt, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) { throw withDiagnostic(error, error?.diagnostic, 'transport'); }
    try { checkAccount(); }
    catch (error) { throw withDiagnostic(new Error(`Codex account lifecycle validation failed: ${error.message}`), result, 'account-postcheck'); }
    if (result.error || result.status !== 0) throw withDiagnostic(new Error('Codex subject execution failed or timed out'), result, 'execution');
    if (hash(fs.readFileSync(executable)) !== binaryHash || hash(fs.readFileSync(fileURLToPath(import.meta.url))) !== runtimeHash || hash(fs.readFileSync(fileURLToPath(new URL('./run-rule-probes.mjs', import.meta.url)))) !== parserHash) throw withDiagnostic(new Error('Codex executable or runtime changed during execution'), result, 'source-postcheck');
    const stdout = result.stdout;
    if (typeof stdout !== 'string' || !stdout.trim()) throw withDiagnostic(new Error('Codex event stream is empty'), result, 'trace-validation');
    let trace;
    try { trace = parseTrace(stdout, 'codex'); }
    catch (error) { throw withDiagnostic(new Error(`Codex event stream is invalid: ${error.message}`), result, 'trace-validation'); }
    if (!trace.completed || trace.failed || !trace.text.trim() || trace.events.filter(event => event.type === 'turn.completed').length !== 1) throw withDiagnostic(new Error('Codex event stream did not complete successfully'), result, 'trace-validation');
    if (!fs.existsSync(finalPath) || !fs.lstatSync(finalPath).isFile() || fs.readFileSync(finalPath, 'utf8').trim() !== trace.text.trim()) throw withDiagnostic(new Error('Codex final file does not match the JSONL terminal text'), result, 'trace-validation');
    const terminal = trace.events.find(event => event.type === 'turn.completed');
    const usage = terminal.usage && typeof terminal.usage === 'object' ? terminal.usage : null;
    return { status: result.status, stdout, stderr: result.stderr ?? '', trace, usage, executable_sha256: binaryHash, runtime_source_sha256: runtimeHash, trace_parser_sha256: parserHash, argv_sha256: hash(JSON.stringify(args)) };
  } finally { fs.rmSync(finalRoot, { recursive: true, force: true }); }
}
