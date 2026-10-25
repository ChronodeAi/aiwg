import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  exportShardWithReport,
  importShard,
  packTarGz,
  unpackTarGz,
  validateChecksums,
  validateFullV1ShardArchive,
  verifyShardSignature,
  type DatabaseClient,
  type ExportOptions,
  type ImportOptions,
  type QueryExecutor,
  type QueryResult,
  type ShardManifest,
  type ShardCapabilityReport,
} from "@fortemi/core";

import {
  buildAiwgFortemiIndexExport,
  type AiwgFortemiIndexExport,
} from "./browser-export.js";
import type { GraphType } from "./types.js";

interface FortemiShardCoreModule {
  aiwgFortemiIndexToKnowledgeShard?: (
    index: AiwgFortemiIndexExport,
    options?: { createdAt?: string; matricVersion?: string },
  ) => Promise<Uint8Array>;
  aiwgFortemiIndexToKnowledgeShardWithReport?: (
    index: AiwgFortemiIndexExport,
    options?: { createdAt?: string; matricVersion?: string },
  ) => Promise<{
    success: boolean;
    archive: Uint8Array | null;
    profile: "full-v1";
    schema_version: "2.0.0";
    lossless: boolean;
    losses: unknown[];
    receipt: unknown;
  }>;
}

export type AiwgFortemiShardConverter = NonNullable<
  FortemiShardCoreModule["aiwgFortemiIndexToKnowledgeShard"]
>;
export type AiwgFortemiShardReportConverter = NonNullable<
  FortemiShardCoreModule["aiwgFortemiIndexToKnowledgeShardWithReport"]
>;

