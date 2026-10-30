/**
 * Autostart unit renderers for `aiwg housekeeper install` (epic #3353 B5).
 *
 * Platform matrix (design note §3): Linux + systemd is documented;
 * Linux without systemd and macOS fall back to foreground `start` or an
 * external timer calling `run-once`; Windows is unsupported (WSL2 follows
 * the Linux rows). Units are pure strings here so `--dry-run` can print
 * them without writing and tests can assert content with an injected
 * platform. This module never enables anything: enabling is an explicit
 * operator step printed by the handler, never performed implicitly.
 */

import os from 'node:os';
import path from 'node:path';

export const HOUSEKEEPER_SERVICE_NAME = 'aiwg-housekeeper.service';
export const HOUSEKEEPER_TIMER_NAME = 'aiwg-housekeeper.timer';
export const HOUSEKEEPER_LAUNCHD_LABEL = 'dev.aiwg.housekeeper';

export interface UnitContext {
  /** Absolute path of the aiwg entry point (bin/aiwg.mjs). */
  aiwgBin: string;
  /** Absolute workspace directory the units operate in. */
  cwd: string;
  /** Node executable. Defaults to process.execPath. */
  nodeBin?: string;
  /** Optional job id for timer-driven run-once. */
  jobId?: string;
}

export function renderSystemdService(ctx: UnitContext): string {
  const node = ctx.nodeBin ?? process.execPath;
  const runOnce = ctx.jobId
    ? `${quote(ctx.aiwgBin)} housekeeper run-once --job ${quote(ctx.jobId)}`
    : `${quote(ctx.aiwgBin)} housekeeper run-once`;
  return [
    '[Unit]',
    'Description=AIWG housekeeper (deterministic maintenance, oneshot for timer)',
    'Documentation=https://github.com/jmagly/aiwg',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${ctx.cwd}`,
    `ExecStart=${node} ${runOnce}`,
    'NoNewPrivileges=true',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderSystemdTimer(options: { calendar?: string } = {}): string {
  return [
    '[Unit]',
    'Description=AIWG housekeeper periodic run (calls aiwg housekeeper run-once)',
    '',
    '[Timer]',
    `OnCalendar=${options.calendar ?? 'hourly'}`,
    'Persistent=true',
    `Unit=${HOUSEKEEPER_SERVICE_NAME}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

/**
 * Best-effort macOS plist (design note §3: documented, not CI-tested —
 * there is no macOS runner). Runs `run-once` on a calendar interval.
 */
export function renderLaunchdPlist(ctx: UnitContext, options: { intervalSeconds?: number } = {}): string {
  const node = ctx.nodeBin ?? process.execPath;
  const args = ctx.jobId
    ? [ctx.aiwgBin, 'housekeeper', 'run-once', '--job', ctx.jobId]
    : [ctx.aiwgBin, 'housekeeper', 'run-once'];
  const argsXml = [node, ...args].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${HOUSEKEEPER_LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argsXml,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(ctx.cwd)}</string>`,
    '  <key>StartInterval</key>',
    `  <integer>${options.intervalSeconds ?? 3600}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Default `aiwg` entry point under a framework root (overridable in tests). */
export function defaultAiwgBin(frameworkRoot: string): string {
  return path.join(frameworkRoot, 'bin', 'aiwg.mjs');
}

/** XDG user systemd directory (`~/.config/systemd/user` by default). */
export function systemdUserDir(home = os.homedir()): string {
  const base = process.env['XDG_CONFIG_HOME'] || path.join(home, '.config');
  return path.join(base, 'systemd', 'user');
}

/** macOS user agent directory. */
export function launchdAgentDir(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents');
}

export type InstallBackend = 'systemd-user' | 'launchd';

export function backendForPlatform(platform: string): InstallBackend | 'unsupported' {
  if (platform === 'win32') return 'unsupported';
  if (platform === 'darwin') return 'launchd';
  return 'systemd-user';
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
