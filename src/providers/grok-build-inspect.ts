/**
 * Grok Build verification via `grok inspect` when the binary is available.
 * Presence-only remediation when absent — never invents inspect output.
 *
 * @issue #2575
 */

import { spawnSync } from 'node:child_process';

export type GrokInspectResult =
  | {
      status: 'ok';
      binary: string;
      stdout: string;
      parsed: Record<string, unknown> | null;
    }
  | {
      status: 'failed';
      binary: string;
      exitCode: number | null;
      stderr: string;
      stdout: string;
    }
  | {
      status: 'absent';
      remediation: string;
    };

function whichGrok(): string | null {
  const probe = spawnSync('sh', ['-c', 'command -v grok'], {
    encoding: 'utf8',
    env: process.env,
  });
  const path = (probe.stdout || '').trim();
  return probe.status === 0 && path ? path : null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Run `grok inspect` (prefer `--json` when the CLI accepts it).
 * If the binary is missing, return a deterministic absent result.
 */
export function runGrokInspect(env: NodeJS.ProcessEnv = process.env): GrokInspectResult {
  const binary = whichGrok();
  if (!binary) {
    return {
      status: 'absent',
      remediation:
        'Install the Grok Build CLI so `grok` is on PATH, then re-run verification. '
        + 'Until then AIWG only confirms provider registration and on-disk .grok paths — it does not invent inspect output.',
    };
  }

  // Prefer machine-readable inspect; fall back to plain inspect if --json is rejected.
  for (const args of [['inspect', '--json'], ['inspect']] as const) {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      env,
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'absent',
        remediation:
          'Install the Grok Build CLI so `grok` is on PATH, then re-run verification. '
          + 'Until then AIWG only confirms provider registration and on-disk .grok paths — it does not invent inspect output.',
      };
    }
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    if (result.status === 0) {
      return {
        status: 'ok',
        binary,
        stdout,
        parsed: tryParseJson(stdout),
      };
    }
    // If --json failed, try the next arg set; otherwise report failure.
    if (args.includes('--json') && /unknown|unrecognized|invalid/i.test(`${stderr}\n${stdout}`)) {
      continue;
    }
    return {
      status: 'failed',
      binary,
      exitCode: result.status,
      stderr,
      stdout,
    };
  }

  return {
    status: 'failed',
    binary,
    exitCode: null,
    stderr: 'grok inspect did not succeed',
    stdout: '',
  };
}
