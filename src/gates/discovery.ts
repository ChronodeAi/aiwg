import { lstatSync, readdirSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseDecisionJson, parseDecisionYaml } from '../decision/entry.js';
import { MANIFEST_MAX_BYTES } from '../extensions/manifest.js';
import { GateRegistry, type GateNamespace } from './registry.js';
import { validateGateDocument } from './schema.js';
import type { GatePack } from './types.js';

export const GATE_PACKS_DIR = 'gate-packs';

/** Admission cap for one gate-pack authoring file, checked before reading (same as the artifact index). */
export const GATE_PACK_MAX_BYTES = 256 * 1024;

/** Manifest-declared bundle subdirs stay inside the bundle: segments only, no `..`, no leading `/`. */
const SAFE_RELATIVE_DIR = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/;

const realpathIfExists = (candidate: string): string | null => {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
};

/**
 * Resolve a manifest-declared gate-packs dir inside its bundle. A raw
 * `entry.gatePacks` value is validated as a safe relative path and contained
 * by realpath: `../../../outside` and symlink escapes are load errors, never
 * followed. A missing dir resolves (callers treat it as empty); a hostile
 * declaration throws even when the dir is absent.
 */
export function resolveGatePacksDir(bundleDir: string, declared?: string): string {
  const subdir = declared ?? GATE_PACKS_DIR;
  if (!SAFE_RELATIVE_DIR.test(subdir)) {
    throw new Error(`gatePacks dir '${subdir}' must be a relative path inside the bundle`
      + ` (alphanumeric + _-, no leading slash, no ..): ${bundleDir}`);
  }
  const absolute = resolve(bundleDir, subdir);
  const realBundle = realpathIfExists(bundleDir);
  const realTarget = realpathIfExists(absolute);
  if (realBundle !== null && realTarget !== null
    && realTarget !== realBundle && !realTarget.startsWith(realBundle + sep)) {
    throw new Error(`gatePacks dir '${subdir}' escapes its bundle: ${bundleDir}`);
  }
  return absolute;
}

const GATE_PACK_SUFFIXES = ['.gatepack.yaml', '.gatepack.yml', '.gatepack.json'] as const;

export interface GatePackOrigin {
  namespace: GateNamespace;
  bundle?: string;
}

export interface BundleGatePacks {
  bundleDir: string;
  bundleKind: 'framework' | 'addon' | 'extension';
  bundleId: string;
}

/** True when the filename is a gate-pack authoring file (never HITL `gates/`). */
export function isGatePackFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return GATE_PACK_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/**
 * Sorted gate-pack authoring files directly under the bundle's gate-packs
 * dir. Every match is lstat-checked before it is returned: symlinks are
 * rejected (never followed), only regular files qualify, the 256 KiB cap is
 * enforced before any read, and the realpath must stay inside the dir.
 */
