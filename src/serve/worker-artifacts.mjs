/** Validate bounded artifact declarations without touching the worker filesystem. */
import path from 'node:path';

const safeId = /^[a-z0-9][a-z0-9-]{0,51}$/;
const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const allowed = new Set(['name', 'content', 'location', 'prefix', 'relativePath']);

function normalizedRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..')
    && path.posix.normalize(value) === value;
}

/** The installed module owns the prefix; its loader rechecks the whole declaration. */
export function validateWorkerArtifacts(invocation) {
  const artifacts = invocation.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 16) throw new Error('Worker artifact count exceeds bound');
  const names = new Set();
  let total = 0, workspaceCount = 0;
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.name !== 'string' || !safeName.test(artifact.name)
      || /[^A-Za-z0-9_-]/.test(artifact.name) || names.has(artifact.name)
      || typeof artifact.content !== 'string' || Object.keys(artifact).some(key => !allowed.has(key))) {
      throw new Error('Invalid worker artifact declaration');
    }
    names.add(artifact.name);
    const size = Buffer.byteLength(artifact.content);
    total += size;
    if (size > 1048576 || total > 4194304) throw new Error('Worker artifact bytes exceed bound');
    if (artifact.location === 'workspace-relative') {
      if (++workspaceCount > 1) throw new Error('Only one workspace-relative worker artifact is allowed');
      const { prefix, relativePath } = artifact;
      const id = invocation.invocationId;
      if (typeof id !== 'string' || !safeId.test(id) || /[^a-z0-9-]/.test(id)) throw new Error('Invalid worker artifact invocation id');
      if (!normalizedRelative(prefix) || prefix.length > 256 || !prefix.endsWith('-')
        || !normalizedRelative(relativePath) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(path.posix.basename(relativePath))
        || path.posix.dirname(relativePath) !== `${prefix}${id}`) {
        throw new Error('Worker artifact path must be normalized and bound to its prefix and invocation id');
      }
      if (typeof invocation.cwd !== 'string' || !path.posix.isAbsolute(invocation.cwd)
        || /[\\\x00-\x1f\x7f]/.test(invocation.cwd) || path.posix.normalize(invocation.cwd) !== invocation.cwd) {
        throw new Error('Worker artifact requires a normalized absolute cwd');
      }
      const target = path.posix.resolve(invocation.cwd, relativePath);
      if (!target.startsWith(`${invocation.cwd === '/' ? '' : invocation.cwd}/`)) throw new Error('Worker artifact escapes cwd');
      if (['briefPath', 'stdoutPath', 'stderrPath', 'finalPath'].some(key => invocation[key] && path.resolve(invocation[key]) === target)) {
        throw new Error('Worker artifact and input/output paths must be distinct');
      }
    } else if (artifact.location !== undefined && artifact.location !== 'run-directory'
      || artifact.prefix !== undefined || artifact.relativePath !== undefined) {
      throw new Error('Invalid worker artifact declaration');
    }
  }
  return artifacts;
}
