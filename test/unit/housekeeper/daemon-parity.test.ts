import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAINTENANCE_KINDS as CLI_KINDS, resolveDaemonConfigPath } from '../../../src/housekeeper/daemon-config.js';
import { MAINTENANCE_KINDS as RUNNER_KINDS } from '../../../tools/daemon/scheduled-task-runner.mjs';
import { Config } from '../../../tools/daemon/config.mjs';

// src/ cannot import tools/, so the housekeeper CLI mirrors two daemon facts.
// These tests fail when either side changes without the other.
describe('housekeeper CLI and daemon stay in parity', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts exactly the maintenance kinds the scheduled runner executes', () => {
    expect([...CLI_KINDS].sort()).toEqual([...RUNNER_KINDS].sort());
  });

  it.each([
    [['daemon.json']],
    [['daemon.yml', 'daemon.json']],
    [['daemon.yaml', 'daemon.yml', 'daemon.json']],
    [['daemon.yaml', 'daemon.json']],
  ])('resolves the same config file as the daemon when %j exist', (files: string[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-parity-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.aiwg'));
    for (const file of files) {
      const body = file.endsWith('.json') ? '{"daemon":{}}' : 'daemon: {}\n';
      fs.writeFileSync(path.join(root, '.aiwg', file), body);
    }
    const daemon = new Config(path.join(root, '.aiwg', 'daemon.json'));
    daemon.load();
    expect(resolveDaemonConfigPath(root).path).toBe(daemon.configPath);
  });
});