export interface AiwgFortemiShardExportOptions {
  graph?: GraphType;
  repo?: string;
  privacy?: "private" | "sanitized" | "public";
  generatedAt?: string;
  schemaVersion?: "1.2.0" | "2.0.0";
  profile?: "core-v1" | "full-v1";
  failOnLoss?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface AiwgFortemiShardConversionReport {
  schemaVersion: "1.2.0" | "2.0.0";
  profile: "core-v1" | "full-v1";
  success: boolean;
  lossless: boolean;
  losses: unknown[];
  receipt: unknown | null;
  archive: Uint8Array;
}

const SUPPORTED_SHARD_TUPLES = new Set([
  "1.2.0/core-v1",
  "2.0.0/full-v1",
]);

export function resolveAiwgFortemiShardTuple(
  options: Pick<AiwgFortemiShardExportOptions, "schemaVersion" | "profile">,
): { schemaVersion: "1.2.0" | "2.0.0"; profile: "core-v1" | "full-v1" } {
  const schemaVersion = options.schemaVersion ?? "2.0.0";
  const profile = options.profile ?? "full-v1";
  if (!SUPPORTED_SHARD_TUPLES.has(`${schemaVersion}/${profile}`)) {
    throw new Error(
      `Unsupported Fortemi Knowledge Shard tuple ${schemaVersion}/${profile}; `
      + "supported tuples are 2.0.0/full-v1 and 1.2.0/core-v1.",
    );
  }
  return { schemaVersion, profile };
}

async function loadFortemiShardConverters(): Promise<Required<FortemiShardCoreModule>> {
  let core: FortemiShardCoreModule;
  try {
    core = (await import(
      /* @vite-ignore */ "@fortemi/core/aiwg-index-shard"
    )) as FortemiShardCoreModule;
  } catch {
    throw new Error(
      "Portable Fortemi shard export requires @fortemi/core with aiwgFortemiIndexToKnowledgeShard.",
    );
  }
  if (
    !core.aiwgFortemiIndexToKnowledgeShard
    || !core.aiwgFortemiIndexToKnowledgeShardWithReport
  ) {
    throw new Error(
      "Installed @fortemi/core does not support both public AIWG shard converters; "
      + "upgrade to a compatible published release.",
    );
  }
  return core as Required<FortemiShardCoreModule>;
}

export async function buildAiwgFortemiKnowledgeShardWithReport(
  cwd: string,
  options: AiwgFortemiShardExportOptions = {},
  converter?: AiwgFortemiShardConverter,
  reportConverter?: AiwgFortemiShardReportConverter,
): Promise<AiwgFortemiShardConversionReport> {
  const exported = buildAiwgFortemiIndexExport(cwd, {
    ...options,
    schemaVersion: "v2",
  });
  const tuple = resolveAiwgFortemiShardTuple(options);
  const needsCore = tuple.profile === "core-v1" ? !converter : !reportConverter;
  const core = needsCore ? await loadFortemiShardConverters() : null;
  if (tuple.profile === "core-v1") {
    const archive = await (converter ?? core!.aiwgFortemiIndexToKnowledgeShard)(
      exported,
      { createdAt: options.generatedAt, matricVersion: "aiwg" },
    );
    return {
      ...tuple,
      success: true,
      lossless: true,
      losses: [],
      receipt: null,
      archive,
    };
  }
  const result = await (reportConverter ?? core!.aiwgFortemiIndexToKnowledgeShardWithReport)(
    exported,
    { createdAt: options.generatedAt, matricVersion: "aiwg" },
  );
  if (!result.success || !result.archive) {
    throw new Error(
      "Fortemi full-v1 conversion failed without producing an archive; losses="
      + JSON.stringify(result.losses),
    );
  }
  if (options.failOnLoss && (!result.lossless || result.losses.length > 0)) {
    throw new Error(
      `Fortemi full-v1 conversion reported ${result.losses.length} loss(es); `
      + "archive was not written because --fail-on-loss was set.",
    );
  }
  return {
    ...tuple,
    success: result.success,
    lossless: result.lossless,
    losses: result.losses,
    receipt: result.receipt,
    archive: result.archive,
  };
}

export async function buildAiwgFortemiKnowledgeShard(
  cwd: string,
  options: AiwgFortemiShardExportOptions = {},
  converter?: AiwgFortemiShardConverter,
  reportConverter?: AiwgFortemiShardReportConverter,
): Promise<Uint8Array> {
  return (await buildAiwgFortemiKnowledgeShardWithReport(
    cwd,
    options,
    converter,
    reportConverter,
  )).archive;
}

export async function writeAiwgFortemiKnowledgeShard(
  cwd: string,
  outPath: string,
  options: AiwgFortemiShardExportOptions = {},
  converter?: AiwgFortemiShardConverter,
  reportConverter?: AiwgFortemiShardReportConverter,
): Promise<{
  bytes: number;
  items: number;
  outPath: string;
  written: boolean;
  conversion: Omit<AiwgFortemiShardConversionReport, "archive">;
}> {
  const exported = buildAiwgFortemiIndexExport(cwd, {
    ...options,
    schemaVersion: "v2",
  });
  const conversion = await buildAiwgFortemiKnowledgeShardWithReport(
    cwd,
    options,
    converter,
    reportConverter,
  );
  const resolved = path.resolve(cwd, outPath);
  const report = {
    bytes: conversion.archive.byteLength,
    items: exported.items.length,
    outPath: resolved,
    written: !options.dryRun,
    conversion: {
      schemaVersion: conversion.schemaVersion,
      profile: conversion.profile,
      success: conversion.success,
      lossless: conversion.lossless,
      losses: conversion.losses,
      receipt: conversion.receipt,
    },
  };
  if (options.dryRun) return report;
  if (fs.existsSync(resolved) && !options.overwrite) {
    throw new Error(
      `Refusing to overwrite existing shard ${resolved}; choose a new path or pass --force.`,
    );
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, conversion.archive, { flag: "wx" });
    if (options.overwrite) {
      fs.renameSync(temporary, resolved);
    } else {
      fs.linkSync(temporary, resolved);
      fs.unlinkSync(temporary);
    }
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return report;
}

export function diagnoseAiwgFortemiShardMigration(
  cwd: string,
  inputPath: string,
): {
  supported: false;
  inputPath: string;
  mutationPlanned: false;
  diagnostic: string;
  action: string;
} {
  const resolved = path.resolve(cwd, inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Legacy shard input does not exist or is not a regular file: ${resolved}`);
  }
  return {
    supported: false,
    inputPath: resolved,
    mutationPlanned: false,
    diagnostic:
      "Source-less core-v1 to full-v1 conversion is unsupported because omitted rich "
      + "components cannot be reconstructed without loss.",
    action:
      "Regenerate from the source-backed AIWG index with "
      + "--schema-version 2.0.0 --profile full-v1; retain the legacy shard for rollback.",
  };
}

/** Qualified reader tuples; this is a local candidate result, not a release receipt. */
export const AIWG_FULL_V1_SHARD_READER_VERSIONS = ["2.0.0", "2.1.0", "2.2.0"] as const;
const SHARD_CONTRACT_COMMIT = "b88084407751153e67a9279fff9303cc3db70474";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encodeJson = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const parseJson = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T;
type WireRecord = Record<string, unknown>;
type ShardFiles = Map<string, Uint8Array>;
const extendedFields: Record<string, readonly string[]> = {
  embedding_sets: ["query_template", "vector_source"],
  embedding_configs: ["provider_dimension", "space_contract", "space_id", "vector_type"],
};

const contractRoot = new URL("./fortemi-shard-contract/2.2.0/", import.meta.url);
const contractBytes = fs.readFileSync(new URL("contract.json", contractRoot));
const contract = JSON.parse(contractBytes.toString("utf8")) as {
  schemaBundle: { files: Record<string, string> };
};
const contractAjv = new Ajv2020({ strict: true, allErrors: true });
addFormats(contractAjv);
const extendedValidators = Object.fromEntries(
  ["manifest", "embedding-set", "embedding-config"].map((name) => [name, contractAjv.compile(
    JSON.parse(fs.readFileSync(new URL(`full-v1-${name}.schema.json`, contractRoot), "utf8")),
  )]),
);

function projectedRecord(component: string, record: WireRecord): WireRecord {
  const projected = { ...record };
  for (const field of extendedFields[component] ?? []) delete projected[field];
  return projected;
}

function projectedFiles(original: ShardFiles): ShardFiles {
  const files = new Map(original);
  const manifest = parseJson<ShardManifest>(files.get("manifest.json")!);
  manifest.version = "2.0.0";
  manifest.min_reader_version = "2.0.0";
  for (const component of Object.keys(extendedFields)) {
    const filename = `${component}.json`;
    if (!files.has(filename)) continue;
    const records = parseJson<WireRecord[]>(files.get(filename)!);
    const bytes = encodeJson(records.map(record => projectedRecord(component, record)));
    files.set(filename, bytes);
    manifest.checksums[filename] = digest(bytes);
  }
  files.set("manifest.json", encodeJson(manifest));
  // The publisher envelope is verified against the original bytes before import.
  files.delete("signature.json");
  return files;
}

/** Validate the candidate additions, then reuse Core's complete structure/reference/blob checks. */
export async function validateAiwgFortemiKnowledgeShard(archive: Uint8Array): Promise<{
  valid: boolean; errors: string[];
}> {
  try {
    const files = unpackTarGz(archive);
    const manifest = parseJson<ShardManifest>(files.get("manifest.json")!);
    if (manifest.version !== "2.2.0" && manifest.version !== "2.1.0") {
      return validateFullV1ShardArchive(archive);
    }
    if (manifest.profile !== "full-v1") {
      return { valid: false, errors: [`Unsupported ${manifest.version}/${manifest.profile} reader tuple`] };
    }
    const errors: string[] = [];
    const manifestValidator = extendedValidators.manifest;
    const candidateManifest = manifest.version === "2.1.0"
      ? { ...manifest, version: "2.2.0", min_reader_version: "2.2.0" } : manifest;
    if (manifest.version === "2.1.0" && manifest.min_reader_version !== "2.1.0") {
      errors.push("manifest.json unsupported min_reader_version");
    }
    if (!manifestValidator(candidateManifest)) errors.push(`manifest.json ${contractAjv.errorsText(manifestValidator.errors)}`);
    for (const [component, name] of [["embedding_sets", "embedding-set"], ["embedding_configs", "embedding-config"]]) {
      const records = parseJson<WireRecord[]>(files.get(`${component}.json`)!);
      if (!Array.isArray(records)) throw new Error(`${component} must be a JSON array`);
      for (const [index, record] of records.entries()) {
        const validate = extendedValidators[name];
        if (!validate(record)) errors.push(`${component}[${index}] ${contractAjv.errorsText(validate.errors)}`);
        if (typeof record.query_template === "string" && Buffer.byteLength(record.query_template, "utf8") > 2048) {
          errors.push(`${component}[${index}].query_template exceeds 2048 UTF-8 bytes`);
        }
        if (typeof record.provider_dimension === "number" && record.provider_dimension < Number(record.dimension)) {
          errors.push(`${component}[${index}].provider_dimension is below dimension`);
        }
        if (manifest.version === "2.1.0" && ["query_template", "vector_source", "provider_dimension"].some(field => field in record)) {
          errors.push(`${component}[${index}] requires schema 2.2.0`);
        }
      }
    }
    if (errors.length) return { valid: false, errors };
    const checksums = await validateChecksums(manifest.checksums, files);
    if (!checksums.valid) return { valid: false, errors: checksums.failures.map(file => `${file} checksum mismatch`) };
    const view = projectedFiles(files);
    if (files.has("signature.json")) view.set("signature.json", files.get("signature.json")!);
    return validateFullV1ShardArchive(view);
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Core 2026.7.15 owns the snapshot transaction, conflict and blob handling. Its
 * validation view uses 2.0.0; only the existing snapshot-table parameters change.
 * Stored files/records always retain the original authority tuple and fields.
 */
function snapshotDatabaseView(
  db: DatabaseClient,
  version: string,
  originalFiles: ShardFiles,
  originalArchive?: Uint8Array,
): DatabaseClient {
  const originalManifest = originalFiles.get("manifest.json");
  const projected = originalManifest ? projectedFiles(originalFiles) : undefined;
  const projectedArchiveDigest = projected ? digest(packTarGz(projected)) : undefined;
  const wrap = (executor: QueryExecutor): QueryExecutor => ({
    exec: sql => executor.exec(sql),
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      if (!sql.includes("knowledge_shard_")) return executor.query<T>(sql, params);
      const mapped = params ? [...params] : undefined;
      if (mapped?.[0] === "2.0.0") mapped[0] = version;
      if (mapped && sql.includes("INSERT INTO knowledge_shard_snapshot")) {
        mapped[2] = digest(originalArchive!);
        mapped[3] = decoder.decode(originalManifest!);
      } else if (mapped && sql.includes("INSERT INTO knowledge_shard_file")) {
        mapped[3] = originalFiles.get(String(mapped[2]));
      } else if (mapped && sql.includes("INSERT INTO knowledge_shard_component_record")) {
        const component = String(mapped[2]);
        if (component in extendedFields) {
          mapped[5] = JSON.stringify(parseJson<WireRecord[]>(originalFiles.get(`${component}.json`)!)[Number(mapped[3])]);
        }
      }
      const result = await executor.query<WireRecord>(sql.replaceAll("schema_version = '2.0.0'", `schema_version = '${version}'`), mapped);
      if (mapped && sql.includes("INSERT INTO knowledge_shard_file") && mapped[2] === "manifest.json" && originalFiles.has("signature.json")) {
        await executor.query(sql, [version, "full-v1", "signature.json", originalFiles.get("signature.json")]);
      }
      const rows = result.rows.map(row => {
        if ("archive_sha256" in row && originalArchive && row.archive_sha256 === digest(originalArchive)) {
          return { ...row, archive_sha256: projectedArchiveDigest };
        }
        if ("path" in row && "bytes" in row) {
          originalFiles.set(String(row.path), new Uint8Array(row.bytes as Uint8Array));
          return row;
        }
        return row;
      });
      // Export must validate the same 2.0.0 view while retaining original files.
      if (rows.some(row => "path" in row && "bytes" in row)) {
        const view = projectedFiles(originalFiles);
        return { ...result, rows: rows.filter(row => row.path !== "signature.json").map(row => ({ ...row, bytes: view.get(String(row.path)) })) as T[] };
      }
      return { ...result, rows: rows.map(row => {
        if ("manifest_json" in row) {
          const manifest = structuredClone(row.manifest_json) as ShardManifest;
          manifest.version = "2.0.0";
          manifest.min_reader_version = "2.0.0";
          return { ...row, manifest_json: manifest };
        }
        if ("record_json" in row) return { ...row, record_json: projectedRecord(String(row.component), row.record_json as WireRecord) };
        return row;
      }) as T[] };
    },
  });
  return { ...wrap(db), transaction: callback => db.transaction(tx => callback(wrap(tx))) };
}

function readerCapability(version: string, base: ShardCapabilityReport): ShardCapabilityReport {
  return {
    ...base,
    requested_profile: "full-v1",
    requested_schema_version: version,
    authority_status: "candidate" as const,
    backend_supported: true,
    portable: true,
    authority: {
      repository: "Fortemi/fortemi",
      commit: SHARD_CONTRACT_COMMIT,
      contract_sha256: digest(contractBytes),
      contract_revision: "23",
      schema_version: version,
      schema_bundle_sha256: digest(encodeJson(contract.schemaBundle.files)),
    },
    advertised_profiles: ["full-v1" as const],
  };
}

export async function importAiwgFortemiKnowledgeShard(
  db: DatabaseClient,
  archive: Uint8Array,
  options?: ImportOptions,
): ReturnType<typeof importShard> {
  let files: ShardFiles;
  let manifest: ShardManifest;
  try {
    files = unpackTarGz(archive);
    manifest = parseJson<ShardManifest>(files.get("manifest.json")!);
  } catch {
    return importShard(db, archive, options);
  }
  if (manifest.version === "2.2.0" && manifest.profile !== "full-v1") {
    throw new Error(`Unsupported 2.2.0/${manifest.profile} reader tuple`);
  }
  if (manifest.profile !== "full-v1" || !["2.1.0", "2.2.0"].includes(manifest.version)) {
    return importShard(db, archive, options);
  }
  const validation = await validateAiwgFortemiKnowledgeShard(archive);
  if (!validation.valid) throw new Error(`Canonical full-v1 validation failed: ${validation.errors.join("; ")}`);
  const policy = options?.verifySignature ?? (options?.trustStore ? "require" : undefined);
  if (policy && policy !== "trusted-local-only") {
    if (!options?.trustStore) throw new Error(`verifySignature: '${policy}' requires a trustStore`);
    const verdict = await verifyShardSignature({ files, trustStore: options.trustStore });
    if (!verdict.ok && !(policy === "prefer" && verdict.reason === "unsigned")) {
      throw new Error(`Full-v1 publisher verification failed: ${verdict.reason}`);
    }
  }
  const result = await importShard(
    snapshotDatabaseView(db, manifest.version, files, archive),
    packTarGz(projectedFiles(files)),
    { ...options, verifySignature: "trusted-local-only" },
  );
  return { ...result, capability_report: readerCapability(manifest.version, result.capability_report) };
}

export async function exportAiwgFortemiKnowledgeShardWithReport(
  db: DatabaseClient,
  options: Omit<ExportOptions, "schemaVersion" | "profile"> & { profile: string; schemaVersion?: "1.2.0" | "2.0.0" | "2.1.0" | "2.2.0" },
): ReturnType<typeof exportShardWithReport> {
  const version = options.schemaVersion;
  if (options.profile === "full-v1" && version !== "2.2.0") {
    const snapshots = await db.query<{ schema_version: string }>("SELECT schema_version FROM knowledge_shard_snapshot WHERE profile = 'full-v1'");
    if (snapshots.rows.some(row => row.schema_version === "2.2.0") && !snapshots.rows.some(row => row.schema_version === version)) {
      throw new Error("A 2.2.0/full-v1 snapshot requires schemaVersion: 2.2.0; refusing a lossy downgrade");
    }
  }
  if (version !== "2.1.0" && version !== "2.2.0") return exportShardWithReport(db, options as ExportOptions & { profile: string });
  if (options.profile !== "full-v1") throw new Error(`Unsupported ${version}/${options.profile} reader tuple`);
  const originals: ShardFiles = new Map();
  const exists = await db.query("SELECT schema_version FROM knowledge_shard_snapshot WHERE schema_version = $1 AND profile = 'full-v1'", [version]);
  if (exists.rows.length === 0) throw new Error(`No persisted ${version}/full-v1 snapshot`);
  const result = await exportShardWithReport(snapshotDatabaseView(db, version, originals), { ...options, profile: "full-v1", schemaVersion: "2.0.0" });
  if (!result.success || !result.archive) return { ...result, capability_report: readerCapability(version, result.capability_report) };
  // Core checks current snapshot records and retrieves/verifies mandatory blobs.
  // Rebuild from the original record view so nullable/absent extension fields
  // survive even edits that change only those fields.
  const persisted = await db.query<{ component: string; record_json: WireRecord }>(
    "SELECT component, record_json FROM knowledge_shard_component_record WHERE schema_version = $1 AND profile = 'full-v1' ORDER BY component, ordinal",
    [version],
  );
  const records = new Map<string, WireRecord[]>();
  for (const row of persisted.rows) records.set(row.component, [...(records.get(row.component) ?? []), row.record_json]);
  const manifest = parseJson<ShardManifest>(originals.get("manifest.json")!);
  let changed = false;
  for (const component of manifest.components) {
    const filename = originals.has(`${component}.json`) ? `${component}.json` : `${component}.jsonl`;
    const bytes = originals.get(filename)!;
    const source = filename.endsWith(".json") ? parseJson<WireRecord[]>(bytes)
      : decoder.decode(bytes).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const current = records.get(component) ?? [];
    if (JSON.stringify(source) === JSON.stringify(current)) continue;
    // JSONB changes key order. Compare structurally before rewriting bytes.
    if (isDeepStrictEqual(source, current)) continue;
    const updated = filename.endsWith(".json") ? encodeJson(current)
      : encoder.encode(current.map(record => JSON.stringify(record)).join("\n"));
    originals.set(filename, updated);
    manifest.checksums[filename] = digest(updated);
    if (component === "communities") {
      manifest.counts.community_sets = current.length;
      manifest.counts.communities = current.reduce((total, set) => total + (set.communities as unknown[]).length, 0);
    } else manifest.counts[component] = current.length;
    changed = true;
  }
  if (changed) {
    originals.delete("signature.json");
    originals.set("manifest.json", encodeJson(manifest));
  }
  for (const [filename, bytes] of unpackTarGz(result.archive)) {
    if (filename.startsWith("blobs/")) originals.set(filename, bytes);
  }
  const archive = packTarGz(originals);
  const validation = await validateAiwgFortemiKnowledgeShard(archive);
  return {
    ...result,
    success: validation.valid,
    archive: validation.valid ? archive : null,
    errors: validation.errors,
    capability_report: readerCapability(version, result.capability_report),
  };
}
