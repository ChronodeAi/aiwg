// Classify unreadable same-uid processes as possible escaped worker descendants or unrelated trees.
import { constants } from 'node:fs';

// Ancestry walks stay bounded: a pathological ppid chain can never turn this
// proof into an unbounded scan. Depth and the caller's time bound both apply.
export const MAX_WORKER_ANCESTRY_DEPTH = 32;

const vanished = error => ['ENOENT', 'ESRCH'].includes(error?.code);

function readSmallFile(fs, filename, maxBytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(maxBytes + 1);
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      chunks.push(buffer.subarray(0, size));
      bytes += size;
      if (bytes > maxBytes) return { tooLarge: true };
    }
    return { text: Buffer.concat(chunks).toString('utf8') };
  } catch (error) { return { error }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Parse the link fields of /proc/<pid>/stat: ppid, process group, session and
// start time. The comm field may contain spaces and parentheses, so field 3
// begins after its LAST ')'. Returns null when the text is malformed.
export function parseProcStatLink(text) {
  if (typeof text !== 'string') return null;
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  const [ppid, pgrp, session] = [fields[1], fields[2], fields[3]].map(Number);
  const start = fields[19];
  if (![ppid, pgrp, session].every(Number.isSafeInteger) || typeof start !== 'string' || !/^\d+$/.test(start)) return null;
  return { ppid, pgrp, session, start };
}

// Read /proc/<pid>/cgroup verbatim (cgroup membership stays readable for
// non-dumpable processes). Normalized like sampleProcessCgroup: the bare path
// for the unified hierarchy, raw content otherwise. Null when unreadable.
export function readProcCgroup(fs, path) {
  const read = readSmallFile(fs, `${path}/cgroup`);
  if (read.error || read.tooLarge) return null;
  const raw = String(read.text ?? '').trim();
  if (!raw) return null;
  const unified = raw.split('\n').find(line => line.startsWith('0::'));
  const group = unified ? unified.slice(3) : raw;
  return group || null;
}

const isTicks = value => typeof value === 'string' && /^\d+$/.test(value);

/**
 * Decide whether an unreadable same-uid process could be an escaped descendant
 * of the recorded worker leader, using only evidence that stays readable for
 * non-dumpable (hardened, e.g. Codex) processes: /proc/<pid>/stat (ppid,
 * process group, session, start time) and /proc/<pid>/cgroup.
 *
 * Returns 'predates' (started strictly before the worker: cannot descend from
 * it), 'unrelated' (its readable ancestry reaches another live process that
 * is not ours, e.g. a different conductor's worker), 'vanished' (it
 * disappeared mid-scan), or 'possible-descendant' (fail closed: ancestry
 * reaches the worker leader or the worker's original session/process group,
 * shares the worker's private cgroup, is reparented to init/a subreaper with
 * no other link, or any link in the chain is unreadable).
 */
export function classifyUnreadableWorkerProcess({ fs, procRoot, pid, uid, workerPid,
  workerPgid, workerSession, workerStart, workerCgroup, selfCgroup,
  now = () => performance.now(), deadline = now() + 100, maxDepth = MAX_WORKER_ANCESTRY_DEPTH } = {}) {
  const path = `${procRoot}/${pid}`;
  const first = readSmallFile(fs, `${path}/stat`);
  if (first.error) return vanished(first.error) ? 'vanished' : 'possible-descendant';
  const link = !first.tooLarge && parseProcStatLink(first.text);
  if (!link) return 'possible-descendant';
  if (!isTicks(workerStart)) return 'possible-descendant';
  if (BigInt(link.start) < BigInt(workerStart)) return 'predates';
  // A process still in the worker's original session or process group is
  // treated as a possible descendant even when its ppid chain is broken
  // (an orphan that never called setsid keeps both).
  if ((Number.isSafeInteger(workerPgid) && workerPgid > 0 && link.pgrp === workerPgid)
    || (Number.isSafeInteger(workerSession) && workerSession > 0 && link.session === workerSession)) {
    return 'possible-descendant';
  }
  // A shared cgroup links the process to the worker only when the worker's
  // own cgroup is private: a degraded worker shares its session cgroup with
  // every sibling, so that match proves nothing and ancestry decides.
  if (workerCgroup) {
    const candidate = readProcCgroup(fs, path);
    if (candidate !== null && candidate === workerCgroup && workerCgroup !== selfCgroup) return 'possible-descendant';
  }
  let current = link.ppid;
  for (let depth = 0; ; depth++) {
    if (now() >= deadline) return 'possible-descendant';
    if (depth >= maxDepth) return 'possible-descendant';
    if (current === workerPid) {
      // A pid number alone is not proof: verify the generation, since the
      // number may have been reused after the leader exited.
      const leader = readSmallFile(fs, `${procRoot}/${current}/stat`);
      if (leader.error || leader.tooLarge) return 'possible-descendant';
      const leaderLink = parseProcStatLink(leader.text);
      if (!leaderLink) return 'possible-descendant';
      if (leaderLink.start === workerStart) return 'possible-descendant';
      current = leaderLink.ppid;
      continue;
    }
    // Reparented to init (or the kernel): with no other link this is the
    // honest unknown case, never proof of absence.
    if (!Number.isSafeInteger(current) || current <= 1) return 'possible-descendant';
    let owner;
    try { owner = fs.statSync(`${procRoot}/${current}`).uid; }
    catch { return 'possible-descendant'; }
    // Another identity's tree (including container shims and managers owned
    // by a different uid) can never be our worker's descendant. A setuid
    // escape across uids is out of scope for this same-uid scan.
    if (owner !== uid) return 'unrelated';
    const next = readSmallFile(fs, `${procRoot}/${current}/stat`);
    if (next.error || next.tooLarge) return 'possible-descendant';
    const nextLink = parseProcStatLink(next.text);
    if (!nextLink) return 'possible-descendant';
    // This ancestor predates the worker, so it cannot descend from it — and
    // neither can anything reached through it (a sibling subtree, another
    // conductor's parallel worker, a session manager).
    if (BigInt(nextLink.start) < BigInt(workerStart)) return 'unrelated';
    current = nextLink.ppid;
  }
}
