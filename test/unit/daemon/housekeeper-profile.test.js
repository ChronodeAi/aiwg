/**
 * Housekeeper profile tests (epic #3353 slice B5).
 *
 * Proves the minimal profile never constructs the conversational stack
 * (spy/inject at the construction sites from design-note §1.2), that the
 * default profile still does, and that the minimal IPC subset answers
 * while conversational methods stay unregistered.
 */

process.env.AIWG_DAEMON_NO_AUTOSTART = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { DaemonMain } = await import('../../../tools/daemon/daemon-main.mjs');
const { Config } = await import('../../../tools/daemon/config.mjs');

const SKIPPED_MODULES = [
  'MemoryManager',
  'AgentSupervisor',
  'DaemonSupervisor',
  'BehaviorRegistry',
  'DaemonBehaviorLoader',
  'MessageRouter',
  'AutomationEngine',
  'AutonomousEngine',
  'ProviderWatcher',
  'WebServer',
];

async function throwingDeps() {
  const deps = {};
  for (const name of SKIPPED_MODULES) {
    deps[name] = class {
      constructor() {
        throw new Error(`${name} must never be constructed in the housekeeper profile`);
      }
    };
  }
  // The deterministic dispatcher is allowed; keep the real one.
  deps.ScheduledTaskRunner = (await import('../../../tools/daemon/scheduled-task-runner.mjs')).ScheduledTaskRunner;
  return deps;
}

function housekeeperConfig(extra = {}) {
  return {
    get: (key) => {
      if (key === 'daemon.profile') return 'housekeeper';
      if (key === 'watch') return { enabled: false };
      if (key === 'schedule') return { enabled: false, jobs: [] };
      return extra[key];
    },
  };
}

let root;
let daemon;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-profile-'));
});