export function listGatePackFiles(bundleDir: string, gatePacksDir = GATE_PACKS_DIR): string[] {
  const dir = resolveGatePacksDir(bundleDir, gatePacksDir);
  const realDir = realpathIfExists(dir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.filter(isGatePackFile).sort()) {
    const full = join(dir, entry);
    let status;
    try {
      status = lstatSync(full);
    } catch (error) {
      throw new Error(`gate pack unreadable: ${full}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (status.isSymbolicLink()) throw new Error(`gate pack must not be a symlink: ${full}`);
    if (!status.isFile()) throw new Error(`gate pack is not a regular file: ${full}`);
    if (status.size > GATE_PACK_MAX_BYTES) {
      throw new Error(`gate pack exceeds 256 KiB before reading: ${full}`);
    }
    const real = realpathIfExists(full);
    if (realDir !== null && real !== null && real !== realDir && !real.startsWith(realDir + sep)) {
      throw new Error(`gate pack escapes its bundle: ${full}`);
    }
    files.push(full);
  }
  return files;
}

/** Read the bundle manifest's gate-pack declaration when present (both legacy and Zod shapes). */
export function readBundleGatePacksDeclaration(bundleDir: string): { dir?: string; names?: string[] } {
  const manifestPath = join(resolve(bundleDir), 'manifest.json');
  if (!existsSync(manifestPath)) return {};
  let manifest: unknown;
  try {
    const status = statSync(manifestPath);
    if (!status.isFile() || status.size > MANIFEST_MAX_BYTES) return {};
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {};
  const root = manifest as Record<string, unknown>;
  const entry = root.entry as Record<string, unknown> | undefined;
  const dir = typeof entry?.gatePacks === 'string' ? entry.gatePacks
    : typeof entry?.['gate-packs'] === 'string' ? String(entry['gate-packs'])
    : undefined;
  const topNames = Array.isArray(root.gatePacks)
    ? root.gatePacks.filter((name): name is string => typeof name === 'string')
    : undefined;
  for (const configKey of ['addonConfig', 'extensionConfig', 'frameworkConfig'] as const) {
    const config = root[configKey] as Record<string, unknown> | undefined;
    if (!config || typeof config !== 'object') continue;
    if (topNames === undefined && Array.isArray(config.gatePacks)) {
      const names = config.gatePacks.filter((name): name is string => typeof name === 'string');
      return { ...(dir ? { dir } : {}), names };
    }
    const configEntry = config.entry as Record<string, unknown> | undefined;
    if (dir === undefined && typeof configEntry?.gatePacks === 'string') {
      return { dir: configEntry.gatePacks, ...(topNames ? { names: topNames } : {}) };
    }
  }
  if (root.frameworkConfig && typeof root.frameworkConfig === 'object') {
    const framework = root.frameworkConfig as Record<string, unknown>;
    if (Array.isArray(framework.gatePacks)) {
      const names = framework.gatePacks.filter((name): name is string => typeof name === 'string');
      const frameworkEntry = framework.entry as Record<string, unknown> | undefined;
      const frameworkDir = typeof frameworkEntry?.gatePacks === 'string' ? frameworkEntry.gatePacks : dir;
      return { ...(frameworkDir ? { dir: frameworkDir } : {}), names };
    }
  }
  return { ...(dir ? { dir } : {}), ...(topNames ? { names: topNames } : {}) };
}

/**
 * Parse one authoring file with admission limits and closed-schema validation.
 * Never returns an invalid pack. The file is lstat-checked before any read:
 * symlinks are rejected, only regular files qualify, and the 256 KiB cap is
 * enforced up front so an unbounded read can never happen here.
 */
export function loadGatePackFile(filePath: string): GatePack {
  let status;
  try {
    status = lstatSync(filePath);
  } catch (error) {
    throw new Error(`gate pack unreadable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status.isSymbolicLink()) throw new Error(`gate pack must not be a symlink: ${filePath}`);
  if (!status.isFile()) throw new Error(`gate pack is not a regular file: ${filePath}`);
  if (status.size > GATE_PACK_MAX_BYTES) throw new Error(`gate pack exceeds 256 KiB before reading: ${filePath}`);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`gate pack unreadable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let document: unknown;
  try {
    document = filePath.toLowerCase().endsWith('.json') ? parseDecisionJson(content) : parseDecisionYaml(content);
  } catch (error) {
    throw new Error(`gate pack unparseable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const pack = validateGateDocument<GatePack>(document);
    if (pack.kind !== 'GatePack') throw new Error(`expected kind GatePack, got '${String((document as { kind?: unknown }).kind)}'`);
    return pack;
  } catch (error) {
    throw new Error(`gate pack invalid: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Register every pack in one bundle directory. Invalid packs are rejected
 * with a file-pathed diagnostic; nothing invalid enters the registry.
 */
export function registerBundleGatePacks(
  registry: GateRegistry,
  bundleDir: string,
  origin: GatePackOrigin,
): string[] {
  const declaration = readBundleGatePacksDeclaration(bundleDir);
  const gatePacksDir = resolveGatePacksDir(bundleDir, declaration.dir);
  const files = listGatePackFiles(bundleDir, declaration.dir ?? GATE_PACKS_DIR);
  const wanted = declaration.names ? new Set(declaration.names) : null;
  const loaded: string[] = [];
  for (const file of files) {
    const short = basename(file).replace(/\.gatepack\.(yaml|yml|json)$/i, '');
    if (wanted && !wanted.has(short)) continue;
    const pack = loadGatePackFile(file);
    try {
      registry.registerPack(pack, origin.bundle === undefined ? { namespace: origin.namespace } : origin);
    } catch (error) {
      throw new Error(`gate pack rejected: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    loaded.push(pack.metadata.id);
  }
  if (wanted) {
    for (const name of wanted) {
      if (!files.some(file => basename(file).replace(/\.gatepack\.(yaml|yml|json)$/i, '') === name)) {
        throw new Error(`gate pack missing: ${gatePacksDir}/${name}.gatepack.yaml (declared by manifest)`);
      }
    }
  }
  return loaded;
}

/**
 * Derive a `--pack-dir` bundle's contribution origin from its manifest, never
 * from its path. A directory whose `manifest.json` declares a framework,
 * addon or extension `{id, type}` contributes under that namespace and bundle
 * id; anything else (missing, unreadable, oversized or undeclared manifest)
 * is project-local. Path substrings such as `/addons/` are not consulted.
 */
export function originForPackDir(bundleDir: string): GatePackOrigin {
  const manifestPath = join(resolve(bundleDir), 'manifest.json');
  try {
    const status = statSync(manifestPath);
    if (!status.isFile() || status.size > MANIFEST_MAX_BYTES) return { namespace: 'project' };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: unknown; type?: unknown };
    if (typeof manifest?.id === 'string' && manifest.id.trim() !== ''
      && (manifest.type === 'framework' || manifest.type === 'addon' || manifest.type === 'extension')) {
      return { namespace: manifest.type, bundle: manifest.id };
    }
  } catch {
    /* fall through to project-local */
  }
  return { namespace: 'project' };
}

const BUNDLE_GROUPS = [
  { kind: 'framework', sub: 'frameworks' },
  { kind: 'addon', sub: 'addons' },
  { kind: 'extension', sub: 'extensions' },
] as const;

/**
 * Register shipped packs under `agentic/code/<group>/<bundle>/gate-packs/`.
 * Shipped packs use the `aiwg:` namespace (`aiwg:<bundle>/<name>`); the
 * bundle kind is only an install hint. Project-local bundles register under
 * their own `framework:`/`addon:`/`extension:` namespace via
 * `registerBundleGatePacks` directly.
 */
export function discoverShippedGatePacks(aiwgRoot: string, registry: GateRegistry): string[] {
  const loaded: string[] = [];
  for (const group of BUNDLE_GROUPS) {
    const groupDir = resolve(aiwgRoot, 'agentic/code', group.sub);
    let bundles: string[];
    try {
      bundles = readdirSync(groupDir).filter(name => {
        try {
          return statSync(join(groupDir, name)).isDirectory();
        } catch {
          return false;
        }
      }).sort();
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      const bundleDir = join(groupDir, bundle);
      const files = listGatePackFiles(bundleDir);
      if (!files.length && !existsSync(join(bundleDir, 'manifest.json'))) continue;
      if (!files.length) continue;
      loaded.push(...registerBundleGatePacks(registry, bundleDir, { namespace: 'aiwg', bundle }));
    }
  }
  return loaded;
}
