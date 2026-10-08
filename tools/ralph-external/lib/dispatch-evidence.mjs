/**
 * S1 direct/shared dispatch evidence (#2891, epic #2875).
 *
 * Optional direct activity receipts, 08 brief/evidence storage discipline and
 * digest-only effect linkage for Tier 0 direct launches. Ordinary direct mode
 * works with receipts off: nothing here is a launch prerequisite and nothing
 * here creates a ledger, a receipt store or a second run-state machine.
 *
 * - Brief/evidence directories are mode 0700 and brief/result/evidence files
 *   0600, requested at creation time (0700/0600 carry no group/other bits,
 *   so no umask can grant wider access) and verified by fstat on the open
 *   fd. Files are created O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW: a pre-planted
 *   symlink or regular file fails instead of being followed or truncated.
 *   Directories are created one level at a time with mkdir 0700; an EEXIST
 *   entry is accepted only after an O_NOFOLLOW fd pins a real directory
 *   owned by us with mode exactly 0700.
 * - ONE fd-pinned primitive set is used everywhere a multi-step filesystem
 *   operation touches storage: a trusted directory is opened once with
 *   `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and kept open for the whole
 *   operation; every child mkdir/open/unlink/read runs relative to that
 *   open descriptor via `/proc/self/fd/<fd>/<name>`, one path component at
 *   a time, each component itself opened `O_NOFOLLOW` and fstat-checked.
 *   No path string is ever re-resolved from scratch after a directory has
 *   been pinned, so an attacker who swaps a directory entry for a symlink
 *   between two of our steps cannot redirect the later step: our open file
 *   descriptor still refers to the original inode regardless of what the
 *   path now names. This defeats both "symlinked ancestor" attacks (the
 *   leaf's parent is swapped before the leaf is created) and "root swap"
 *   attacks (the operation's root is swapped mid-operation).
 * - CLI prompt files are removed only after a CONFIRMED stop with a recorded
 *   removable disposition, once the canonical redacted artifact is proven
 *   retained (well-formed digest of bytes that actually exist under the
 *   attempt root, verified through the same fd-pinned walk). Dirty/uncertain
 *   evidence is never deleted by these helpers.
 * - Disk-pressure admission reuses the #2954 resource-preflight gate
 *   (`checkWorkerDispatch`); this module only threads attempt roots through
 *   it, it does not duplicate the resolver.
 * - Usage confidence is enforced end to end through the #2890
 *   codec/validator (`workerUsage`): unknown stays unknown (null counts,
 *   never numerics), and every receipt usage validates before it is kept.
 * - Effect linkage is digest-only (`file.digest` targets over the exact
 *   artifact bytes, canonical relative paths); scopes and recovery verify
 *   through the EXISTING effect ledger, never a second ledger.
 * - Redacted export is an allowlist projection over explicitly named safe
 *   fields (ids, digests, statuses, usage with confidence). It never spreads
 *   the receipt, and every exported id/enum value is validated against a
 *   strict pattern or closed enum before it leaves the conductor: a value
 *   that fails validation is dropped and replaced with a fixed redaction
 *   marker rather than ever being written to the exported object.
 * - The invocation-ID pattern is defined once, in `src/effects/dispatch-
 *   verifier.ts`, and imported here (never duplicated as a second literal)
 *   through the repo's `tools/_resolve-impl.mjs` `importImpl` pattern, the
 *   same mechanism other `tools/` consumers of `src/` use (e.g.
 *   `tools/ralph-external/lib/provider-adapter.mjs`). Importing
 *   `src/*.js` directly from `tools/` fails under plain Node (only `.ts`
 *   exists under `src/`; the compiled output lives under `dist/src/`), so
 *   this module never does that.
 *
 * Managed (S2+) durability — required evidence, leases, activation and
 * runtime integration — is out of scope for this checkpoint.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { checkWorkerDispatch } from '../../scripts/resource-preflight.mjs';

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const PROC_SELF_FD = '/proc/self/fd';

// Reuse the #2890 codec/validator; never reimplement worker-usage shaping
// here. Reuse the single shared invocation-ID pattern from the verifier;
// never duplicate it as a second literal. Both are compiled `src/` modules,
// so `tools/` reaches them through `importImpl` (dist/src when built, src
// under vitest) rather than a direct `src/*.js` specifier, which does not
// exist on disk and fails under plain Node (#2891 R6).
const { validateWorkerPayload } = await importImpl(import.meta.url, 'mission-protocol/codecs.js');
const { INVOCATION_PATTERN: SHARED_INVOCATION_PATTERN } = await importImpl(import.meta.url, 'effects/dispatch-verifier.js');

export const DISPATCH_DIR_MODE = 0o700;
export const DISPATCH_FILE_MODE = 0o600;
/** The only prompt filename cleanup ever removes. */
export const DISPATCH_PROMPT_FILENAME = 'prompt.md';