afterEach(async () => {
  if (daemon?.ipcServer) {
    try {
      await daemon.ipcServer.stop();
    } catch { /* already stopped */ }
  }
  daemon = null;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('housekeeper profile construction boundary', () => {
  it('never constructs the skipped conversational modules', async () => {
    const { ScheduledTaskRunner } = await import('../../../tools/daemon/scheduled-task-runner.mjs');
    const constructed = [];
    const counting = {};
    for (const name of SKIPPED_MODULES) {
      counting[name] = class {
        constructor() {
          constructed.push(name);
          throw new Error(`${name} must never be constructed in the housekeeper profile`);
        }
      };
    }
    daemon = new DaemonMain({ ...counting, ScheduledTaskRunner });
    daemon.config = housekeeperConfig();
    daemon.taskStorePath = path.join(root, 'tasks.json');
    daemon.socketPath = path.join(root, 'daemon.sock');

    await daemon.initializeHousekeeperSubsystems();

    expect(constructed).toEqual([]);
    expect(daemon.memoryManager).toBeNull();
    expect(daemon.supervisor).toBeNull();
    expect(daemon.daemonSupervisor).toBeNull();
    expect(daemon.behaviorRegistry).toBeNull();
    expect(daemon.behaviorLoader).toBeNull();
    expect(daemon.messageRouter).toBeNull();
    expect(daemon.automationEngine).toBeNull();
    expect(daemon.roomManager).toBeNull();
    expect(daemon.messagingBus).toBeNull();
    expect(daemon.autonomousEngine).toBeNull();
    expect(daemon.providerWatcher).toBeNull();
    expect(daemon.webServer).toBeNull();
    expect(daemon.eventRouter).not.toBeNull();
    expect(daemon.taskStore).not.toBeNull();
    expect(daemon.ipcServer).not.toBeNull();
    expect(daemon.scheduledTaskRunner).not.toBeNull();
    expect(daemon.cronScheduler).toBeNull();
  });

  it('default profile still constructs the conversational stack', async () => {
    const constructed = [];
    const stub = (name, extra = {}) => class {
      constructor() {
        constructed.push(name);
        Object.assign(this, extra);
      }
    };
    const { ScheduledTaskRunner } = await import('../../../tools/daemon/scheduled-task-runner.mjs');
    daemon = new DaemonMain({
      MemoryManager: stub('MemoryManager', { load: () => ({ project: [], user: [] }) }),
      AgentSupervisor: stub('AgentSupervisor', { on: () => {}, getStatus: () => ({}) }),
      DaemonSupervisor: stub('DaemonSupervisor', { on: () => {}, status: () => ({}) }),
      BehaviorRegistry: stub('BehaviorRegistry', { loadAll: async () => new Map() }),
      DaemonBehaviorLoader: stub('DaemonBehaviorLoader', { loadAll: async () => new Map(), getStatus: () => ({}) }),
      MessageRouter: stub('MessageRouter', { broadcast: () => {} }),
      AutomationEngine: stub('AutomationEngine', { getStatus: () => ({}), loadRules: () => {}, processEvent: () => {} }),
      AutonomousEngine: stub('AutonomousEngine', { on: () => {} }),
      ProviderWatcher: stub('ProviderWatcher', { on: () => {} }),
      WebServer: stub('WebServer', { start: async () => {} }),
      ScheduledTaskRunner: stub('ScheduledTaskRunner', { on: () => {}, start: () => {}, stop: () => {}, getStatus: () => ({}) }),
    });
    daemon.config = {
      get: (key) => {
        if (key === 'daemon.profile') return undefined;
        if (key === 'daemon.max_parallel_actions') return 1;
        if (key === 'watch') return { enabled: false };
        if (key === 'schedule') return { enabled: false };
        if (key === 'rules') return [];
        return undefined;
      },
    };
    daemon.taskStorePath = path.join(root, 'tasks.json');
    daemon.socketPath = path.join(root, 'daemon.sock');

    // RoomManager/messaging dynamic imports may fail in this env; both are
    // non-fatal try/catch paths in the default initializer.
    await daemon.initializeSubsystems();

    for (const name of ['MemoryManager', 'AgentSupervisor', 'DaemonSupervisor', 'MessageRouter', 'AutomationEngine']) {
      expect(constructed).toContain(name);
    }
    await daemon.ipcServer.stop();
  });
});

describe('housekeeper IPC subset', () => {
  beforeEach(async () => {
    daemon = new DaemonMain(await throwingDeps());
    daemon.config = housekeeperConfig();
    daemon.taskStorePath = path.join(root, 'tasks.json');
    daemon.socketPath = path.join(root, 'daemon.sock');
    await daemon.initializeHousekeeperSubsystems();
  });

  it('registers only the minimal method subset', () => {
    const methods = [...daemon.ipcServer.handlers.keys()];
    for (const allowed of ['ping', 'daemon.status', 'schedule.status', 'housekeeper.status',
      'housekeeper.jobs', 'task.list', 'task.get', 'task.stats']) {
      expect(methods).toContain(allowed);
    }
    for (const denied of ['chat.send', 'memory.show', 'memory.clear', 'memory.write', 'memory.context',
      'behaviors.status', 'behaviors.list', 'behaviors.apply', 'behaviors.remove',
      'autonomous.status', 'autonomous.enable', 'autonomous.disable',
      'task.submit', 'task.cancel', 'automation.status', 'automation.enable', 'automation.disable',
      'provider-watch.status', 'provider-watch.check', 'rooms.list']) {
      expect(methods).not.toContain(denied);
    }
  });

  it('daemon.status answers without the conversational stack', () => {
    const status = daemon.ipcServer.handlers.get('daemon.status')();
    expect(status.profile).toBe('housekeeper');
    expect(status.subsystems.supervisor).toEqual({ enabled: false });
    expect(status.subsystems.automation).toEqual({ enabled: false });
  });

  it('housekeeper.status follows the B1 §6 shape', async () => {
    const status = await daemon.getHousekeeperStatus();
    expect(status.profile).toBe('housekeeper');
    expect(status.pid).toBe(process.pid);
    expect(typeof status.uptimeSeconds).toBe('number');
    expect(status.jobs).toEqual([]);
    expect(Array.isArray(status.freshness)).toBe(true);
    expect(status.update).toMatchObject({ checkOnly: true });
  });
});

describe('daemon.profile config validation', () => {
  it('rejects unknown profiles and prompt jobs in the housekeeper profile', () => {
    const config = new Config();
    config.config = { daemon: { profile: 'chatty' }, schedule: { enabled: false } };
    expect(config.validate().join(';')).toMatch(/daemon\.profile/);

    config.config = {
      daemon: { profile: 'housekeeper' },
      schedule: { enabled: true, jobs: [{ id: 'x', action: 'doctor' }] },
    };
    expect(config.validate().join(';')).toMatch(/not allowed in the housekeeper profile/);

    config.config = {
      daemon: { profile: 'housekeeper' },
      schedule: { enabled: true, jobs: [{ id: 'x', kind: 'cache.prune', cron: '0 * * * *' }] },
    };
    expect(config.validate()).toEqual([]);
  });
});
