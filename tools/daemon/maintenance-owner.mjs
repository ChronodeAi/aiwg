/** Isolated deterministic owners: no supervisors, prompts, or shell. The only
 * install route is the opt-in `update.install` policy (never redeploys). */
import { runUpdateInstall, inMaintenanceWindow, validateUpdatePolicy } from './update-policy.mjs';
import { importImpl } from '../_resolve-impl.mjs';

export async function invokeOwner(job, { cwd = process.cwd(), now = Date.now } = {}) {
  const args = job.args || {};
  switch (job.kind) {
    case 'memory.audit':
    case 'memory.recommend':
    case 'memory.apply': {
      const { validateMemoryJobArgs } = await importImpl(import.meta.url, 'housekeeper/daemon-config.js');
      validateMemoryJobArgs(job.kind, args);
      if (job.kind === 'memory.apply') {
        const errors = validateUpdatePolicy({ windows: args.windows });
        if (errors.length) return { exitStatus: 2, uncertain: true, summary: errors.join('; ') };
        const window = inMaintenanceWindow(now(), args.windows, job.timezone || 'UTC');
        if (!window.inside) return { exitStatus: 2, state: 'deferred', reason: 'outside-maintenance-window', summary: window.reason };
      }
      const owner = await importImpl(import.meta.url, 'memory/scheduled.js');
      return job.kind === 'memory.apply' ? owner.applyScheduledMemory(args, cwd)
        : owner.reportScheduledMemory(job.kind, args, cwd, new Date(now()).toISOString());
    }
    case 'index.verify':
    case 'index.freshness': {
      const { probeIndexStatus } = await importImpl(import.meta.url, 'artifacts/index-status.js');
      const report = await probeIndexStatus(args.workspace || cwd, args.index);
      const selected = report.indices || [];
      const failed = selected.some(index => ['stale', 'degraded', 'unavailable'].includes(index.status));
      const unsupported = selected.length > 0 && selected.every(index => index.status === 'unsupported');
      return { exitStatus: failed || report.summary.warnings || (!args.index && report.summary.missing) ? 1 : unsupported ? null : 0,
        state: unsupported ? 'deferred' : undefined,
        summary: `Index status: ${report.summary.built} built, ${report.summary.missing} missing`, detail: report };
    }
    case 'index.reconcile':
    case 'index.refresh': {
      const { runIndexRefresh } = await importImpl(import.meta.url, 'artifacts/index-refresh.js');
      const flags = ['--json'];
      for (const [key, flag] of [['index', '--only'], ['workspace', '--workspace'], ['root', '--root']]) {
        if (args[key]) flags.push(flag, String(args[key]));
      }
      if (args.dryRun === true) flags.push('--dry-run');
      const report = await runIndexRefresh(flags, cwd);
      return { exitStatus: report.totals.errors ? 1 : 0,
        state: report.status === 'deferred' || report.totals.deferred ? 'deferred' : undefined,
        summary: `Index refresh: ${report.status}`, detail: report };
    }
    case 'cache.retention':
    case 'cache.prune': {
      const { cleanWebResourceCache } = await importImpl(import.meta.url, 'resources/cache-cleanup.js');
      const detail = cleanWebResourceCache(cwd, { cacheRoot: args.cacheRoot, dryRun: args.dryRun === true });
      return { exitStatus: 0, summary: `Cache cleanup: ${detail.removed.length} removed, ${detail.preserved.length} protected`, detail };
    }
    case 'update.check': {
      const { checkUpdateStatus } = await importImpl(import.meta.url, 'update/checker.mjs');
      const detail = await checkUpdateStatus({ channel: args.channel || 'stable' });
      return { exitStatus: detail.status === 'unsupported' ? null : 0,
        state: detail.status === 'unsupported' ? 'deferred' : undefined,
        summary: detail.status === 'unsupported' ? 'Update channel unsupported' : `Update check: ${detail.available ? 'available' : 'current'}`,
        detail };
    }
    case 'update.install': {
      // Every gate (opt-in, window, version policy, active work, preflight)
      // lives in update-policy.mjs; a failed gate is a deferred receipt here.
      return runUpdateInstall(job);
    }
    default: throw new Error(`Unsupported maintenance kind: ${job.kind}`);
  }
}

// One bounded worker with an IPC receipt; CLI logs cannot corrupt manual JSON stdout.
if (process.env.AIWG_MAINTENANCE_WORKER === '1' && process.send) {
  process.once('message', async job => {
    try { process.send(await invokeOwner(job), () => process.disconnect()); }
    catch (error) {
      process.send({ exitStatus: 1, summary: error.message }, () => process.disconnect());
    }
  });
}
