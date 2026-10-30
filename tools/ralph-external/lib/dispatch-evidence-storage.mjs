// Owner-only, fd-pinned dispatch evidence storage and prompt retention primitives.
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DISPATCH_DIR_MODE, DISPATCH_FILE_MODE, DISPATCH_PROMPT_FILENAME, INVOCATION_PATTERN,
  DIGEST_PATTERN, DispatchEvidenceError, digestOf, currentUid } from './dispatch-evidence-common.mjs';
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const PROC_SELF_FD = '/proc/self/fd';

/**
 * Test-only race-injection seam (#2891 R1/R7). No-op in production: both
 * hooks default to `null` and every production code path is identical to
 * calling `open`/`mkdir` directly. This package's own conformance suite
 * (`test/conformance/orchestration-v1/dispatch-evidence-races.test.ts`) sets
 * `afterOpen`/`afterMkdir` to a one-shot callback that performs a
 * deterministic TOCTOU swap (rename the real directory away, symlink an
 * external victim at its old name) at the exact point between two of this
 * module's own filesystem steps, then clears itself — reproducing the race
 * without real concurrency and without mocking a Node builtin module (which
 * is unreliable across test files sharing one vitest worker). Never read
 * outside `openTraced`/`mkdirTraced` below; never consulted when both hooks
 * are `null`.
 */
export const __raceTestHooks = { afterOpen: null, afterMkdir: null };

export async function openTraced(path, flags, mode) {
  const handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
  if (__raceTestHooks.afterOpen) await __raceTestHooks.afterOpen(path);
  return handle;
}

async function mkdirTraced(path, options) {
  const result = await mkdir(path, options);
  if (__raceTestHooks.afterMkdir) await __raceTestHooks.afterMkdir(path);
  return result;
}

/** Mirror of `src/effects/verifiers/file.ts` containment: strict subtree, never the root itself. */
export function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// fd-pinned primitives (#2891 R1). ONE set, used by every multi-step helper
// below. A trusted directory is opened once and kept open; every child
// operation runs through `/proc/self/fd/<fd>/<name>` against that same,
// still-open descriptor — never by re-resolving a path string.
// ---------------------------------------------------------------------------

/** Build the fd-anchored reference for exactly one path component. Rejects
 * anything that is not a single, ordinary component: this is what makes the
 * "one component at a time" discipline structural rather than a convention. */
export function fdChildRef(handle, name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new DispatchEvidenceError(`Invalid path component: ${String(name)}`, 'storage-failure');
  }
  const fd = handle?.fd;
  if (typeof fd !== 'number' || fd < 0) {
    throw new DispatchEvidenceError('Dispatch evidence lost its pinned directory handle', 'storage-failure');
  }
  return `${PROC_SELF_FD}/${fd}/${name}`;
}

async function assertOwnedDirStat(handle, label, displayName) {
  const stat = await handle.stat();
  const uid = currentUid();
  if (!stat.isDirectory() || (stat.mode & 0o777) !== DISPATCH_DIR_MODE || (uid !== null && stat.uid !== uid)) {
    throw new DispatchEvidenceError(`${label} is not owner-only 0700: ${displayName}`, 'storage-failure');
  }
}

/**
 * Open and pin the artifact root by its caller-supplied absolute path. This
 * is the ONLY place a multi-component path is resolved from scratch for a
 * trust boundary; every further descent happens through the returned,
 * still-open handle. The root itself need not be owner-only (it may be a
 * general output directory the caller controls), only a real directory.
 */
