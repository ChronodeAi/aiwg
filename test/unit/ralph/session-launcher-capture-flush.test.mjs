// Regression test for #2981: SessionLauncher._launchSession resolved on the
// child's 'close' event without waiting for the disk-backed stdout/stderr
// capture streams (createWriteStream) to actually finish flushing. 'close'
// only proves the child's own stdio pipes drained into our 'data' handlers;
// it says nothing about whether fs.WriteStream has flushed its internal
// buffer to disk. Under I/O load this let launch() resolve, and a caller
// read stdoutPath/stderrPath, before the final bytes (e.g. the Pi adapter's
// trailing `agent_settled` JSONL record) had actually landed on disk.
//
// This test forces that race deterministically by monkey-patching
// fs.WriteStream's internal write methods to add an artificial delay, then
// asserts the capture file is complete immediately after launch() resolves.
// It fails against the pre-fix code (resolves on 'close' alone) and passes
// against the fix (awaits the capture streams' 'finish'/error before
// resolving).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WriteStream, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../../tools/ralph-external/lib/pi-adapter.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const stub = resolve(here, '../../fixtures/providers/pi/pi-stub.mjs');
chmodSync(stub, 0o755);

/**
 * Install an artificial delay on every fs.WriteStream disk write, simulating
 * a slow/loaded disk. Returns a restore function. Patches both _write and
 * _writev since Node may coalesce multiple queued chunks into a single
 * _writev call, and either path must be slowed for the race to be forced.
 */
function installSlowDisk(delayMs) {
  const originalWrite = WriteStream.prototype._write;
  const originalWritev = WriteStream.prototype._writev;
  WriteStream.prototype._write = function (chunk, encoding, callback) {
    setTimeout(() => originalWrite.call(this, chunk, encoding, callback), delayMs);
  };
  WriteStream.prototype._writev = function (chunks, callback) {
    setTimeout(() => originalWritev.call(this, chunks, callback), delayMs);
  };
  return () => {
    WriteStream.prototype._write = originalWrite;
    WriteStream.prototype._writev = originalWritev;
  };
}

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('launcher does not hand back stdoutPath until the capture file is fully flushed, even under a slow disk', async () => {
  const restore = installSlowDisk(40);
  const { dir, cleanup } = scratch('session-launcher-flush-');
  const savedPiBin = process.env.AIWG_PI_BIN;
  const savedScenario = process.env.AIWG_PI_STUB_SCENARIO;
  const savedCi = process.env.CI;
  const savedNoColor = process.env.NO_COLOR;
  process.env.AIWG_PI_BIN = stub;
  delete process.env.AIWG_PI_STUB_SCENARIO;
  delete process.env.CI;
  delete process.env.NO_COLOR;
  try {
    const launcher = new SessionLauncher();
    launcher.setProviderAdapter(new PiAdapter());
    const stdoutPath = join(dir, 'stdout.log');
    const stderrPath = join(dir, 'stderr.log');
    const result = await launcher.launch({
      prompt: 'bounded fixture task',
      sessionId: 'aiwg-fixture-session',
      workingDir: dir,
      stdoutPath,
      stderrPath,
    });
    assert.equal(result.exitCode, 0);

    // The assertion that catches the race: read the capture file the instant
    // launch() resolves, with no extra delay of our own. Before the fix this
    // is read while the slowed write stream is still mid-flush, so the file
    // is missing its trailing bytes (truncated mid-record or missing the
    // final agent_settled line). After the fix, launch() does not resolve
    // until the capture stream itself has finished.
    const stdout = readFileSync(stdoutPath, 'utf8');
    const parsed = new PiAdapter().parseOutput(stdout);
    assert.notEqual(parsed, null, 'capture file must be complete, well-formed JSONL when launch() resolves');
    assert.equal(parsed.settled, true, 'the trailing agent_settled record must have reached disk before launch() resolves');
    assert.deepEqual(parsed.events.map(event => event.type), ['session', 'agent_start', 'agent_end', 'agent_settled']);
  } finally {
    restore();
    cleanup();
    if (savedPiBin === undefined) delete process.env.AIWG_PI_BIN; else process.env.AIWG_PI_BIN = savedPiBin;
    if (savedScenario === undefined) delete process.env.AIWG_PI_STUB_SCENARIO; else process.env.AIWG_PI_STUB_SCENARIO = savedScenario;
    if (savedCi === undefined) delete process.env.CI; else process.env.CI = savedCi;
    if (savedNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = savedNoColor;
  }
});

test('launcher rejects instead of crashing when a capture stream fails mid-run', async () => {
  const originalWrite = WriteStream.prototype._write;
  const originalWritev = WriteStream.prototype._writev;
  const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  WriteStream.prototype._write = function (_chunk, _encoding, callback) { callback(failure); };
  WriteStream.prototype._writev = function (_chunks, callback) { callback(failure); };
  const { dir, cleanup } = scratch('session-launcher-capture-error-');
  const savedPiBin = process.env.AIWG_PI_BIN;
  process.env.AIWG_PI_BIN = stub;
  try {
    const launcher = new SessionLauncher();
    launcher.setProviderAdapter(new PiAdapter());
    const errors = [];
    launcher.on('error', (error) => errors.push(error));
    await assert.rejects(
      launcher.launch({
        prompt: 'bounded fixture task',
        sessionId: 'aiwg-fixture-session',
        workingDir: dir,
        stdoutPath: join(dir, 'stdout.log'),
        stderrPath: join(dir, 'stderr.log'),
      }),
      { code: 'ENOSPC' },
    );
    assert.equal(errors.length, 1);
    assert.equal(launcher.currentProcess, null);
  } finally {
    WriteStream.prototype._write = originalWrite;
    WriteStream.prototype._writev = originalWritev;
    cleanup();
    if (savedPiBin === undefined) delete process.env.AIWG_PI_BIN; else process.env.AIWG_PI_BIN = savedPiBin;
  }
});
