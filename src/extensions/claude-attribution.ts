// Merge and undo Claude attribution defaults, and inspect effective settings offline.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = { commit: '', pr: '', sessionUrl: false } as const;
type Settings = Record<string, unknown>;
const object = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function mergeClaudeAttribution(settings: Settings, warnings: string[]): void {
  if (settings.attribution !== undefined && !object(settings.attribution)) {
    warnings.push('Preserved operator attribution setting; expected an object.');
    return;
  }
  const attribution = (settings.attribution ??= {}) as Settings;
  const aiwg = object(settings.aiwg) ? settings.aiwg : {};
  const owned = new Set(Array.isArray(aiwg.attributionKeys) ? aiwg.attributionKeys : []);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (attribution[key] === undefined) {
      attribution[key] = value;
      owned.add(key);
    } else if ((key === 'commit' || key === 'pr') && attribution[key] !== '') {
      warnings.push(`Preserved operator attribution.${key}; attribution remains enabled. Clear it explicitly to disable attribution.`);
    }
  }
  if (owned.size) {
    aiwg.attributionKeys = [...owned];
    settings.aiwg = aiwg;
  }
}

export function undoClaudeAttribution(settings: Settings): boolean {
  if (!object(settings.aiwg) || !Array.isArray(settings.aiwg.attributionKeys)) return false;
  const attribution = settings.attribution;
  if (object(attribution)) {
    for (const key of settings.aiwg.attributionKeys) {
      if (Object.hasOwn(DEFAULTS, key) && attribution[key] === DEFAULTS[key as keyof typeof DEFAULTS]) {
        delete attribution[key];
      }
    }
    if (Object.keys(attribution).length === 0) delete settings.attribution;
  }
  delete settings.aiwg.attributionKeys;
  if (Object.keys(settings.aiwg).length === 0) delete settings.aiwg;
  return true;
}

/** Higher-precedence files override individual keys; missing keys use Claude defaults. */
export async function checkClaudeAttribution(projectPath: string, home = os.homedir(), managedFile = path.join(
  process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
    : process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
    : '/etc/claude-code', 'managed-settings.json')): Promise<{
  status: 'ok' | 'warn'; message: string;
}> {
  const effective: Settings = { commit: '(Claude default)', pr: '(Claude default)', sessionUrl: true };
  const sources = [path.join(home, '.claude/settings.json'), path.join(projectPath, '.claude/settings.json'),
    path.join(projectPath, '.claude/settings.local.json'), managedFile];
  try {
    for (const file of sources) {
      let settings;
      try { settings = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      if (settings.attribution === false) Object.assign(effective, DEFAULTS);
      else if (object(settings.attribution)) Object.assign(effective, settings.attribution);
    }
    const enabled = Object.keys(DEFAULTS).filter(key => effective[key] !== DEFAULTS[key as keyof typeof DEFAULTS]);
    return enabled.length ? { status: 'warn', message: `Effective Claude attribution enabled: ${enabled.join(', ')}. Run: aiwg use all --provider claude. Existing operator values are preserved; clear those keys explicitly in the overriding settings file. Session-only overrides are not inspected.` }
      : { status: 'ok', message: 'Claude attribution disabled by user/project/managed settings (session-only overrides are not inspected).' };
  } catch (err) {
    return { status: 'warn', message: `Could not inspect Claude attribution: ${err instanceof Error ? err.message : String(err)}. Run: aiwg use all --provider claude after repairing settings JSON.` };
  }
}