async function pinArtifactRoot(root) {
  if (typeof root !== 'string' || !root) {
    throw new DispatchEvidenceError('Dispatch evidence needs an artifact root', 'artifact-root-unavailable');
  }
  const resolved = resolve(root);
  let handle;
  try {
    handle = await openTraced(resolved, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Dispatch evidence root is unavailable: ${resolved} (${error?.code ?? error?.message ?? error})`,
      'artifact-root-unavailable',
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new DispatchEvidenceError(`Dispatch evidence root is not a directory: ${resolved}`, 'artifact-root-unavailable');
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { resolved, handle };
}

/**
 * Require an artifact root to exist and be a real directory. An unavailable
 * root blocks: the throw means no launch, no receipt and no cleanup. This is
 * a one-shot check (open, validate, close); callers that need to act on the
 * root afterward pin their own handle via `pinArtifactRoot` instead of
 * calling this and re-resolving the path a second time.
 */
export async function requireArtifactRoot(root) {
  const { resolved, handle } = await pinArtifactRoot(root);
  await handle.close();
  return resolved;
}

/**
 * Create (if needed) and require an owner-only child directory of an
 * already-pinned parent handle, via the fd-anchored reference only: mkdir
 * never resolves a multi-component path (so a symlinked ancestor can never
 * be transparently followed), and the result is verified by fstat on a
 * freshly-opened `O_NOFOLLOW` fd — never by chmod through a path. EEXIST is
 * accepted only when the fd pins a real directory owned by us with mode
 * exactly 0700; a pre-planted symlink fails the O_NOFOLLOW open and a
 * pre-planted wrong-mode directory fails the mode check. The CALLER owns
 * closing the returned handle.
 */
async function createOwnedChildDir(parentHandle, name, label) {
  const ref = fdChildRef(parentHandle, name);
  try {
    await mkdirTraced(ref, { recursive: false, mode: DISPATCH_DIR_MODE });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new DispatchEvidenceError(`${label} cannot be prepared: ${name} (${error?.code ?? error?.message ?? error})`, 'storage-failure');
    }
  }
  let handle;
  try {
    handle = await openTraced(ref, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(`${label} is not a real directory: ${name} (${error?.code ?? error?.message ?? error})`, 'storage-failure');
  }
  try {
    await assertOwnedDirStat(handle, label, name);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/** Like `createOwnedChildDir`'s open-only half, but never throws: returns
 * `null` when the child is missing, not a real directory, or a symlink.
 * Used by retention/digest proof, where "unprovable" means `false`, not an
 * error. */
async function openPinnedChildDirSafe(handle, name) {
  const ref = fdChildRef(handle, name);
  let dirHandle;
  try {
    dirHandle = await openTraced(ref, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return null;
  }
  const stat = await dirHandle.stat().catch(() => null);
  if (!stat || !stat.isDirectory()) {
    await dirHandle.close();
    return null;
  }
  return dirHandle;
}

/**
 * Create (if needed) and require an owner-only directory, identified by its
 * full absolute path. The directory's IMMEDIATE PARENT is opened once with
 * `O_NOFOLLOW` (so a symlinked parent — the "ancestor" a swap would plant —
 * is refused outright) and kept open while the child is created and
 * validated through it: creation never re-resolves the full path, so a swap
 * of the parent between validating it and creating the child cannot redirect
 * the mkdir.
 */
export async function ensureProtectedDir(directory) {
  const resolved = resolve(directory);
  const parentPath = dirname(resolved);
  const name = basename(resolved);
  let parentHandle;
  try {
    parentHandle = await openTraced(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Dispatch evidence directory's parent is not a real directory: ${parentPath} (${error?.code ?? error?.message ?? error})`,
      'storage-failure',
    );
  }
  try {
    const handle = await createOwnedChildDir(parentHandle, name, 'Dispatch evidence directory');
    await handle.close();
  } finally {
    await parentHandle.close();
  }
  return resolved;
}

/**
 * Create a file with exact bytes and mode 0600, exclusively, under an
 * already-existing parent directory. The parent is opened once with
 * `O_NOFOLLOW` and kept open for the whole operation; the file is created
 * and verified through that same fd via the fd-anchored reference, never by
 * re-resolving the full path. `O_EXCL` means a pre-planted regular file is
 * never truncated under its existing permissions; `O_NOFOLLOW` means a
 * pre-planted symlink is never followed onto an out-of-tree victim.
 * Ownership, type and mode are verified by fstat on the open fd.
 */
export async function writeProtectedFile(path, bytes) {
  const resolved = resolve(path);
  const parentPath = dirname(resolved);
  const name = basename(resolved);
  let parentHandle;
  try {
    parentHandle = await openTraced(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Dispatch evidence directory's parent is not a real directory: ${parentPath} (${error?.code ?? error?.message ?? error})`,
      'storage-failure',
    );
  }
  try {
    await assertOwnedDirStat(parentHandle, 'Dispatch evidence directory', parentPath);
    const body = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
    const ref = fdChildRef(parentHandle, name);
    let handle;
    try {
      handle = await openTraced(ref, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, DISPATCH_FILE_MODE);
    } catch (error) {
      throw new DispatchEvidenceError(
        `Dispatch evidence file cannot be created exclusively: ${resolved} (${error?.code ?? error?.message ?? error})`,
        'storage-failure',
      );
    }
    try {
      await handle.writeFile(body);
      const stat = await handle.stat();
      const uid = currentUid();
      if (!stat.isFile() || (stat.mode & 0o777) !== DISPATCH_FILE_MODE || (uid !== null && stat.uid !== uid)) {
        throw new DispatchEvidenceError(`Dispatch evidence file is not owner-only 0600: ${resolved}`, 'storage-failure');
      }
    } finally {
      await handle.close();
    }
    return { path: resolved, digest: digestOf(body) };
  } finally {
    await parentHandle.close();
  }
}

