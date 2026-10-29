// Normalize host measurements, tighten-only thresholds and remaining worker capacity.
import { resolveDispatchHostThresholds } from './dispatch-thresholds-runtime.mjs';
import { evaluateDispatchGate, readLiveHostResources } from './host-resource-runtime.mjs';

export function hostResourceReport({ config, live, readers, paths, thresholdOverlay, caps } = {}) {
  const measured = live ?? readLiveHostResources({ ...readers, paths });
  const origins = {};
  let thresholds;
  try {
    thresholds = resolveDispatchHostThresholds(config?.build?.resource_preflight?.dispatch,
      config?.parallelism?.admission?.hostResources, thresholdOverlay, origins);
  } catch (error) {
    return { measured, thresholds: null, origins, slots: 0, ok: false, limits: [],
      failures: [{ signal: 'thresholds', reason: error.message }] };
  }
  const gate = evaluateDispatchGate(measured, thresholds);
  const names = { 'avail-mem': 'min_avail_mem_gb', load: 'max_load_ratio',
    'mem-psi-avg10': 'max_mem_psi_avg10', 'mem-psi-avg60': 'max_mem_psi_avg60',
    'free-disk': 'min_free_disk_gb', workers: 'max_workers' };
  const failures = gate.failures.map(failure => ({ ...failure, signal: names[failure.signal] ?? failure.signal }));
  const limits = [];
  const add = (threshold, available, reason) => {
    const slots = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
    limits.push({ threshold, slots });
    if (slots === 0) failures.push({ signal: threshold, reason });
  };
  // Floors act as conservative per-slot budgets; PSI is a binary pressure gate.
  if (thresholds.min_avail_mem_gb > 0) add('min_avail_mem_gb', measured.availMemGb / thresholds.min_avail_mem_gb,
    'min_avail_mem_gb: insufficient available memory for another worker');
  if (thresholds.min_free_disk_gb > 0) add('min_free_disk_gb', measured.freeDiskGb / thresholds.min_free_disk_gb,
    'min_free_disk_gb: insufficient free disk for another worker');
  add('max_load_ratio', thresholds.max_load_ratio * measured.cores - measured.load1,
    'max_load_ratio: less than one core of load headroom');
  if (thresholds.max_workers !== undefined) add('max_workers', thresholds.max_workers - measured.workers,
    'max_workers: running workers exhaust the host ceiling or cannot be counted');
  const parallelism = config?.parallelism;
  const admission = caps ?? [
    { threshold: 'max_parallel_subagents', limit: parallelism?.max_parallel_subagents },
    ...Object.entries(parallelism?.groups ?? {}).filter(([, group]) => group.enabled !== false)
      .map(([id, group]) => ({ threshold: `groups.${id}.maxParallel`, limit: group.maxParallel })),
    ...['groupCaps', 'memberCaps', 'cliCaps', 'modelCaps', 'quotaCaps'].flatMap(kind =>
      Object.entries(parallelism?.admission?.[kind] ?? {}).map(([id, limit]) => ({ threshold: `admission.${kind}.${id}`, limit }))),
  ];
  // No trusted group/model attribution exists: subtract the owned worker total.
  // Request/current capacities already describe remaining slots and use running=0.
  for (const { threshold, limit, running = measured.workers } of admission) {
    if (limit !== undefined && limit !== null) add(threshold, limit - running,
      `${threshold}: admission capacity exhausted or worker count unavailable`);
  }
  const slots = failures.length ? 0 : Math.min(...limits.map(limit => limit.slots));
  return { measured, thresholds, origins, slots, ok: slots > 0, limits, failures,
    counting: 'current UID AIWG worker units plus distinct AIWG_WORKER_INVOCATION_ID markers outside those units; '
      + (measured.workerCountingSource === 'owned-process-fallback' ? 'systemd unavailable: owned-process fallback; ' : '')
      + 'hostCliProcesses: exact codex/muse/muse-bin comm, informational, not used for admission; scoped caps conservatively use owned worker total' };
}
