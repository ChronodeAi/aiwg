// Expose the installed trusted verifier through the existing worker-run CLI.
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { boundedPrivateRead } from './worker-inputs.mjs';
import { verifyRetryPredecessor } from '../session-launcher.mjs';
import { verifyWorkerArtifact } from './trusted-verification.mjs';
import { missingRequiredCapabilities, probeVerificationIsolationCapabilities } from './verification-isolation.mjs';

const usage = 'Usage: ralph-external --verify-worker --run-dir ABS_DIR --check JSON [--check JSON] [--artifact ABS_FILE] [--check-descendants] [--json]';
const checkKeys = new Set(['id', 'command', 'args', 'cwd', 'envNames', 'timeoutMs']);
const absolute = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0');

export function parseWorkerVerificationArgs(args) {
  const result = { checks: [], json: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--check' && seen.has(flag)) throw new Error(`Duplicate verification option: ${flag}`);
    seen.add(flag);
    if (flag === '--verify-worker') continue;
    if (flag === '--check-descendants') { result.checkDescendants = true; continue; }
    if (flag === '--json') { result.json = true; continue; }
    if (!['--run-dir', '--artifact', '--check'].includes(flag)) throw new Error(`Unsupported verification option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag !== '--check') {
      if (!absolute(value)) throw new Error(`${flag} requires an absolute NUL-free path`);
      result[flag === '--run-dir' ? 'runDir' : 'artifactPath'] = value;
      continue;
    }
    if (Buffer.byteLength(value) > 65536 || result.checks.length >= 32) throw new Error('Protected check input exceeds bounds');
    const check = JSON.parse(value);
    if (!check || Array.isArray(check) || typeof check !== 'object' || Object.keys(check).some(key => !checkKeys.has(key))
      || typeof check.id !== 'string' || !check.id || result.checks.some(entry => entry.id === check.id)
      || !absolute(check.command) || check.args !== undefined && (!Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
      || check.cwd !== undefined && !absolute(check.cwd)
      || check.envNames !== undefined && (!Array.isArray(check.envNames) || check.envNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
      || check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > 86400000)) {
      throw new Error('Invalid protected check: require a unique id, absolute command, and optional args/cwd/envNames/timeoutMs; isolation overrides are forbidden');
    }
    result.checks.push(check);
  }
  if (!seen.has('--verify-worker') || !result.runDir || !result.checks.length) throw new Error(usage);
  return result;
}

export async function verifyWorkerRun({ runDir, checks, artifactPath, checkDescendants = false }) {
  const { inspectWorkerPath: inspect } = await importImpl(import.meta.url, 'serve/worker-invocation-paths.js');
  const record = JSON.parse((await boundedPrivateRead(join(runDir, 'invocation.json'), 1048576, inspect, true, true)).toString('utf8'));
  const worktreeRoot = record.worktree?.path;
  artifactPath ??= record.paths?.final;
  if (!absolute(worktreeRoot) || !absolute(artifactPath)) throw new Error('Launcher record requires absolute worktree and artifact paths');
  // Independently loaded installed qualifications own writable roots; the record
  // being authenticated cannot declare the only roots used to authenticate it.
  const { loadWorkerInputs } = await importImpl(import.meta.url, 'cli/handlers/models.js');
  const inputs = await loadWorkerInputs({ cwd: process.cwd(), args: [], rawArgs: [],
    frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)) });
  const writableRoots = Object.values(inputs.drivers).flatMap(driver => driver.qualification.installation?.workerWritableRoots ?? []);
  if (!writableRoots.length) throw new Error('Trusted worker installation writable roots are required; run verification from the configured conductor project');
  // Reuse the launcher's owned-record and confirmed-stop checks. Never run checks
  // concurrently with a worker, or read check definitions out of worker metadata.
  await verifyRetryPredecessor({ runDir, invocationId: record.invocationId }, { inspect, workerWritableRoots: [worktreeRoot, ...writableRoots], checkDescendants });
  const capabilities = probeVerificationIsolationCapabilities();
  const missing = missingRequiredCapabilities(capabilities);
  const runnerRef = new URL('./trusted-verification.mjs', import.meta.url).href;
  if (capabilities.mode !== 'systemd-unit' || missing.length) {
    return { status: 'blocked', verifierId: 'trusted-verification@1', runnerRef, artifactDigest: null, evidence: [],
      findings: [`ISOLATION_UNAVAILABLE: required verification isolation is unavailable (${missing.join(', ')}); use a host with enforced write/home/network confinement`],
      controlledContext: 'protected checks refused before execution', isolation: { mode: capabilities.mode, degraded: capabilities.degraded }, errorCode: 'ISOLATION_UNAVAILABLE' };
  }
  // CLI arguments are conductor-owned protected definitions. Register exactly
  // their binaries, never a manifest, PATH search, directory or worker claim.
  return verifyWorkerArtifact({ worktreeRoot, artifactPath, checks,
    allowedCheckBinaries: checks.map(check => check.command), runnerRef });
}

export async function runWorkerVerificationCli(args, { stdout = console.log, stderr = console.error } = {}) {
  let result;
  try {
    result = await verifyWorkerRun(parseWorkerVerificationArgs(args));
  } catch (error) {
    result = { status: 'rejected', verifierId: 'trusted-verification@1', runnerRef: new URL('./trusted-verification.mjs', import.meta.url).href,
      artifactDigest: null, evidence: [], findings: [error.message], errorCode: 'VERIFICATION_REQUEST_FAILED',
      controlledContext: 'verification request refused', isolation: { mode: 'n/a', degraded: [] } };
  }
  const exitCode = result.status === 'accepted' ? 0 : result.status === 'blocked' ? 2 : 1;
  const output = { version: 1, kind: 'worker-verification', ...result, exitCode };
  if (args.includes('--json')) stdout(JSON.stringify(output));
  else {
    stdout(`Worker verification: ${result.status}`);
    for (const finding of result.findings) stdout(finding);
  }
  if (exitCode) stderr(`Worker verification ${result.status}: ${result.errorCode ?? result.findings.join('; ')}`);
  return exitCode;
}