/**
 * Canonical invocation-ID shape. The single source is
 * `src/effects/dispatch-verifier.ts` `INVOCATION_PATTERN`; this binding is
 * the SAME regex object (imported, not copied), so the two can never drift.
 */
export const INVOCATION_PATTERN = SHARED_INVOCATION_PATTERN;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Strict id/enum shapes for the redacted export (#2891 R2). Any value that
 * does not match is dropped and replaced with `REDACTION_MARKER` rather than
 * ever reaching the exported object: an allowlisted FIELD NAME is not an
 * allowlisted VALUE. */
export const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const CHECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const PROFILE_VERSION_PATTERN = /^\d{1,5}(?:\.\d{1,5}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
export const IDENTITY_CONFIDENCE_VALUES = Object.freeze(['unavailable', 'runtime-configured-only', 'backend-attested']);
export const RECEIPT_TERMINATION_VALUES = Object.freeze(['confirmed', 'uncertain']);
export const REDACTION_MARKER = '[redacted:invalid]';

/** Execution outcomes this module settles. `uncertain` covers live and unreconciled work. */
export const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled', 'timed-out', 'uncertain']);

/** Usage confidence labels from #2890's WorkerUsage quality. Unknown stays unknown. */
export const USAGE_QUALITIES = Object.freeze(['reported', 'estimated', 'unknown']);

export class DispatchEvidenceError extends Error {
  constructor(message, code = 'dispatch-evidence-failed') {
    super(message);
    this.name = 'DispatchEvidenceError';
    this.code = code;
  }
}

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

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

async function openTraced(path, flags, mode) {
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
function inside(root, candidate) {
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
function fdChildRef(handle, name) {
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

/**
 * Settle an attempt workspace without ever deleting uncertain work. Only
 * `completed` is removable on its outcome alone; `failed`, `cancelled` and
 * `timed-out` stay retained until the conductor records an explicit
 * disposition (a non-empty decision string, or a prior disposition object
 * with `removable: true`). `uncertain` (and any unknown outcome) always
 * refuses removal. The caller owns timed deletion of settled work; this
 * helper only classifies.
 */
export function settleAttemptDisposition(outcome, explicitDisposition = null) {
  if (outcome === 'uncertain' || !TERMINAL_OUTCOMES.includes(outcome)) {
    return { removable: false, reason: `retained: outcome ${String(outcome)} is uncertain or unknown` };
  }
  if (outcome === 'completed') {
    return { removable: true, reason: 'retention: sanitized completed evidence 30 days; clean workspace 24h after disposition' };
  }
  const recorded = (typeof explicitDisposition === 'string' && explicitDisposition.trim() !== '')
    || (explicitDisposition !== null && typeof explicitDisposition === 'object' && explicitDisposition.removable === true);
  if (recorded) {
    return { removable: true, reason: `retention: explicit conductor disposition releases ${outcome} work plus 7 days` };
  }
  return { removable: false, reason: `retained: outcome ${outcome} needs an explicit conductor disposition before removal` };
}

/**
 * True for every managed-or-direct attempt state the ledger can settle:
 * terminal execution or explicitly uncertain. Anything else (live, unknown,
 * missing) must not release capacity or accept work.
 */
export function isTerminalOrUncertain(execution) {
  const status = execution?.status;
  const termination = execution?.termination;
  if (status === 'uncertain' || termination === 'uncertain') return true;
  return ['completed', 'failed', 'cancelled', 'timed-out'].includes(status) && termination === 'confirmed';
}

// ---------------------------------------------------------------------------
// Optional direct activity receipts (06 §9). No receipt store, no ledger.
// ---------------------------------------------------------------------------

/**
 * Normalize one usage sample for receipts and export through the #2890
 * codec/validator (`workerUsage` in `src/mission-protocol/codecs.ts`): the
 * full eight-field shape is built here and validated there, so this helper
 * cannot drift from the shipped contract. Unknown quality carries null
 * counts — numerics with `unknown` are dropped, never preserved — and any
 * shape that still fails validation throws instead of entering a receipt.
 */
export function normalizeUsageForReceipt(usage) {
  const quality = USAGE_QUALITIES.includes(usage?.quality) ? usage.quality : 'unknown';
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const money = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const candidate = {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheTokens: count(usage?.cacheTokens),
    reasoningTokens: count(usage?.reasoningTokens),
    costUsd: money(usage?.costUsd),
    quality,
    reservedTokens: count(usage?.reservedTokens) ?? 0,
    reservedUsd: money(usage?.reservedUsd),
  };
  if (candidate.quality === 'unknown') {
    candidate.inputTokens = null;
    candidate.outputTokens = null;
    candidate.cacheTokens = null;
    candidate.reasoningTokens = null;
    candidate.costUsd = null;
  }
  const { valid, errors } = validateWorkerPayload('workerUsage', candidate);
  if (!valid) {
    throw new DispatchEvidenceError(
      `Worker usage violates the #2890 contract: ${errors.join('; ') || 'shape mismatch'}`,
      'invalid-usage',
    );
  }
  return candidate;
}

/**
 * Build one optional direct activity receipt from conductor-held evidence.
 * Pure: returns the receipt object plus the single-line activity summary in
 * the current activity append format (`<operation> | <summary>` payload; the
 * caller timestamps and appends it with the existing activity-log path).
 *
 * Secrets never enter a receipt: only the command/tool descriptor digest is
 * recorded, never argv literals, env values or prompt text.
 */
export function buildDirectActivityReceipt({
  taskId,
  invocationId,
  transport,
  profileRef,
  profileVersion = null,
  commandDigest = null,
  toolDigest = null,
  requested = null,
  observed = null,
  identityConfidence = 'unavailable',
  worktree = null,
  baseRevision = null,
  handle = null,
  termination = 'uncertain',
  checks = [],
  acceptance = null,
  usage = null,
}) {
  if (typeof taskId !== 'string' || !taskId) {
    throw new DispatchEvidenceError('Direct receipt needs a task ID', 'invalid-receipt');
  }
  if (typeof invocationId !== 'string' || !INVOCATION_PATTERN.test(invocationId)) {
    throw new DispatchEvidenceError('Direct receipt needs a valid invocation ID', 'invalid-receipt');
  }
  if (!['shell', 'mcp'].includes(transport)) {
    throw new DispatchEvidenceError('Direct receipt transport must be shell or mcp', 'invalid-receipt');
  }
  const descriptorDigest = commandDigest ?? toolDigest ?? null;
  if (descriptorDigest !== null && !DIGEST_PATTERN.test(descriptorDigest)) {
    throw new DispatchEvidenceError('Direct receipt carries a descriptor digest, never command text', 'invalid-receipt');
  }
  const receipt = {
    version: 1,
    mode: 'direct',
    taskId,
    invocationId,
    transport,
    ...(profileRef ? { profileRef } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(descriptorDigest ? { descriptorDigest } : {}),
    ...(requested ? { requested } : {}),
    ...(observed ? { observed } : {}),
    identityConfidence,
    ...(worktree ? { worktree } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    ...(handle ? { handle } : {}),
    termination,
    checks: Array.isArray(checks) ? [...checks] : [],
    ...(acceptance ? { acceptance } : {}),
    usage: normalizeUsageForReceipt(usage),
  };
  const usageText = `${receipt.usage.quality}:in=${receipt.usage.inputTokens ?? 'unknown'}:out=${receipt.usage.outputTokens ?? 'unknown'}`;
  const summary = `direct worker ${transport} task=${taskId} attempt=${invocationId} `
    + `model=${observed?.model ?? requested?.model ?? 'unknown'} termination=${termination} usage=${usageText}`;
  return { receipt, operation: 'create', summary };
}

/** `value` if it is a string matching `pattern`; the fixed redaction marker
 * if it is a non-empty string that FAILS the pattern; `undefined` (omit the
 * key) if it is absent entirely. A planted secret never survives in its own
 * value: it is replaced, not merely left out of an allowlist. */
function safeField(value, pattern) {
  if (typeof value !== 'string' || !value) return undefined;
  return pattern.test(value) ? value : REDACTION_MARKER;
}

/** Same contract as `safeField`, checked against a closed enum instead of a pattern. */
function safeEnum(value, allowed) {
  if (typeof value !== 'string' || !value) return undefined;
  return allowed.includes(value) ? value : REDACTION_MARKER;
}

/**
 * Redact a receipt for query/export as an ALLOWLIST projection over
 * explicitly named safe fields only: version/mode/task/invocation IDs,
 * transport, profile version, descriptor digest, identity confidence,
 * termination, per-check `{ checkId, exitCode }` pairs, and usage with
 * confidence. Nothing is spread: `requested`, `observed`, `acceptance`,
 * `worktree`, `handle`, `profileRef`, `baseRevision` and every other field —
 * including any caller-added top-level field — never leave the conductor.
 *
 * An allowlisted FIELD NAME is not an allowlisted VALUE: every id and enum
 * above is additionally validated against a strict pattern or closed enum
 * (`taskId`, `invocationId`, `profileVersion`, `identityConfidence`,
 * `termination`, `checks[].checkId`). A present-but-invalid value — for
 * example a secret planted where an id was expected — is dropped and
 * replaced with the fixed `REDACTION_MARKER`, never written through as-is.
 * Usage confidence is always retained: unknown stays unknown, never zero.
 */
export function redactReceiptForExport(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw new DispatchEvidenceError('Export needs a receipt object', 'invalid-receipt');
  }
  const taskId = safeField(receipt.taskId, TASK_ID_PATTERN);
  const invocationId = safeField(receipt.invocationId, INVOCATION_PATTERN);
  const transport = receipt.transport === 'shell' || receipt.transport === 'mcp' ? receipt.transport : undefined;
  const profileVersion = safeField(receipt.profileVersion, PROFILE_VERSION_PATTERN);
  const descriptorDigest = typeof receipt.descriptorDigest === 'string' && DIGEST_PATTERN.test(receipt.descriptorDigest)
    ? receipt.descriptorDigest
    : undefined;
  const identityConfidence = safeEnum(receipt.identityConfidence, IDENTITY_CONFIDENCE_VALUES);
  const termination = safeEnum(receipt.termination, RECEIPT_TERMINATION_VALUES);
  const checks = Array.isArray(receipt.checks)
    ? receipt.checks.flatMap((check) => {
      if (!check || typeof check !== 'object') return [];
      const rawId = check.checkId;
      if (typeof rawId !== 'string' || !rawId) return [];
      const checkId = CHECK_ID_PATTERN.test(rawId) ? rawId : REDACTION_MARKER;
      if (check.exitCode !== null && check.exitCode !== undefined && !Number.isInteger(check.exitCode)) return [];
      return [{ checkId, exitCode: check.exitCode ?? null }];
    })
    : [];
  return {
    version: 1,
    mode: 'direct',
    ...(taskId ? { taskId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(transport ? { transport } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(descriptorDigest ? { descriptorDigest } : {}),
    ...(identityConfidence ? { identityConfidence } : {}),
    ...(termination ? { termination } : {}),
    checks,
    usage: normalizeUsageForReceipt(receipt.usage),
    redacted: true,
  };
}

/**
 * Read one artifact file and return its `file.digest` effect target
 * (`file:<canonical-relative-path>@sha256:<hex>`) for a digest-only effect
 * link. Mirrors `src/effects/verifiers/file.ts`: the input is lexically
 * normalized against the root FIRST (pure string arithmetic — `.`/`..` are
 * resolved and an escaping result refuses before any filesystem access),
 * then the resulting in-bounds components are walked one at a time through
 * an fd-pinned root handle kept open for the whole operation: a symlinked
 * directory anywhere along the walk, or a symlinked leaf, refuses instead of
 * being followed, and no ancestor swap between any two steps can redirect a
 * later one. The emitted path is the canonical, walked relative path — never
 * the raw input spelling. Bytes are read through the final `O_NOFOLLOW` fd.
 */
export async function fileDigestTarget({ root, path: relativePath }) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new DispatchEvidenceError('Effect link needs a relative artifact path', 'invalid-link');
  }
  if (typeof root !== 'string' || !root) {
    throw new DispatchEvidenceError('Effect link needs an evidence root', 'invalid-link');
  }
  const configuredRoot = resolve(root);
  const candidate = isAbsolute(relativePath) ? resolve(relativePath) : resolve(configuredRoot, relativePath);
  if (!inside(configuredRoot, candidate)) {
    throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
  }
  const components = relative(configuredRoot, candidate).split(sep).filter((part) => part !== '');
  if (components.length === 0) {
    throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
  }

  let rootHandle;
  try {
    rootHandle = await openTraced(configuredRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Effect link root is unavailable: ${configuredRoot} (${error?.code ?? error?.message ?? error})`,
      'storage-failure',
    );
  }
  try {
    let currentHandle = rootHandle;
    let ownsCurrent = false;
    try {
      for (let i = 0; i < components.length - 1; i += 1) {
        const ref = fdChildRef(currentHandle, components[i]);
        let next;
        try {
          next = await openTraced(ref, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (error) {
          if (error?.code === 'ELOOP') {
            throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
          }
          throw new DispatchEvidenceError(
            `Effect link target is unreadable: ${components.join('/')} (${error?.code ?? error?.message ?? error})`,
            'storage-failure',
          );
        }
        if (ownsCurrent) await currentHandle.close();
        currentHandle = next;
        ownsCurrent = true;
      }
      const leaf = components[components.length - 1];
      const ref = fdChildRef(currentHandle, leaf);
      let fileHandle;
      try {
        fileHandle = await openTraced(ref, O_RDONLY | O_NOFOLLOW);
      } catch (error) {
        if (error?.code === 'ELOOP') {
          throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
        }
        throw new DispatchEvidenceError(
          `Effect link target is unreadable: ${components.join('/')} (${error?.code ?? error?.message ?? error})`,
          'storage-failure',
        );
      }
      try {
        const stat = await fileHandle.stat();
        if (!stat.isFile()) {
          throw new DispatchEvidenceError(`Effect link target is not a regular file: ${String(relativePath)}`, 'invalid-link');
        }
        const bytes = await fileHandle.readFile();
        const digest = digestOf(bytes);
        return { target: `file:${components.join('/')}@${digest}`, digest };
      } finally {
        await fileHandle.close();
      }
    } finally {
      if (ownsCurrent) await currentHandle.close();
    }
  } finally {
    await rootHandle.close();
  }
}

/**
 * Build digest-only effect links for dispatch evidence: correlation IDs the
 * caller already holds plus `file.digest` targets over exact artifact bytes.
 * No raw content, no secrets, no second ledger — verification runs through
 * the existing effect ledger (`aiwg effect reconcile`).
 */
export function digestOnlyEffectLinks({ traceId = null, spanId = null, toolCallId = null, fileTargets = [] } = {}) {
  const links = {
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
  const targets = [...fileTargets];
  for (const target of targets) {
    if (typeof target !== 'string' || !/^file:.+@sha256:[a-f0-9]{64}$/.test(target)) {
      throw new DispatchEvidenceError('Effect links carry file.digest targets only', 'invalid-link');
    }
  }
  return { links, fileTargets: targets };
}

/**
 * Disk-pressure admission for one attempt: the #2954 resource-preflight gate
 * sampling the filesystems of the actual attempt root and worktree — never
 * the conductor's process cwd. When no live signals are injected, the gate
 * samples exactly these caller-supplied paths; unknown or unprovable free
 * disk fails closed.
 */
export function checkDispatchAdmission({
  config,
  attemptRoot,
  worktree = null,
  live,
  readers,
  thresholdOverlay,
} = {}) {
  if (typeof attemptRoot !== 'string' || !attemptRoot) {
    throw new DispatchEvidenceError('Dispatch admission needs the attempt root', 'invalid-attempt-root');
  }
  const paths = [attemptRoot, ...(typeof worktree === 'string' && worktree ? [worktree] : [])];
  return checkWorkerDispatch({ config, live, readers, thresholdOverlay, paths });
}
