// Offline systemd client stand-in: synthetic probe responses and local checks only.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mode = readFileSync(join(root, 'mode.txt'), 'utf8');
if (mode === 'unavailable') process.exit(1);
if (args.includes('--version') || args.includes('Version')) {
  console.log('259');
} else if (args.includes('show-environment')) {
  // Empty synthetic manager environment.
} else if (args.some(arg => arg.startsWith('--unit=aiwg-verify-isolation-probe-'))) {
  const scratch = args.find(arg => arg.startsWith('ReadWritePaths=')).slice('ReadWritePaths='.length);
  writeFileSync(join(scratch, 'ok'), 'positive control');
  console.log(`NONEWPRIVS:1\nNETNS:net:[fixture]\nHOMECOUNT:${mode === 'missing-home' ? 2 : 0}\nTMPMARK:${join(scratch, 'private-marker')}\nSCRATCHWRITE:0\nTMPWRITE:1\nVARTMPWRITE:1\nHOMEWRITE:1\nDONE:1`);
} else {
  const start = args.indexOf('--');
  if (start < 0) throw new Error('Unexpected fixture command');
  const cwdArg = args.find(arg => arg.startsWith('--working-directory='));
  const cwd = cwdArg?.slice('--working-directory='.length);
  const result = spawnSync(args[start + 1], args.slice(start + 2), { cwd, encoding: 'utf8', timeout: 5000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}
