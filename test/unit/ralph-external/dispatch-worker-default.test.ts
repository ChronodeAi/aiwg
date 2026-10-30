import { expect, it } from 'vitest';
import { checkWorkerDispatch } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { checkDispatchAdmission } from '../../../tools/ralph-external/lib/dispatch-evidence.mjs';
import { healthyHostResources } from '../../fixtures/host-resources.js';

it('shares default and configured worker caps across launcher and evidence admission', () => {
  const config = { parallelism: { worker_dispatch: true } } as any;
  const live = { ...healthyHostResources(), workers: 6 };
  for (const gate of [checkWorkerDispatch, (options: any) => checkDispatchAdmission({ ...options, attemptRoot: '/synthetic/attempt' })]) {
    expect(gate({ config, live })).toMatchObject({ ok: false, thresholds: { max_workers: 5 },
      failures: [{ signal: 'workers', threshold: 5 }] });
    config.build = { resource_preflight: { dispatch: { max_workers: 10 } } };
    expect(gate({ config, live })).toMatchObject({ ok: true, thresholds: { max_workers: 10 } });
    config.parallelism.admission = { hostResources: { max_workers: 7 } };
    expect(gate({ config, live })).toMatchObject({ ok: true, thresholds: { max_workers: 7 } });
    expect(gate({ config, live, thresholdOverlay: { max_workers: 6 } })).toMatchObject({ ok: false, thresholds: { max_workers: 6 } });
    delete config.build;
    delete config.parallelism.admission;
  }
});
