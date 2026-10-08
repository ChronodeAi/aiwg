import { describe, expect, it, vi } from 'vitest';
import * as preflight from '../../../tools/scripts/resource-preflight.mjs';
import {
  checkWorkerDispatch,
  defaultCountWorkers,
  countWorkerUnits,
  evaluateDispatchGate,
  evaluatePreflight,
  parseLoadAverages,
  parseMemAvailableGb,
  parseMemoryPsi,
  readLiveHostResources,
  resolveDispatchThresholds,
} from '../../../tools/scripts/resource-preflight.mjs';

describe('build resource preflight', () => {
  it('skips when the config block is absent', () => {
    const result = evaluatePreflight({}, {
      memory_gb: 1,
      free_disk_gb: 1,
      cpus: 1,
      swap_gb: 0,
    });

    expect(result.enabled).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('checks explicit configured requirements and reports each insufficient resource', () => {
    const result = evaluatePreflight({
      build: {
        resource_preflight: {
          enabled: true,
          mode: 'configured',
          requirements: {
            min_memory_gb: 16,
            min_free_disk_gb: 50,
            min_cpus: 8,
            min_swap_gb: 4,
          },
        },
      },
    }, {
      memory_gb: 8,
      free_disk_gb: 20,
      cpus: 4,
      swap_gb: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.resource)).toEqual([
      'memory',
      'free disk',
      'CPU cores',
      'swap',
    ]);
  });

  it('fills omitted requirements in auto_detect mode', () => {
    const result = evaluatePreflight({
      build: {
        resource_preflight: {
          enabled: true,
          mode: 'auto_detect',
          requirements: {
            min_free_disk_gb: 10,
          },
        },
      },
    }, {
      memory_gb: 16,
      free_disk_gb: 12,
      cpus: 4,
      swap_gb: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.requirements).toMatchObject({
      min_memory_gb: 8,
      min_free_disk_gb: 10,
      min_cpus: 2,
      min_swap_gb: 0,
    });
  });

  it('treats zero thresholds as disabled checks', () => {
    const result = evaluatePreflight({
      build: {
        resource_preflight: {
          enabled: true,
          mode: 'configured',
          requirements: {
            min_swap_gb: 0,
          },
        },
      },
    }, {
      memory_gb: 1,
      free_disk_gb: 1,
      cpus: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('dispatch live-signal parsers (FR-OG-107)', () => {
  it('parses MemAvailable kB into GiB', () => {
    const meminfo = 'MemTotal:        62735756 kB\nMemFree:           12345 kB\nMemAvailable:    16777216 kB\nSwapTotal:       2097148 kB\n';
    expect(parseMemAvailableGb(meminfo)).toBeCloseTo(16, 5);
    expect(parseMemAvailableGb('MemTotal: 100 kB\n')).toBeUndefined();
    expect(parseMemAvailableGb(undefined)).toBeUndefined();
  });

  it('parses memory pressure some avg10/avg60/avg300', () => {
    const pressure = 'some avg10=62.24 avg60=62.58 avg300=62.97 total=16403780000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    expect(parseMemoryPsi(pressure)).toEqual({ avg10: 62.24, avg60: 62.58, avg300: 62.97 });
    expect(parseMemoryPsi('full avg10=1.00 avg60=2.00 avg300=3.00 total=9\n')).toBeNull();
    expect(parseMemoryPsi('')).toBeNull();
  });

  it('parses load averages', () => {
    expect(parseLoadAverages('64.5 55.1 40.2 12/3456 7890\n')).toEqual({ load1: 64.5, load5: 55.1, load15: 40.2 });
    expect(parseLoadAverages('not a loadavg\n')).toBeNull();
  });

  it('samples live signals through injectable readers', () => {
    const live = readLiveHostResources({
      readText: (path) => {
        if (path === '/proc/meminfo') return 'MemAvailable:     8388608 kB\n';
        if (path === '/proc/loadavg') return '4.0 3.0 2.0 1/100 200\n';
        if (path === '/proc/pressure/memory') return 'some avg10=5.00 avg60=4.00 avg300=3.00 total=99\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
        throw new Error(`ENOENT: ${path}`);
      },
      coreCount: () => 8,
      countWorkers: () => 2,
    });
    expect(live).toMatchObject({
      supported: true, availMemGb: 8, load1: 4.0, cores: 8, loadRatio: 0.5,
      memPsiAvg10: 5, memPsiAvg60: 4, workers: 2,
    });
  });
});

describe('dispatch gate (FR-OG-107)', () => {
  const healthyLive = {
    supported: true, availMemGb: 24, load1: 8, cores: 32, loadRatio: 0.25,
    memPsiAvg10: 2, memPsiAvg60: 1, memPsiAvg300: 1, workers: 1,
  };
  // Titan incident shape: 32 cores, load 60-100, PSI avg60 ~62.
  const incidentLive = {
    supported: true, availMemGb: 4, load1: 80, cores: 32, loadRatio: 2.5,
    memPsiAvg10: 62.24, memPsiAvg60: 62.58, memPsiAvg300: 62.97, workers: 6,
  };

  it('resolves conservative defaults and validates thresholds', () => {
    expect(resolveDispatchThresholds()).toMatchObject({
      min_avail_mem_gb: 8, max_load_ratio: 1.0, max_mem_psi_avg10: 30, max_mem_psi_avg60: 10,
    });
    expect(resolveDispatchThresholds({}).max_workers).toBeUndefined();
    expect(() => resolveDispatchThresholds({ overlay: { max_load_ratio: -1 } })).toThrow(/non-negative/);
    expect(() => resolveDispatchThresholds({ overlay: { max_workers: 0 } })).toThrow(/max_workers/);
  });

  it('passes a healthy host', () => {
    const result = evaluateDispatchGate(healthyLive, resolveDispatchThresholds());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('BLOCKs the incident host naming every failing signal', () => {
    const result = evaluateDispatchGate(incidentLive, resolveDispatchThresholds());
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.signal)).toEqual([
      'avail-mem', 'load', 'mem-psi-avg10', 'mem-psi-avg60',
    ]);
  });

  it('BLOCKs on worker count only when max_workers is configured', () => {
    const crowded = { ...healthyLive, workers: 9 };
    expect(evaluateDispatchGate(crowded, resolveDispatchThresholds()).ok).toBe(true);
    const limited = evaluateDispatchGate(crowded, resolveDispatchThresholds({ overlay: { max_workers: 4 } }));
    expect(limited.ok).toBe(false);
    expect(limited.failures.map((failure) => failure.signal)).toEqual(['workers']);
  });

  it('fails closed on undetectable signals and unsupported platforms', () => {
    const unknown = evaluateDispatchGate({ supported: true }, resolveDispatchThresholds());
    expect(unknown.ok).toBe(false);
    expect(unknown.failures.map((failure) => failure.signal)).toEqual([
      'avail-mem', 'load', 'mem-psi-avg10', 'mem-psi-avg60',
    ]);
    const platform = evaluateDispatchGate({ supported: false, reason: 'no /proc here' }, resolveDispatchThresholds());
    expect(platform.ok).toBe(false);
    expect(platform.failures).toEqual([{ signal: 'platform', reason: 'no /proc here' }]);
  });
});

describe('checkWorkerDispatch Tier 0 entry point', () => {
  const readers = (live) => ({
    readText: () => { throw new Error('must not sample when disabled'); },
    coreCount: () => { throw new Error('must not sample when disabled'); },
    countWorkers: () => { throw new Error('must not sample when disabled'); },
    live,
  });

  it('leaves legacy behaviour untouched when worker_dispatch is off', () => {
    for (const config of [undefined, null, {}, { parallelism: {} }, { parallelism: { worker_dispatch: false } }]) {
      const result = checkWorkerDispatch({ config, readers: readers() });
      expect(result).toMatchObject({ enabled: false, ok: true });
      expect(result.failures).toEqual([]);
    }
  });

  it('gates dispatch when worker_dispatch is on', () => {
    const config = { parallelism: { worker_dispatch: true } };
    const blocked = checkWorkerDispatch({
      config,
      live: {
        supported: true, availMemGb: 1, load1: 64, cores: 32, loadRatio: 2,
        memPsiAvg10: 50, memPsiAvg60: 40, workers: 0,
      },
    });
    expect(blocked.enabled).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(blocked.failures.length).toBeGreaterThan(0);

    const allowed = checkWorkerDispatch({
      config,
      live: {
        supported: true, availMemGb: 32, load1: 4, cores: 32, loadRatio: 0.125,
        memPsiAvg10: 1, memPsiAvg60: 1, workers: 0,
      },
    });
    expect(allowed).toMatchObject({ enabled: true, ok: true });
  });

  it('clamps build dispatch, admission hostResources, and overlay', () => {
    const config = {
      parallelism: { worker_dispatch: true, admission: { hostResources: { min_avail_mem_gb: 2 } } },
      build: { resource_preflight: { dispatch: { min_avail_mem_gb: 4, max_load_ratio: 0.5 } } },
    };
    const live = {
      supported: true, availMemGb: 3, load1: 4, cores: 32, loadRatio: 0.125,
      memPsiAvg10: 1, memPsiAvg60: 1, workers: 0,
    };
    // Admission cannot lower the configured memory floor.
    expect(checkWorkerDispatch({ config, live }).ok).toBe(false);
    // A stricter task memory floor blocks.
    const overlaid = checkWorkerDispatch({ config, live, thresholdOverlay: { min_avail_mem_gb: 16 } });
    expect(overlaid.ok).toBe(false);
    expect(overlaid.failures.map((failure) => failure.signal)).toEqual(['avail-mem']);
  });

  it('rejects invalid configured thresholds with a typed failure', () => {
    const result = checkWorkerDispatch({
      config: { parallelism: { worker_dispatch: true, admission: { hostResources: { max_load_ratio: -2 } } } },
      live: { supported: true },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ signal: 'thresholds', reason: expect.stringContaining('max_load_ratio') }]);
  });
});


describe('dispatch regression checks (#2954 review)', () => {
  it('cannot relax a configured ceiling with admission or a task overlay', () => {
    const config = {
      parallelism: { worker_dispatch: true, admission: { hostResources: { max_load_ratio: 10 } } },
      build: { resource_preflight: { dispatch: { max_load_ratio: 1 } } },
    };
    const live = { supported: true, availMemGb: 32, loadRatio: 2, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0 };
    for (const candidate of [config, { parallelism: { worker_dispatch: true } }]) {
      for (const thresholdOverlay of [undefined, { max_load_ratio: 10 }]) {
        expect(checkWorkerDispatch({ config: candidate, live, thresholdOverlay }).failures).toContainEqual(expect.objectContaining({ signal: 'load', threshold: 1 }));
      }
    }
  });

  it('blocks the next launch at the exact worker cap', () => {
    const live = { supported: true, availMemGb: 32, loadRatio: 0, memPsiAvg10: 0, memPsiAvg60: 0, workers: 3 };
    expect(evaluateDispatchGate(live, resolveDispatchThresholds({ overlay: { max_workers: 3 } })).ok).toBe(false);
    expect(evaluateDispatchGate({ ...live, workers: 2 }, resolveDispatchThresholds({ overlay: { max_workers: 3 } })).ok).toBe(true);
  });

  it('counts only exact worker comm names for the current UID', () => {
    const records = {
      '1': { uid: 1000, comm: 'codex' },
      '2': { uid: 2000, comm: 'codex' },
      '3': { uid: 1000, comm: 'muse-bin' },
      '4': { uid: 1000, comm: 'bash' },
      '5': { uid: 1000, comm: 'node' },
      '6': { uid: 1000, comm: 'muse-bin-fake' },
    };
    expect(defaultCountWorkers({
      uid: 1000, countWorkerUnits: () => undefined,
      readDir: () => Object.keys(records),
      readText: path => {
        const [, , pid, field] = path.split('/');
        const record = records[pid];
        if (field === 'comm') return record.comm;
        if (field === 'status') return `Uid: ${record.uid} ${record.uid} ${record.uid} ${record.uid}\n`;
        return 'shell mentions muse-bin; node resource-preflight.mjs';
      },
    })).toBe(2);
  });

  it('takes the larger of aiwg-worker units and current-user worker processes so no worker class hides', () => {
    expect(defaultCountWorkers({ countWorkerUnits: () => 3, readDir: () => [] })).toBe(3);
    // Zero units but live worker processes (degraded launches, other conductors) must still count.
    const records = { 11: { uid: 1000, comm: 'codex' }, 12: { uid: 1000, comm: 'codex' }, 13: { uid: 1000, comm: 'muse-bin' } };
    const readText = path => {
      const [, , pid, field] = path.split('/');
      return field === 'comm' ? records[pid].comm : `Uid: ${records[pid].uid} ${records[pid].uid} ${records[pid].uid} ${records[pid].uid}\n`;
    };
    expect(defaultCountWorkers({ uid: 1000, countWorkerUnits: () => 0, readDir: () => Object.keys(records), readText })).toBe(3);
    expect(defaultCountWorkers({ uid: 1000, countWorkerUnits: () => 1, readDir: () => Object.keys(records), readText })).toBe(3);
    expect(defaultCountWorkers({ uid: 1000, countWorkerUnits: () => 5, readDir: () => Object.keys(records), readText })).toBe(5);
    // Unreadable /proc falls back to the unit count.
    expect(defaultCountWorkers({ uid: 1000, countWorkerUnits: () => 2, readDir: () => { throw new Error('no proc'); } })).toBe(2);
  });

  it.each([{ AIWG_BUILD_PREFLIGHT_DONE: '1' }, { AIWG_BUILD_PREFLIGHT: '0' }, { AIWG_BUILD_PREFLIGHT: 'false' }])('dispatch ignores legacy build bypass %j', env => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      const result = preflight.main({
        argv: ['--profile', 'dispatch'], env,
        live: { supported: true, availMemGb: 32, load1: 0, cores: 8, loadRatio: 0, memPsiAvg10: 0, memPsiAvg60: 0, workers: 0 },
        readConfig: () => ({ config: { parallelism: { worker_dispatch: true, admission: { hostResources: { min_avail_mem_gb: 1e9 } } } }, configPath: 'synthetic' }),
      });
      expect(result.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previous; }
  });

  it('preserves legacy build bypass before reading config', () => {
    expect(preflight.main({ argv: ['--profile', 'cli'], env: { AIWG_BUILD_PREFLIGHT_DONE: '1' }, readConfig: () => { throw new Error('must not read'); } })).toBeUndefined();
  });
});


it('counts only worker-prefixed active services from the current user manager', () => {
  const calls = [];
  expect(countWorkerUnits({ spawn: (binary, args) => {
    calls.push([binary, ...args]);
    return { status: 0, stdout: 'aiwg-worker-one.service loaded active running one\n  aiwg-worker-two.service loaded activating start two\nother.service loaded active running other\n' };
  } })).toBe(2);
  expect(calls[0]).toContain('--user');
  expect(calls[0]).toContain('--state=running,activating');
  expect(calls[0]).toContain('aiwg-worker-*');
  expect(countWorkerUnits({ spawn: () => ({ status: 1 }) })).toBeUndefined();
});
