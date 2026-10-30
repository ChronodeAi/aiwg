/**
 * Platform honesty for `aiwg housekeeper` (epic #3353 slice B5).
 *
 * Design-note §3 matrix in one place, with the platform injectable so
 * tests can cover every row without running on that OS: Windows is
 * unsupported (WSL2 follows the Linux rows); macOS install is a
 * best-effort launchd plist (documented, not CI-tested); Linux install
 * targets systemd user units.
 */

export type HousekeeperPlatform = 'linux' | 'darwin' | 'windows' | 'other';

export function normalizePlatform(platform: string = process.platform): HousekeeperPlatform {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'other';
}

/** run-once / daemon processes: everything except Windows. */
export function runSupported(platform: string = process.platform): boolean {
  return normalizePlatform(platform) !== 'windows';
}

export function runUnsupportedMessage(): string {
  return 'aiwg housekeeper is not supported on Windows (no recursive fs.watch, POSIX paths assumed). Use WSL2 and follow the Linux rows.';
}

/** Install backends offered on a platform, in preference order. */
export function installBackends(platform: string = process.platform): Array<'systemd-user' | 'launchd'> {
  const normalized = normalizePlatform(platform);
  if (normalized === 'windows') return [];
  if (normalized === 'darwin') return ['launchd', 'systemd-user'];
  return ['systemd-user', 'launchd'];
}
