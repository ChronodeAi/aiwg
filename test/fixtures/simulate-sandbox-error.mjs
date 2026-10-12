#!/usr/bin/env node
// Trusted-verification fixture (#2889, T-OG-04/T-OG-10): a real child process
// that reports a sandbox-shaped error the way a worker-side tool would after
// catching its own EPERM/EROFS from a filesystem call, rather than letting
// node:child_process itself fail to spawn. This lets tests exercise the
// "EPERM/EROFS observed in check output" classification path realistically
// on any host (root or not) without depending on real permission-bit
// enforcement, which root always bypasses.
//
// Usage: node simulate-sandbox-error.mjs --code EPERM|EROFS|OTHER
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const code = arg('--code', 'EPERM');
if (code === 'OTHER') {
  process.stderr.write('check failed: assertion mismatch\n');
  process.exit(1);
}
process.stderr.write(`Error: ${code}: operation not permitted by sandbox\n`);
process.exit(1);