/**
 * Prepare the attempt root for one direct dispatch: requires the artifact
 * root, validates the invocation ID against the shared INVOCATION_PATTERN
 * (bare `../escaped` values never reach the filesystem), then creates
 * `<root>/<invocationId>`, `brief` and `evidence` as 0700 dirs in that
 * order — all through ONE pinned root handle and then one pinned attempt
 * handle, kept open across every step. Containment is structural (each
 * directory is created as a single named child of an already-pinned,
 * already-validated parent descriptor), so a swap of the root or the
 * attempt directory's PATH between steps cannot redirect a later step: it
 * can only ever create `brief`/`evidence` inside the real, pinned attempt
 * directory, never inside whatever the swapped path now names.
 */
export async function prepareDirectAttemptPaths(root, invocationId) {
  if (typeof invocationId !== 'string' || !INVOCATION_PATTERN.test(invocationId)) {
    throw new DispatchEvidenceError('Dispatch evidence needs a valid invocation ID', 'invalid-invocation');
  }
  const { resolved: base, handle: rootHandle } = await pinArtifactRoot(root);
  try {
    const attemptHandle = await createOwnedChildDir(rootHandle, invocationId, 'Dispatch attempt directory');
    try {
      const briefHandle = await createOwnedChildDir(attemptHandle, 'brief', 'Dispatch brief directory');
      await briefHandle.close();
      const evidenceHandle = await createOwnedChildDir(attemptHandle, 'evidence', 'Dispatch evidence directory');
      await evidenceHandle.close();
    } finally {
      await attemptHandle.close();
    }
  } finally {
    await rootHandle.close();
  }
  const attempt = join(base, invocationId);
  return { attempt, briefDir: join(attempt, 'brief'), evidenceDir: join(attempt, 'evidence') };
}

/**
 * Fd-pinned digest proof: the named artifact must live under the already-
 * pinned `rootHandle` and its exact bytes — read through an O_NOFOLLOW fd —
 * must hash to `digest`. The relative path is walked one component at a
 * time, each directory component opened `O_NOFOLLOW` against the PREVIOUS
 * pinned handle (never a re-resolved path string), so an ancestor swap
 * anywhere along the walk cannot redirect a later component. Any `.`/`..`/
 * empty component is a structural escape and throws; a missing file or a
 * digest mismatch returns `false` (retention unproven), never throws.
 */
async function verifyArtifactDigestPinned(rootHandle, relativeArtifactPath, digest) {
  const components = String(relativeArtifactPath).split('/');
  if (components.length === 0 || components.some((part) => part === '' || part === '.' || part === '..')) {
    throw new DispatchEvidenceError(`Retention artifact escapes the attempt root: ${relativeArtifactPath}`, 'prompt-escape');
  }
  let currentHandle = rootHandle;
  let ownsCurrent = false;
  try {
    for (let i = 0; i < components.length - 1; i += 1) {
      const next = await openPinnedChildDirSafe(currentHandle, components[i]);
      if (!next) return false;
      if (ownsCurrent) await currentHandle.close();
      currentHandle = next;
      ownsCurrent = true;
    }
    const leaf = components[components.length - 1];
    const ref = fdChildRef(currentHandle, leaf);
    let fileHandle;
    try {
      fileHandle = await openTraced(ref, O_RDONLY | O_NOFOLLOW);
    } catch {
      return false;
    }
    try {
      const stat = await fileHandle.stat();
      if (!stat.isFile()) return false;
      return digestOf(await fileHandle.readFile()) === digest;
    } finally {
      await fileHandle.close();
    }
  } finally {
    if (ownsCurrent) await currentHandle.close();
  }
}

