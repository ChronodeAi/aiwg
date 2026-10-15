/**
 * Script Runner
 *
 * Utility for running framework scripts from handlers.
 * Script execution utility for CLI handlers.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @source @src/cli/router.ts
 * @issue #33
 */

import { spawn } from 'child_process';
import path from 'path';
import { HandlerResult, ScriptRunner, ScriptRunnerOptions } from './types.js';

/**
 * Default script runner implementation
 *
 * Delegates command execution to existing Node.js scripts.
 */
export class DefaultScriptRunner implements ScriptRunner {
  constructor(private frameworkRoot: string) {}

  /**
   * Run a Node.js script from the framework
   *
   * @param scriptPath - Relative path to script from framework root
   * @param args - Arguments to pass to script
   * @param options - Execution options
   */
  async run(
    scriptPath: string,
    args: string[] = [],
    options: ScriptRunnerOptions = {}
  ): Promise<HandlerResult> {
    const fullPath = path.join(this.frameworkRoot, scriptPath);

    return new Promise((resolve) => {
      // When capture mode is enabled, stdout/stderr are piped so that
      // quiet-mode callers can suppress output. When not
      // capturing, stdio: 'inherit' lets subprocess output flow directly to
      // the terminal (verbose mode).
      const stdio = options.capture ? 'pipe' as const : 'inherit' as const;
      const child = spawn('node', [fullPath, ...args], {
        stdio,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
      });

      // Always drain captured pipes, even after the diagnostic cap is reached.
      // stdout is not part of HandlerResult; discard it. Retain only the first
      // 1 MiB of stderr for failure messages, discarding any excess.
      child.stdout?.resume();
      const stderrLimit = 1024 * 1024;
      const capturedStderr: Buffer[] = [];
      let capturedStderrBytes = 0;
      if (options.capture && child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const retained = data.subarray(0, stderrLimit - capturedStderrBytes);
          if (retained.length > 0) {
            capturedStderr.push(Buffer.from(retained));
            capturedStderrBytes += retained.length;
          }
        });
      }

      const timeout = options.timeout;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let killEscalationId: ReturnType<typeof setTimeout> | undefined;
      // Hard deadline for a well-behaved child to respond to SIGTERM before we
      // escalate to SIGKILL. Prevents a stuck child from outliving the CLI and
      // masking a timeout as a hang. Overridable via AIWG_SIGKILL_DEADLINE_MS.
      const killDeadlineMs = (() => {
        const raw = process.env['AIWG_SIGKILL_DEADLINE_MS'];
        const n = raw ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 10_000;
      })();

      if (timeout) {
        timeoutId = setTimeout(() => {
          // Request graceful termination first, then escalate if the child
          // does not exit within the deadline. Both kill() calls are wrapped
          // because they can throw ESRCH on an already-exited child.
          try { child.kill('SIGTERM'); } catch { /* already exited */ }
          killEscalationId = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
          }, killDeadlineMs);
          killEscalationId.unref?.();
          resolve({
            exitCode: 124,
            message: `Script timed out after ${timeout}ms`,
            error: new Error(`Timeout after ${timeout}ms (child sent SIGTERM, SIGKILL after ${killDeadlineMs}ms)`),
          });
        }, timeout);
      }

      child.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (killEscalationId) clearTimeout(killEscalationId);
        // On failure in capture mode, surface the captured stderr
        if (options.capture && code !== 0 && capturedStderrBytes > 0) {
          resolve({
            exitCode: code ?? 1,
            message: Buffer.concat(capturedStderr).toString().trim(),
          });
        } else {
          resolve({
            exitCode: code ?? 0,
          });
        }
      });

      child.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (killEscalationId) clearTimeout(killEscalationId);
        resolve({
          exitCode: 1,
          message: `Script error: ${err.message}`,
          error: err,
        });
      });
    });
  }
}

/**
 * Create a script runner for the given framework root
 */
export function createScriptRunner(frameworkRoot: string): ScriptRunner {
  return new DefaultScriptRunner(frameworkRoot);
}
