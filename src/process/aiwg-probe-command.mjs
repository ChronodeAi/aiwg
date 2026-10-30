// Resolves the aiwg invocation for doctor's discovery self-probes so they
// run the current entrypoint instead of failing when aiwg is not on PATH.
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveAiwgProbeCommand({
  env = process.env,
  argv1 = process.argv[1],
  execPath = process.execPath,
  cwd = process.cwd(),
  packageRoot = null,
} = {}) {
  const override = env?.AIWG_BIN;
  if (typeof override === 'string' && override.length > 0) {
    return { file: override, prefix: [], via: 'aiwg-bin' };
  }
  const entry = typeof argv1 === 'string' && argv1.length > 0
    ? (path.isAbsolute(argv1) ? argv1 : path.resolve(cwd, argv1))
    : null;
  // Only the aiwg launcher itself is a usable entrypoint; doctor also runs as
  // `node tools/cli/doctor.mjs`, where argv[1] is doctor, not aiwg.
  const isLauncher = entry && ['aiwg', 'aiwg.mjs'].includes(path.basename(entry));
  if (entry && isLauncher && existsSync(entry)) {
    return { file: execPath, prefix: [entry], via: 'entrypoint' };
  }
  if (typeof packageRoot === 'string' && packageRoot.length > 0) {
    const bin = path.join(packageRoot, 'bin', 'aiwg.mjs');
    if (existsSync(bin)) {
      return { file: execPath, prefix: [bin], via: 'package' };
    }
  }
  return { file: 'aiwg', prefix: [], via: 'path' };
}

export function probeNotOnPathDetail() {
  return 'aiwg not on PATH (spawn ENOENT) — add the npm global bin to PATH or invoke doctor via the install entrypoint';
}
