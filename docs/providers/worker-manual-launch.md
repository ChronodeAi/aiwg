# Manual worker launch and adoption

Manual launch, capture and adoption conventions for one attached worker.

An owning shell can apply the same convention without calling the Ralph helper.
Recheck the full plan and dispatch gate first, authorize any degraded boundary,
and use only its literal typed argv and allowlisted environment. Never evaluate
`shellCommand` or execute a command supplied by worker output. The following Bash
procedure uses the shell's own `wait` and Node's standard library; replace the example argv with the exact
qualified argv, including the fresh output references:

```bash
umask 077
run=$(mktemp -d /tmp/aiwg-worker.XXXXXXXX) || exit 1
chmod 700 "$run" || exit 1
brief=/absolute/private/brief.json
plan=/absolute/private/rechecked-plan.json
workdir=/absolute/authorized/worktree
final=/absolute/authorized/outputs/fresh-final.json
stdout="$final.stdout"              # Exact #2887 output bindings.
stderr="$final.stderr"
argv=('/absolute/qualified-binary' 'literal argument from the rechecked plan')
record_manual() {
  node --input-type=module - "$run" "$plan" "$1" "$$" "${worker-}" "${wait_status-}" \
    "$workdir" "$brief" "$stdout" "$stderr" "$final" "${argv[@]}" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
const [run, filename, stage, shell, child, waited, cwd, brief, stdout, stderr, final, ...argv] = process.argv.slice(2);
const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
const digest = v => 'sha256:' + createHash('sha256').update(JSON.stringify(normalize(v))).digest('hex');
const bytesDigest = v => 'sha256:' + createHash('sha256').update(v).digest('hex');
function safe(p) {
  if (!path.isAbsolute(p) || p.split('/').includes('..')) throw Error('unsafe path');
  let current = '/';
  for (const part of p.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('symlink'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
for (const p of [run, filename, cwd, brief, stdout, stderr, final]) safe(p);
const runStat = fs.statSync(run);
if (runStat.uid !== process.getuid() || (runStat.mode & 0o077)) throw Error('unowned/private directory');
function read(p, limit) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > limit) throw Error('unbounded input');
    return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function write(name, value) {
  const target = path.join(run, name); safe(target);
  const temp = path.join(run, '.' + randomUUID());
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
}
function identity(pid) {
  if (!Number(pid)) return null;
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(/\s+/);
    return {pid:Number(pid), pgid:Number(f[2]), parentPid:Number(f[1]), sessionId:Number(f[3]), startTicks:f[19],
      uid:Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]),
      host:os.hostname(), bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), executable:fs.readlinkSync(`/proc/${pid}/exe`)};
  } catch { return null; }
}
if (stage === 'before') {
  const p = JSON.parse(read(filename, 1048576)); const i = p.invocation;
  if (p.mode !== 'direct' || p.status !== 'eligible' || i.readiness !== 'launchable' || Date.parse(i.expiresAt) <= Date.now()
    || JSON.stringify(i.argv) !== JSON.stringify(argv) || [i.cwd,i.briefPath,i.stdoutPath,i.stderrPath,i.finalPath].join('\0') !== [cwd,brief,stdout,stderr,final].join('\0')
    || bytesDigest(read(brief, 262144)) !== i.briefDigest || fs.readdirSync(run).length) throw Error('plan binding changed');
  const invocationId = randomUUID();
  write('invocation.json', {invocationId, origin:'manual', planDigest:digest(p), invocationDigest:digest(i),
    argv:i.argv.map((v,n) => n === 0 ? v : '<argument:' + bytesDigest(v) + '>'), argvDigest:digest(i.argv),
    envNames:i.envNames, prompt:{path:brief,digest:i.briefDigest}, selected:i.selected,
    cwd, worktree:{path:cwd,baseRevision:null}, paths:{stdout,stderr,final}, health:i.health,
    attemptId:invocationId, previousAttemptId:null});
  write('process.json', {invocationId, origin:'manual', supervisor:identity(shell), worker:null});
} else if (stage === 'started') {
  const old = JSON.parse(read(path.join(run,'process.json'),65536));
  write('process.json', {...old,worker:identity(child),launchTime:new Date().toISOString(),monotonicStart:process.hrtime.bigint().toString(),ownership:'unknown'});
} else {
  const old = JSON.parse(read(path.join(run,'process.json'),65536)); const status = Number(waited);
  write('exit.json', {invocationId:old.invocationId, waitStatus:status, exitCode:status < 128 ? status : null,
    signal:null, endedAt:new Date().toISOString(), termination:'uncertain', descendants:'unknown'});
}
JS
}
record_manual before || exit 1
# Open every capture before spawn; failure ends the attempt without a worker.
set -C                            # Refuse existing capture/final files.
exec {out}>"$stdout" || exit 1
exec {err}>"$stderr" || exit 1
: >"$final" || exit 1
# PATH/HOME here are examples: use exactly the qualified envNames.
# Run with job control off; verify $! against actual PID/PGID/start identity.
set +m
(cd "$workdir" &&
  while IFS= read -r name; do
    case "$name" in PATH|HOME) ;; *) unset "$name" || exit 1 ;; esac
  done < <(compgen -e)
  exec setsid "${argv[@]}") \
  < /dev/null >&"$out" 2>&"$err" &
worker=$!
# For brief-text/brief-json, replace /dev/null with "$brief"; EOF follows the file.
if ! record_manual started; then
  printf '%s\n' 'Metadata unavailable; retain the shell/child references and unknown ownership in conductor context.' >&2
fi
if wait "$worker"; then wait_status=0; else wait_status=$?; fi
exec {out}>&-
exec {err}>&-
record_manual ended || exit 1
# Bash statuses >128 can also be ordinary exits: without native evidence, record
# exact code/signal as null and retain wait_status. Never invent exit code zero.
# Owned descendants not independently proven stopped => termination uncertain.
# Extract a separate final through the qualified parser; retain both captures.
```

The metadata steps use exclusive temporary regular files
and atomic rename under the private directory, reject symlink/hardlink aliases,
and preserve mode 0600. Native isolation remains required whenever the profile
needs it; `setsid` establishes a process group, not a filesystem or resource
sandbox. A hand-launched process that shares its parent's group remains
inspectable but grants no group-kill rights.

`SessionLauncher.adoptWorker({ runDir?, invocationId?, worker?, paths? })` accepts
known manual references with `origin: 'manual'`, returns explicit nulls for
unknown identities/terminal facts and does not signal processes. It never scans
by process name or trusts an adopted PID as cancellation authority. Omit
`runDir` when writable scratch is unavailable: the returned observation stays in
conductor context, with unavailable deadline/stop guarantees explicit. No status
query can discover absent records, and no automatic MC fallback occurs.

Retention and disposition belong to the conductor. Restricted raw prompts/logs
default to 24 hours after confirmed termination and disposition; live or uncertain
attempts are preserved. Dirty/partial worktrees require explicit disposition.
This helper supplies evidence; it does not run a retention service.

