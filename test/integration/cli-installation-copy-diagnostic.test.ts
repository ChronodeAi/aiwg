import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-copy-diagnostic-'));
  temporary.push(home);
  const running = path.join(home, '.nvm/versions/node/v24/lib/node_modules/aiwg');
  const registered = path.join(home, 'registered');
  const configDir = path.join(home, 'config');
  for (const root of [running, registered]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', type: 'module', version: '1.0.0' }));
  }
  // Use the production launcher and identity implementation without a build.
  for (const file of [
    'bin/aiwg.mjs',
    'src/installation/manager.mjs',
    'src/installation/manager-command.mjs',
    'src/process/bounded-child-process.mjs',
    'src/process/signal-child.mjs',
    'src/config/user-config-dir.mjs',
  ]) {
    const destination = path.join(running, file.startsWith('src/') ? `dist/${file}` : file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repo, file), destination);
  }
  const channel = path.join(running, 'dist/src/channel/manager.mjs');
  fs.mkdirSync(path.dirname(channel), { recursive: true });
  fs.writeFileSync(channel, 'export async function loadConfig() { return {}; }\nexport function resolveEffectiveInstallationRoot(root) { return root; }\n');
  const router = path.join(running, 'dist/src/cli/router.js');
  fs.mkdirSync(path.dirname(router), { recursive: true });
  fs.writeFileSync(router, 'export async function run() { console.log("handler reached"); }\n');
  const notifier = path.join(running, 'dist/src/update/notifier.mjs');
  fs.mkdirSync(path.dirname(notifier), { recursive: true });
  fs.writeFileSync(notifier, 'export const resolveActivePackageRoot = root => root;\nexport function maybePrintNotice() {}\nexport function scheduleBackgroundCheck() {}\n');
  fs.mkdirSync(configDir);
  const record = path.join(configDir, 'installation.json');
  fs.writeFileSync(record, JSON.stringify({
    schemaVersion: 1, method: 'npm', runMode: 'normal', channel: 'stable',
    root: registered, updateStrategy: 'npm-global', managerExecutable: process.execPath,
  }));
  const before = fs.readFileSync(record, 'utf8');
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const stdoutFile = path.join(home, 'stdout');
    const stderrFile = path.join(home, 'stderr');
    const stdoutFd = fs.openSync(stdoutFile, 'w');
    const stderrFd = fs.openSync(stderrFile, 'w');
    const child = spawn(process.execPath, [path.join(running, 'bin/aiwg.mjs'), ...args], {
      cwd: home, timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', stdoutFd, stderrFd],
      env: { PATH: path.dirname(process.execPath), HOME: home, AIWG_CONFIG: configDir, NO_UPDATE_NOTIFIER: '1' },
    });
    child.on('error', reject);
    child.on('close', status => {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      resolve({ status, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8') });
    });
  });
  return { running, registered, record, before, run };
}

describe('unregistered npm copy launcher diagnostics', () => {
  it('blocks index refresh and names both installs and actionable recovery', async () => {
    const f = fixture();
    const result = await f.run(['index', 'refresh']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Running installation: npm at ${f.running}`);
    expect(result.stderr).toContain(`Registered installation: npm at ${f.registered}`);
    expect(result.stderr).toContain('aiwg doctor');
    expect(result.stderr).toContain('aiwg installation adopt --method npm --yes');
    expect(result.stderr).toContain('npm uninstall -g aiwg');
    expect(result.stdout).not.toContain('handler reached');
    expect(fs.readFileSync(f.record, 'utf8')).toBe(f.before);
  });

  it('keeps doctor reachable with the same running and registered paths on stderr', async () => {
    const f = fixture();
    const result = await f.run(['doctor']);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toContain('`doctor` is read-only and continues');
    expect(result.stderr).toContain(`Running installation: npm at ${f.running}`);
    expect(result.stderr).toContain(`Registered installation: npm at ${f.registered}`);
    expect(result.stderr).toContain('aiwg installation adopt --method npm --yes');
    expect(result.stdout).toContain('handler reached');
    expect(fs.readFileSync(f.record, 'utf8')).toBe(f.before);
  });
});
