// Parses migration flags and resolves existing storage adapters.
import { join, resolve as resolvePath } from 'node:path';
import {
  BACKEND_TYPES, SUBSYSTEM_KEYS, FilesystemAdapter, ObsidianAdapter, LogseqAdapter, FortemiAdapter,
  type BackendType, type StorageAdapter, type SubsystemKey,
} from './index.js';

export interface MigrateArgs {
  subsystem: SubsystemKey;
  from: BackendSpec;
  to: BackendSpec;
  dryRun: boolean;
  textOnly: boolean;
}

export interface BackendSpec {
  type: BackendType;
  location: string;
  folder?: string;
}

export function parseMigrateArgs(args: string[]): MigrateArgs {
  let subsystem: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let fromFolder: string | undefined;
  let toFolder: string | undefined;
  let dryRun = false;
  let textOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') from = args[++i];
    else if (a === '--to') to = args[++i];
    else if (a === '--from-folder') fromFolder = args[++i];
    else if (a === '--to-folder') toFolder = args[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--text-only') textOnly = true;
    else if (!a.startsWith('--') && !subsystem) subsystem = a;
    else throw new Error(`Unknown migrate flag: ${a}`);
  }

  if (!subsystem || !(SUBSYSTEM_KEYS as readonly string[]).includes(subsystem)) {
    throw new Error(
      `Usage: aiwg storage migrate <subsystem> --from <type>:<location> --to <type>:<location> [--dry-run]\n  Valid subsystems: ${SUBSYSTEM_KEYS.join(', ')}`
    );
  }
  if (!from) throw new Error('storage migrate: --from <type>:<location> is required');
  if (!to) throw new Error('storage migrate: --to <type>:<location> is required');

  return {
    subsystem: subsystem as SubsystemKey,
    from: { ...parseSpec(from), ...(fromFolder ? { folder: fromFolder } : {}) },
    to: { ...parseSpec(to), ...(toFolder ? { folder: toFolder } : {}) },
    dryRun,
    textOnly,
  };
}

export function parseSpec(raw: string): BackendSpec {
  const idx = raw.indexOf(':');
  if (idx === -1) {
    throw new Error(`Invalid backend spec "${raw}" — expected <type>:<location>`);
  }
  const type = raw.slice(0, idx);
  const location = raw.slice(idx + 1);
  if (!(BACKEND_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Unknown backend type "${type}" in spec "${raw}". Valid: ${BACKEND_TYPES.join(', ')}`
    );
  }
  if (location.length === 0) {
    throw new Error(`Empty location in backend spec "${raw}"`);
  }
  return { type: type as BackendType, location };
}

export function buildAdapter(
  subsystem: SubsystemKey,
  spec: BackendSpec,
  projectRoot: string
): StorageAdapter {
  switch (spec.type) {
    case 'fs': {
      const root = expandFsLocation(spec.location, projectRoot);
      return new FilesystemAdapter(root);
    }
    case 'obsidian':
      return new ObsidianAdapter({
        type: 'obsidian',
        vault: expandFsLocation(spec.location, projectRoot),
        ...(spec.folder ? { folder: spec.folder } : {}),
        useCli: false,
      });
    case 'logseq':
      return new LogseqAdapter({
        type: 'logseq',
        graph: expandFsLocation(spec.location, projectRoot),
        useApi: false,
      });
    case 'fortemi':
      return new FortemiAdapter({
        subsystem,
        config: { type: 'fortemi', mcpServer: spec.location },
      });
    case 'notion':
    case 'anythingllm':
    case 's3':
    case 'webdav':
      throw new Error(
        `storage migrate: backend "${spec.type}" not yet implemented. ` +
          `See issues #959, #960, #962, #963 for tracking.`
      );
    default: {
      const _exhaustive: never = spec.type;
      void _exhaustive;
      throw new Error(`Unhandled backend type ${spec.type}`);
    }
  }
}

export function expandFsLocation(loc: string, projectRoot: string): string {
  if (loc.startsWith('~/')) {
    const { homedir } = require('os') as typeof import('os');
    return join(homedir(), loc.slice(2));
  }
  if (loc === '~') {
    const { homedir } = require('os') as typeof import('os');
    return homedir();
  }
  if (loc.startsWith('/')) return loc;
  return resolvePath(projectRoot, loc);
}

export function locationsEqual(a: BackendSpec, b: BackendSpec, projectRoot: string): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'fortemi') return a.location === b.location;
  // For file-shaped backends, compare resolved fs paths
  return expandFsLocation(a.location, projectRoot) === expandFsLocation(b.location, projectRoot);
}

export function describeSpec(spec: BackendSpec): string {
  return spec.folder ? `${spec.type}:${spec.location} (folder=${spec.folder})` : `${spec.type}:${spec.location}`;
}

export function specSlug(spec: BackendSpec): string {
  return `${spec.type}-${spec.location.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)}`;
}
