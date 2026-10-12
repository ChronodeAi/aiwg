import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const writer = 'cat > "$1" && chmod 755 "$1"';
const timeout = 10_000;

// A child that fails before reading its input closes the pipe, so the parent
// also sees EPIPE. The exit status is the cause; report it instead.
/** @param {unknown} error @param {number | null} code @param {NodeJS.Signals | null} signal */
const describeFailure = (error, code, signal) => {
  const brokenPipe = /** @type {NodeJS.ErrnoException | undefined} */ (error)?.code === 'EPIPE';
  if (error && !(brokenPipe && code)) return /** @type {Error} */ (error).message;
  return `exit ${code}, signal ${signal}`;
};

// In Vitest's thread pool, a concurrent fork can inherit any writable file
// descriptor in this process. Keep executable writes entirely in a child so
// those inherited descriptors cannot make a later exec fail with ETXTBSY.
/** @param {string} path @param {string} content @returns {Promise<void>} */
export async function writeExecutable(path, content) {
  if (process.platform === 'win32') {
    await writeFile(path, content, { mode: 0o755 });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', writer, 'sh', path], {
      stdio: ['pipe', 'ignore', 'pipe'], timeout, killSignal: 'SIGKILL',
    });
    let stderr = '';
    /** @type {Error | undefined} */
    let failure;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ??= error; });
    child.on('close', (code, signal) => {
      if (failure || code !== 0) {
        reject(new Error(`Cannot write executable ${JSON.stringify(path)}: ${describeFailure(failure, code, signal)} ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
    child.stdin.end(content);
  });
}

/** @param {string} path @param {string} content @returns {void} */
export function writeExecutableSync(path, content) {
  if (process.platform === 'win32') {
    writeFileSync(path, content, { mode: 0o755 });
    return;
  }
  const result = spawnSync('/bin/sh', ['-c', writer, 'sh', path], {
    input: content, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot write executable ${JSON.stringify(path)}: ${describeFailure(result.error, result.status, result.signal)} ${result.stderr?.trim() ?? ''}`);
  }
}