/**
 * Remove a CLI prompt file only after a CONFIRMED stop with a recorded
 * removable disposition, and only once the canonical redacted artifact is
 * proven retained: `redactedArtifactDigest` must be a well-formed sha256
 * digest of an artifact that actually exists under `attemptRoot` and whose
 * fd-computed digest matches. The attempt root is pinned ONCE (opened
 * `O_NOFOLLOW`) and kept open for inspection, retention proof AND removal:
 * the prompt file is located and removed only via `/proc/self/fd/<rootfd>/
 * prompt.md`, never by re-resolving `attemptRoot`'s path a second time, so
 * a root swap mid-verification cannot redirect the final unlink onto an
 * external `prompt.md`. Any other termination, any missing disposition, any
 * unproven retention — including uncertain, live, failed, cancelled,
 * timed-out or unknown — retains the file: dirty/uncertain evidence is
 * never deleted here.
 *
 * Returns `{ removed, reason }`; `removed` is true only on confirmed,
 * disposition-recorded, retention-proven cleanup.
 */
export async function cleanupPromptFile({
  attemptRoot,
  promptPath,
  termination,
  disposition = null,
  redactedArtifactDigest = null,
  redactedArtifactPath = null,
}) {
  if (typeof attemptRoot !== 'string' || !attemptRoot) {
    throw new DispatchEvidenceError('Prompt cleanup needs the attempt root', 'invalid-attempt-root');
  }
  if (typeof promptPath !== 'string' || !promptPath) {
    throw new DispatchEvidenceError('Prompt cleanup needs a prompt path', 'invalid-prompt-path');
  }
  if (termination !== 'confirmed') {
    return { removed: false, reason: `retained: termination is ${String(termination)}, not confirmed` };
  }
  if (!disposition || disposition.removable !== true) {
    return { removed: false, reason: 'retained: no recorded removable disposition from the conductor' };
  }
  if (typeof redactedArtifactDigest !== 'string' || !DIGEST_PATTERN.test(redactedArtifactDigest)) {
    return { removed: false, reason: 'retained: canonical redacted artifact digest is not recorded yet' };
  }
  if (typeof redactedArtifactPath !== 'string' || !redactedArtifactPath) {
    return { removed: false, reason: 'retained: canonical redacted artifact path is not recorded yet' };
  }

  const resolvedRoot = resolve(attemptRoot);
  const resolvedPrompt = resolve(promptPath);
  if (dirname(resolvedPrompt) !== resolvedRoot) {
    throw new DispatchEvidenceError(`Prompt file escapes the attempt root: ${resolvedPrompt}`, 'prompt-escape');
  }
  if (basename(resolvedPrompt) !== DISPATCH_PROMPT_FILENAME) {
    throw new DispatchEvidenceError(`Prompt file is not the expected ${DISPATCH_PROMPT_FILENAME}: ${resolvedPrompt}`, 'invalid-prompt-path');
  }

  let rootHandle;
  try {
    rootHandle = await openTraced(resolvedRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Dispatch evidence root is unavailable: ${resolvedRoot} (${error?.code ?? error?.message ?? error})`,
      'artifact-root-unavailable',
    );
  }
  try {
    const ref = fdChildRef(rootHandle, DISPATCH_PROMPT_FILENAME);
    let fileHandle;
    try {
      fileHandle = await openTraced(ref, O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: false, reason: 'absent: prompt file already gone' };
      if (error?.code === 'ELOOP') {
        throw new DispatchEvidenceError(`Prompt file is a symlink, refusing removal: ${resolvedPrompt}`, 'prompt-escape');
      }
      throw new DispatchEvidenceError(
        `Prompt file cannot be inspected: ${resolvedPrompt} (${error?.code ?? error?.message ?? error})`,
        'storage-failure',
      );
    }
    try {
      const stat = await fileHandle.stat();
      if (!stat.isFile()) {
        throw new DispatchEvidenceError(`Prompt file is not a regular file: ${resolvedPrompt}`, 'storage-failure');
      }
      const proven = await verifyArtifactDigestPinned(rootHandle, redactedArtifactPath, redactedArtifactDigest);
      if (!proven) {
        return { removed: false, reason: 'retained: canonical redacted artifact digest does not match bytes under the attempt root' };
      }
      try {
        await rm(ref, { force: false });
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: false, reason: 'absent: prompt file already gone' };
        throw new DispatchEvidenceError(
          `Prompt file cannot be removed: ${resolvedPrompt} (${error?.code ?? error?.message ?? error})`,
          'storage-failure',
        );
      }
      return { removed: true, reason: 'removed after confirmed stop with the canonical redacted artifact retained' };
    } finally {
      await fileHandle.close();
    }
  } finally {
    await rootHandle.close();
  }
}

