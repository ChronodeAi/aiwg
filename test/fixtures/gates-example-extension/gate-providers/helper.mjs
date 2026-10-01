/**
 * Local helper resolved as part of the provider code digest (#2831).
 * Any byte change here moves the digest, so bindings refuse until re-pinned.
 */

export function assertFlakeRecord(row) {
  if (!row || typeof row.slice !== 'string' || !row.slice.trim() || typeof row.failed !== 'boolean') {
    throw new Error('flake records require a nonempty slice and a boolean failed');
  }
}
