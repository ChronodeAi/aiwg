/** Shared runtime resolver for config consumers and direct preflight tools. */
export const DEFAULT_DISPATCH_HOST_THRESHOLDS = Object.freeze({
  min_avail_mem_gb: 8,
  max_load_ratio: 1.0,
  max_mem_psi_avg10: 30,
  max_mem_psi_avg60: 10,
});

/**
 * Configured layers can only tighten one another and the conservative defaults;
 * minimums take MAX and maximums take MIN across build, admission and task.
 * Validate each layer before merging so an invalid value cannot be hidden.
 */
export function resolveDispatchHostThresholds(buildDispatch, admissionHostResources, overlay) {
  const configured = { ...DEFAULT_DISPATCH_HOST_THRESHOLDS };
  const keys = [...Object.keys(DEFAULT_DISPATCH_HOST_THRESHOLDS), 'max_workers'];
  for (const layer of [buildDispatch, admissionHostResources, overlay]) {
    if (layer === undefined) continue;
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      throw new Error('OG_CONFIG_REFERENCE dispatch thresholds: must be an object');
    }
    for (const key of keys) {
      const value = layer[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`OG_CONFIG_REFERENCE dispatch threshold ${key}: must be a non-negative number`);
      }
      if (key === 'max_workers' && (!Number.isInteger(value) || value < 1)) {
        throw new Error('OG_CONFIG_REFERENCE dispatch threshold max_workers: must be an integer >= 1 when set');
      }
      configured[key] = configured[key] === undefined ? value
        : key.startsWith('min_') ? Math.max(configured[key], value) : Math.min(configured[key], value);
    }
  }
  return { ...DEFAULT_DISPATCH_HOST_THRESHOLDS, ...configured };
}
