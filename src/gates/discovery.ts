import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseDecisionJson, parseDecisionYaml } from '../decision/entry.js';
import { GateRegistry, type GateNamespace } from './registry.js';
import { validateGateDocument } from './schema.js';
import type { GatePack } from './types.js';

export const GATE_PACKS_DIR = 'gate-packs';

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

/** Sorted gate-pack authoring files directly under `<bundleDir>/gate-packs/`. */
export function listGatePackFiles(bundleDir: string, gatePacksDir = GATE_PACKS_DIR): string[] {
  const dir = resolve(bundleDir, gatePacksDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter(entry => isGatePackFile(entry))
    .sort()
    .map(entry => join(dir, entry));
}

/** Read the bundle manifest's gate-pack declaration when present (both legacy and Zod shapes). */
export function readBundleGatePacksDeclaration(bundleDir: string): { dir?: string; names?: string[] } {
  const manifestPath = join(resolve(bundleDir), 'manifest.json');
  if (!existsSync(manifestPath)) return {};
  let manifest: unknown;
  try {
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

/** Parse one authoring file with admission limits and closed-schema validation. Never returns an invalid pack. */
export function loadGatePackFile(filePath: string): GatePack {
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
        throw new Error(`gate pack missing: ${resolve(bundleDir, declaration.dir ?? GATE_PACKS_DIR)}/${name}.gatepack.yaml (declared by manifest)`);
      }
    }
  }
  return loaded;
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
