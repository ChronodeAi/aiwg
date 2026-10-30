import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  buildAiwgFortemiKnowledgeShard,
  buildAiwgFortemiKnowledgeShardWithReport,
  diagnoseAiwgFortemiShardMigration,
  resolveAiwgFortemiShardTuple,
  writeAiwgFortemiKnowledgeShard,
  AIWG_FULL_V1_SHARD_READER_VERSIONS,
  importAiwgFortemiKnowledgeShard,
  exportAiwgFortemiKnowledgeShardWithReport,
  validateAiwgFortemiKnowledgeShard,
  type AiwgFortemiShardConverter,
} from "../../../src/artifacts/fortemi-shard-export.js";
import {
  ArchiveManager,
  MemoryBlobStore,
  exportShardWithReport,
  importShard,
  openShard,
  packTarGz,
  unpackTarGz,
  validateFullV1ShardArchive,
  validateShardArchive,
} from "@fortemi/core";
import {
  aiwgFortemiIndexFromKnowledgeShard,
  aiwgFortemiIndexToKnowledgeShardWithReport,
} from "@fortemi/core/aiwg-index-shard";
import { INDEX_DIR } from "../../../src/artifacts/types.js";
import type {
  ArtifactIndex,
  DependencyGraph,
  MetadataEntry,
} from "../../../src/artifacts/types.js";

interface EmbeddedAiwgRecord {
  envelope: {
    source: { repo: string; privacy: string; graph?: string };
    schema_version: string;
  };
  record: {
    source: { checksum?: string; repo_relative_path: string };
    privacy: { classification: string };
    relationships: Array<{ type: string }>;
    chunks?: Array<{ text?: string }>;
    provenance: Array<{ source: string }>;
    operational_state?: {
      source_id: string;
      observed_state: string;
      classification: string;
    };
    state_transfer?: {
      deleted_at: string | null;
    };
    skos_concepts?: Array<{ id: string }>;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedRecords(
  bytes: Uint8Array,
  format: "json" | "jsonl",
): Array<Record<string, unknown>> {
  const text = new TextDecoder().decode(bytes);
  const values = format === "json"
    ? JSON.parse(text)
    : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return (values as Array<Record<string, unknown>>)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

describe("AIWG portable Fortemi shard export", () => {
  let tmpDir: string;
  const encoded = new TextEncoder().encode("portable-shard");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-fortemi-shard-"));
    const indexDir = path.join(tmpDir, INDEX_DIR);
    fs.mkdirSync(indexDir, { recursive: true });
    const recordPath = ".aiwg/design/ADR-001.md";
    const targetPath = ".aiwg/requirements/UC-001.md";
    const entry: MetadataEntry = {
      path: recordPath,
      type: "adr",
      phase: "architecture",
      title: "Portable Fortemi transport",
      tags: ["fortemi"],
      created: "2026-07-15T00:00:00.000Z",
      updated: "2026-07-16T00:00:00.000Z",
      checksum: "abc123",
      summary: "Preserve the complete AIWG record in a Knowledge Shard.",
      dependencies: [targetPath],
      dependents: [],
      operationalState: {
        source_repo: "roctinam/aiwg",
        source_kind: "issue",
        source_id: "aiwg#1827",
        observed_state: "open",
        observed_at: "2026-07-16T00:00:00.000Z",
        source_updated_at: "2026-07-16T00:00:00.000Z",
        evidence_url: "https://git.integrolabs.net/roctinam/aiwg/issues/1827",
        observer: "gitea-mcp",
        classification: "fresh",
        confidence: "source",
        current_action_selector: true,
      },
      stateTransfer: {
        deletedAt: null,
      },
    };
    const target: MetadataEntry = {
      path: targetPath,
      type: "requirement",
      phase: "requirements",
      title: "Shard import compatibility",
      tags: ["fortemi"],
      created: "2026-07-15T00:00:00.000Z",
      updated: "2026-07-16T00:00:00.000Z",
      checksum: "def456",
      summary: "Import the shard without custom transformation.",
      dependencies: [],
      dependents: [recordPath],
      stateTransfer: {
        deletedAt: "2026-07-25T09:30:00.000Z",
      },
    };
    const index: ArtifactIndex = {
      version: "1.0.0",
      builtAt: "2026-07-16T00:00:00.000Z",
      buildTimeMs: 1,
      entries: { [recordPath]: entry, [targetPath]: target },
    };
    const graph: DependencyGraph = {
      [recordPath]: {
        upstream: [{ path: targetPath, type: "depends-on" }],
        downstream: [],
      },
      [targetPath]: {
        upstream: [],
        downstream: [{ path: recordPath, type: "depended-by" }],
      },
    };
    fs.writeFileSync(path.join(indexDir, "metadata.json"), JSON.stringify(index));
    fs.writeFileSync(path.join(indexDir, "dependencies.json"), JSON.stringify(graph));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("always sends a v2 export to the canonical converter", async () => {
    const converter: AiwgFortemiShardConverter = async (index, options) => {
      expect(index.schema_version).toBe("aiwg.fortemi.index.export.v2");
      expect(index.items).toHaveLength(2);
      expect(options).toMatchObject({
        createdAt: "2026-07-16T00:00:00.000Z",
        matricVersion: "aiwg",
      });
      return encoded;
    };

    const shard = await buildAiwgFortemiKnowledgeShard(
      tmpDir,
      {
        repo: "roctinam/aiwg",
        privacy: "sanitized",
        generatedAt: "2026-07-16T00:00:00.000Z",
        schemaVersion: "1.2.0",
        profile: "core-v1",
      },
      converter,
    );

    expect(shard).toEqual(encoded);
  });

  it("writes binary shard output and reports the exported record count", async () => {
    const out = path.join("artifacts", "aiwg-project.shard");
    const result = await writeAiwgFortemiKnowledgeShard(
      tmpDir,
      out,
      {
        generatedAt: "2026-07-16T00:00:00.000Z",
        schemaVersion: "1.2.0",
        profile: "core-v1",
      },
      async () => encoded,
    );

    expect(fs.readFileSync(path.join(tmpDir, out))).toEqual(Buffer.from(encoded));
    expect(result).toEqual({
      bytes: encoded.byteLength,
      items: 2,
      outPath: path.join(tmpDir, out),
      written: true,
      conversion: {
        schemaVersion: "1.2.0",
        profile: "core-v1",
        success: true,
        lossless: true,
        losses: [],
        receipt: null,
      },
    });
  });

  it("defaults to exact full-v1, rejects invalid tuples, and fails closed on loss", async () => {
    expect(resolveAiwgFortemiShardTuple({})).toEqual({
      schemaVersion: "2.0.0",
      profile: "full-v1",
    });
    expect(() => resolveAiwgFortemiShardTuple({
      schemaVersion: "1.2.0",
      profile: "full-v1",
    })).toThrow(/Unsupported Fortemi Knowledge Shard tuple/);

    await expect(buildAiwgFortemiKnowledgeShardWithReport(
      tmpDir,
      { failOnLoss: true },
      undefined,
      async () => ({
        success: true,
        archive: encoded,
        profile: "full-v1",
        schema_version: "2.0.0",
        lossless: false,
        losses: [{ component: "attachments", reason: "fixture-loss" }],
        receipt: { schema_version: "fixture" },
      }),
    )).rejects.toThrow(/reported 1 loss/);
  });

  it("is dry-run capable, non-overwriting, and gives source-less legacy artifacts an actionable diagnostic", async () => {
    const out = path.join("artifacts", "dry-run.shard");
    const dryRun = await writeAiwgFortemiKnowledgeShard(
      tmpDir,
      out,
      {
        schemaVersion: "1.2.0",
        profile: "core-v1",
        dryRun: true,
      },
      async () => encoded,
    );
    expect(dryRun.written).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, out))).toBe(false);

    fs.mkdirSync(path.dirname(path.join(tmpDir, out)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, out), "existing");
    await expect(writeAiwgFortemiKnowledgeShard(
      tmpDir,
      out,
      { schemaVersion: "1.2.0", profile: "core-v1" },
      async () => encoded,
    )).rejects.toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(path.join(tmpDir, out), "utf8")).toBe("existing");

    expect(diagnoseAiwgFortemiShardMigration(tmpDir, out)).toMatchObject({
      supported: false,
      mutationPlanned: false,
      diagnostic: expect.stringContaining("cannot be reconstructed"),
      action: expect.stringContaining("--schema-version 2.0.0 --profile full-v1"),
    });
  });

  it("uses the current Fortemi Core converter to produce an importable cross-repository shard", async () => {
    const shard = await buildAiwgFortemiKnowledgeShard(tmpDir, {
      repo: "Fortemi/fortemi-react",
      privacy: "sanitized",
      generatedAt: "2026-07-16T00:00:00.000Z",
      schemaVersion: "1.2.0",
      profile: "core-v1",
    });
    const repeated = await buildAiwgFortemiKnowledgeShard(tmpDir, {
      repo: "Fortemi/fortemi-react",
      privacy: "sanitized",
      generatedAt: "2026-07-16T00:00:00.000Z",
      schemaVersion: "1.2.0",
      profile: "core-v1",
    });

    const validation = validateShardArchive(shard);
    expect(validation).toEqual({ valid: true, errors: [] });
    expect(repeated).toEqual(shard);

    const reader = await openShard(shard);
    try {
      const notes = await reader.listNotes();
      expect(notes.total).toBe(1);
      expect(notes.items[0]?.source).toBe("aiwg-index");
      const sourceRecord = notes.items
        .map((note) => note.ai_metadata?.aiwg_fortemi_index as EmbeddedAiwgRecord | undefined)
        .find((embedded) => embedded?.record.source.checksum === "abc123");
      expect(sourceRecord).toBeDefined();
      expect(sourceRecord.envelope.source).toMatchObject({
        repo: "Fortemi/fortemi-react",
        privacy: "sanitized",
        graph: "project",
      });
      expect(sourceRecord.envelope.schema_version).toBe(
        "aiwg.fortemi.index.export.v2",
      );
      expect(sourceRecord.record).toMatchObject({
        source: {
          checksum: "abc123",
          repo_relative_path: ".aiwg/design/ADR-001.md",
        },
        privacy: { classification: "sanitized" },
      });
      expect(sourceRecord.record.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "depends-on",
            target_path: ".aiwg/requirements/UC-001.md",
          }),
        ]),
      );
      expect(sourceRecord.record.chunks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.any(String) }),
        ]),
      );
      expect(sourceRecord.record.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "aiwg-index" }),
        ]),
      );
      expect(sourceRecord.record.operational_state).toMatchObject({
        source_id: "aiwg#1827",
        observed_state: "open",
        classification: "fresh",
      });
      expect(sourceRecord.record.state_transfer).toEqual({
        deleted_at: null,
      });
      expect(sourceRecord.record.skos_concepts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "aiwg-tags:fortemi" }),
        ]),
      );
    } finally {
      reader.close();
    }
  });

  it("consumes the released public full-v1 converter deterministically as the default profile evidence", async () => {
    const fixtureRoot = path.resolve(
      process.cwd(),
      "test/fixtures/fortemi-shard",
    );
    const sourceBytes = fs.readFileSync(
      path.join(fixtureRoot, "aiwg-full-v1-source.json"),
    );
    const expectedArchive = new Uint8Array(
      fs.readFileSync(path.join(fixtureRoot, "aiwg-full-v1.shard")),
    );
    const source = JSON.parse(sourceBytes.toString("utf8")) as Parameters<
      typeof aiwgFortemiIndexToKnowledgeShardWithReport
    >[0];
    const options = {
      createdAt: "2026-07-22T12:00:00.000Z",
      matricVersion: "2026.7.13-candidate",
    };

    const first = await aiwgFortemiIndexToKnowledgeShardWithReport(
      source,
      options,
    );
    const repeated = await aiwgFortemiIndexToKnowledgeShardWithReport(
      source,
      options,
    );

    expect(first.success).toBe(true);
    expect(first.lossless).toBe(true);
    expect(first.losses).toEqual([]);
    expect(first.archive).toEqual(expectedArchive);
    expect(repeated.archive).toEqual(expectedArchive);
    expect(repeated.receipt).toEqual(first.receipt);
    expect(sha256(sourceBytes)).toBe(
      "4cb6d89768f0ec37851012e3df4aedf09622dce911d76233916f099e10d5cfde",
    );
    expect(sha256(expectedArchive)).toBe(
      "df87edc5725e3f0c8d95d8d4328c64a263e9b021520a127d9df5b7301c2afee5",
    );
    expect(await validateFullV1ShardArchive(expectedArchive)).toEqual({
      valid: true,
      errors: [],
    });
    expect(first.receipt).toMatchObject({
      schema_version: "fortemi.aiwg-full-v1-conversion-receipt.v1",
      authority_commit: "6343bd899958445bbc7e7e87b0dc92a8429d5a06",
      authority_contract_sha256:
        "5bf8d2fd8147d8df92599b1a3ce6b405ce022c83893f37547aefa7ca659f0783",
      authority_schema_bundle_sha256:
        "66dee80876c73fdc8756541c72e96ae189c098113a831c849d619381c4121c02",
      contract_valid: true,
      signed: false,
    });

    const files = unpackTarGz(expectedArchive);
    const manifest = JSON.parse(
      new TextDecoder().decode(files.get("manifest.json")!),
    ) as {
      version: string;
      profile: string;
      components: string[];
    };
    expect(manifest).toMatchObject({
      version: "2.0.0",
      profile: "full-v1",
    });
    expect(manifest.components).toHaveLength(33);
  });

  it("round-trips through a fresh PGlite destination without transforming package bytes", async () => {
    const shard = await buildAiwgFortemiKnowledgeShard(tmpDir, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
      generatedAt: "2026-07-16T00:00:00.000Z",
      schemaVersion: "1.2.0",
      profile: "core-v1",
    });
    if (process.env.AIWG_FORTEMI_FIXTURE_OUT) {
      fs.writeFileSync(process.env.AIWG_FORTEMI_FIXTURE_OUT, shard);
    }
    const committedCoreV1 = new Uint8Array(
      fs.readFileSync(
        path.resolve(
          process.cwd(),
          "test/fixtures/fortemi-shard/aiwg-core-v1.shard",
        ),
      ),
    );
    expect(shard).toEqual(committedCoreV1);
    const manager = new ArchiveManager("memory");
    try {
      const destination = await manager.create("aiwg-shard-receipt");
      const before = await destination.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM note",
      );
      expect(before.rows[0]?.count).toBe(0);

      const imported = await importShard(destination, shard);
      expect(imported.success).toBe(true);
      expect(imported.counts).toMatchObject({
        notes: 2,
        collections: 3,
        tags: 2,
        links: 2,
      });
      const repeated = await importShard(destination, shard);
      expect(repeated.success).toBe(true);
      expect(repeated.counts).toMatchObject({
        notes: 0,
        collections: 0,
        tags: 0,
        links: 0,
      });

      const persisted = await destination.query<{
        title: string;
        deleted_at: string | null;
        collection_name: string;
        parent_name: string;
      }>(`
        SELECT
          n.title,
          CASE
            WHEN n.deleted_at IS NULL THEN NULL
            ELSE to_char(
              n.deleted_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          END AS deleted_at,
          c.name AS collection_name,
          p.name AS parent_name
        FROM note n
        JOIN collection_note cn ON cn.note_id = n.id
        JOIN collection c ON c.id = cn.collection_id
        LEFT JOIN collection p ON p.id = c.parent_id
        ORDER BY n.title
      `);
      expect(persisted.rows).toEqual([
        {
          title: "Portable Fortemi transport",
          deleted_at: null,
          collection_name: "design",
          parent_name: ".aiwg",
        },
        {
          title: "Shard import compatibility",
          deleted_at: "2026-07-25T09:30:00.000Z",
          collection_name: "requirements",
          parent_name: ".aiwg",
        },
      ]);

      const reexport = await exportShardWithReport(destination, { profile: "core-v1" });
      expect(reexport.success).toBe(true);
      expect(reexport.capability_report).toMatchObject({
        requested_profile: "core-v1",
        authority_status: "supported",
        portable: true,
        losses: [],
      });
      expect(reexport.archive).not.toBeNull();
      const sourceFiles = unpackTarGz(shard);
      const reexportedFiles = unpackTarGz(reexport.archive!);
      expect(
        sortedRecords(reexportedFiles.get("collections.json")!, "json"),
      ).toEqual(sortedRecords(sourceFiles.get("collections.json")!, "json"));
      expect(
        sortedRecords(reexportedFiles.get("notes.jsonl")!, "jsonl"),
      ).toEqual(sortedRecords(sourceFiles.get("notes.jsonl")!, "jsonl"));
      const restored = aiwgFortemiIndexFromKnowledgeShard(reexport.archive!);
      expect(restored.source).toMatchObject({
        repo: "roctinam/aiwg",
        privacy: "sanitized",
        graph: "project",
      });
      expect(restored.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({ checksum: "abc123" }),
            privacy: expect.objectContaining({ classification: "sanitized" }),
            relationships: expect.arrayContaining([
              expect.objectContaining({ type: "depends-on" }),
            ]),
            operational_state: expect.objectContaining({
              source_id: "aiwg#1827",
              observed_state: "open",
              classification: "fresh",
            }),
            state_transfer: { deleted_at: null },
          }),
          expect.objectContaining({
            source: expect.objectContaining({ checksum: "def456" }),
            state_transfer: {
              deleted_at: "2026-07-25T09:30:00.000Z",
            },
          }),
        ]),
      );

      const oldestDefinedFiles = unpackTarGz(shard);
      const oldestDefinedNotes = new TextDecoder()
        .decode(oldestDefinedFiles.get("notes.jsonl")!)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const note = JSON.parse(line);
          delete note.deleted_at;
          return JSON.stringify(note);
        });
      const oldestDefinedNoteBytes = new TextEncoder().encode(
        oldestDefinedNotes.join("\n"),
      );
      oldestDefinedFiles.set("notes.jsonl", oldestDefinedNoteBytes);
      const oldestDefinedManifest = JSON.parse(
        new TextDecoder().decode(oldestDefinedFiles.get("manifest.json")!),
      );
      oldestDefinedManifest.version = "1.0.0";
      oldestDefinedManifest.min_reader_version = "1.0.0";
      oldestDefinedManifest.checksums["notes.jsonl"] = sha256(
        oldestDefinedNoteBytes,
      );
      oldestDefinedFiles.set(
        "manifest.json",
        new TextEncoder().encode(JSON.stringify(oldestDefinedManifest, null, 2)),
      );
      const oldestDestination = await manager.create("aiwg-shard-current-minus-two");
      const oldestImported = await importShard(
        oldestDestination,
        packTarGz(oldestDefinedFiles),
      );
      expect(oldestImported.success, oldestImported.errors.join("; ")).toBe(true);
      expect(oldestImported.counts).toMatchObject({
        notes: 2,
        collections: 3,
        tags: 2,
        links: 2,
      });
    } finally {
      await manager.close();
    }
  }, 45_000);

  it("rejects malformed, checksum, profile, version, and resource-limit input with zero mutation", async () => {
    const shard = await buildAiwgFortemiKnowledgeShard(tmpDir, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
      generatedAt: "2026-07-16T00:00:00.000Z",
      schemaVersion: "1.2.0",
      profile: "core-v1",
    });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const replaceManifest = (
      mutate: (manifest: { profile?: unknown; version?: unknown }) => void,
    ) => {
      const files = unpackTarGz(shard);
      const manifest = JSON.parse(decoder.decode(files.get("manifest.json")!));
      mutate(manifest);
      files.set("manifest.json", encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
      return packTarGz(files);
    };
    const checksumDrift = (() => {
      const files = unpackTarGz(shard);
      files.set("notes.jsonl", encoder.encode("{}\n"));
      return packTarGz(files);
    })();
    const oversized = Uint8Array.from(shard);
    new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength)
      .setUint32(oversized.byteLength - 4, 300 * 1024 * 1024, true);
    const cases = [
      { name: "malformed gzip", bytes: encoder.encode("not-a-shard") },
      { name: "checksum drift", bytes: checksumDrift },
      { name: "unsupported profile", bytes: replaceManifest(manifest => { manifest.profile = "unknown-v1"; }) },
      { name: "future version", bytes: replaceManifest(manifest => { manifest.version = "2.0.0"; }) },
      { name: "resource limit", bytes: oversized },
    ];

    const manager = new ArchiveManager("memory");
    try {
      const destination = await manager.create("aiwg-shard-zero-mutation");
      for (const testCase of cases) {
        const result = await importShard(destination, testCase.bytes).catch(error => error);
        expect(
          result instanceof Error || result?.success === false,
          `${testCase.name} must be rejected`,
        ).toBe(true);
        const count = await destination.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM note",
        );
        expect(count.rows[0]?.count, `${testCase.name} mutated the destination`).toBe(0);
      }
    } finally {
      await manager.close();
    }
  }, 20_000);
});

const shardFixtureRoot = path.resolve("test/fixtures/fortemi-shard");
const shard22FixtureRoot = path.join(shardFixtureRoot, "full-v1-query-template-v2.2");
const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const readJson = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes));
type EmbeddingRecord = Record<string, unknown>;

function corpusShard(
  mutate?: (sets: EmbeddingRecord[], configs: EmbeddingRecord[], manifest: Record<string, unknown>) => void,
): Uint8Array {
  const files = unpackTarGz(fs.readFileSync(path.join(shardFixtureRoot, "aiwg-full-v1.shard")));
  const manifest = readJson<Record<string, unknown>>(files.get("manifest.json")!);
  manifest.version = "2.2.0";
  manifest.min_reader_version = "2.2.0";
  const componentNames = ["embedding_sets", "embedding_configs"];
  const values = componentNames.map(component => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(shard22FixtureRoot, `${component}.json`)));
    files.set(`${component}.json`, bytes);
    return readJson<EmbeddingRecord[]>(bytes);
  });
  if (mutate) {
    mutate(values[0], values[1], manifest);
    componentNames.forEach((component, index) => files.set(`${component}.json`, jsonBytes(values[index])));
  }
  for (const [index, component] of componentNames.entries()) {
    (manifest.counts as Record<string, number>)[component] = values[index].length;
    (manifest.checksums as Record<string, string>)[`${component}.json`] = sha256(files.get(`${component}.json`)!);
  }
  files.set("manifest.json", jsonBytes(manifest));
  return packTarGz(files);
}

describe("AIWG Knowledge Shard 2.2.0 full-v1 candidate qualification", () => {
  let manager: ArchiveManager;
  beforeEach(() => { manager = new ArchiveManager("memory"); });
  afterEach(async () => { await manager.close(); });

  it("qualifies the pinned Fortemi corpus with byte-equivalent files and fields after persistence and re-import", async () => {
    expect(fs.readFileSync(path.join(shard22FixtureRoot, "PROVENANCE.txt"), "utf8"))
      .toContain("b88084407751153e67a9279fff9303cc3db70474");
    expect(sha256(fs.readFileSync(path.join(shard22FixtureRoot, "embedding_sets.json"))))
      .toBe("f279cad22517395194c6a5dc327b4531bd089e151b9141324c94f01e81bacf32");
    expect(sha256(fs.readFileSync(path.join(shard22FixtureRoot, "embedding_configs.json"))))
      .toBe("bc76206df48215d0da7a3c944874d7af5b6e01bb07df8b5849869025b7d25f89");
    const contractRoot = path.resolve("src/artifacts/fortemi-shard-contract/2.2.0");
    const contract = JSON.parse(fs.readFileSync(path.join(contractRoot, "contract.json"), "utf8"));
    for (const name of ["manifest", "embedding-set", "embedding-config"]) {
      expect(sha256(fs.readFileSync(path.join(contractRoot, `full-v1-${name}.schema.json`))))
        .toBe(contract.schemaBundle.files[`contracts/knowledge-shard/2.2.0/full-v1/${name}.schema.json`]);
    }
    const archive = corpusShard();
    expect(await validateAiwgFortemiKnowledgeShard(archive)).toEqual({ valid: true, errors: [] });
    const destination = await manager.create("shard22-corpus");
    const imported = await importAiwgFortemiKnowledgeShard(destination, archive);
    expect(imported.success, imported.errors.join("; ")).toBe(true);
    expect(imported.component_counts).toMatchObject({ embedding_sets: 2, embedding_configs: 2 });
    await expect(exportAiwgFortemiKnowledgeShardWithReport(destination, {
      profile: "full-v1", schemaVersion: "2.0.0", blobStore: new MemoryBlobStore(),
    })).rejects.toThrow(/refusing a lossy downgrade/);
    expect(imported.capability_report).toMatchObject({
      requested_schema_version: "2.2.0", advertised_profiles: ["full-v1"], authority_status: "candidate",
      authority: { commit: "b88084407751153e67a9279fff9303cc3db70474" },
    });
    expect(AIWG_FULL_V1_SHARD_READER_VERSIONS).toContain("2.2.0");
    expect((await importAiwgFortemiKnowledgeShard(destination, archive)).success).toBe(true);
    const persisted = await destination.query<{ component: string; record_json: EmbeddingRecord }>(
      "SELECT component, record_json FROM knowledge_shard_component_record WHERE component IN ('embedding_sets', 'embedding_configs') ORDER BY component, ordinal",
    );
    for (const component of ["embedding_configs", "embedding_sets"]) {
      const expected = JSON.parse(fs.readFileSync(path.join(shard22FixtureRoot, `${component}.json`), "utf8"));
      expect(persisted.rows.filter(row => row.component === component).map(row => row.record_json)).toEqual(expected);
    }
    const reexport = await exportAiwgFortemiKnowledgeShardWithReport(destination, {
      profile: "full-v1", schemaVersion: "2.2.0", blobStore: new MemoryBlobStore(),
    });
    expect(reexport.success, reexport.errors.join("; ")).toBe(true);
    const files = unpackTarGz(reexport.archive!);
    for (const component of ["embedding_sets", "embedding_configs"]) {
      expect(files.get(`${component}.json`)).toEqual(new Uint8Array(
        fs.readFileSync(path.join(shard22FixtureRoot, `${component}.json`)),
      ));
    }
    const fresh = await manager.create("shard22-reimport");
    expect((await importAiwgFortemiKnowledgeShard(fresh, reexport.archive!)).success).toBe(true);
    const again = await exportAiwgFortemiKnowledgeShardWithReport(fresh, {
      profile: "full-v1", schemaVersion: "2.2.0", blobStore: new MemoryBlobStore(),
    });
    expect(again.success, again.errors.join("; ")).toBe(true);
    expect(again.archive).toEqual(reexport.archive);
  }, 45_000);

  it.each(["absent", "null", "internal", "external"])("preserves %s vector ownership and nullable query/provider fields", async ownership => {
    const archive = corpusShard((sets, configs) => {
      if (ownership === "absent") {
        delete sets[0].query_template;
        delete sets[0].vector_source;
        delete configs[0].provider_dimension;
      } else {
        sets[0].query_template = null;
        sets[0].vector_source = ownership === "null" ? null : ownership;
        configs[0].provider_dimension = null;
      }
    });
    const destination = await manager.create(`shard22-${ownership}`);
    const imported = await importAiwgFortemiKnowledgeShard(destination, archive);
    expect(imported.success, imported.errors.join("; ")).toBe(true);
    const exported = await exportAiwgFortemiKnowledgeShardWithReport(destination, {
      profile: "full-v1", schemaVersion: "2.2.0", blobStore: new MemoryBlobStore(),
    });
    expect(exported.success, exported.errors.join("; ")).toBe(true);
    const source = unpackTarGz(archive);
    const restored = unpackTarGz(exported.archive!);
    for (const component of ["embedding_sets.json", "embedding_configs.json"]) expect(restored.get(component)).toEqual(source.get(component));
    const set = readJson<EmbeddingRecord[]>(restored.get("embedding_sets.json")!)[0];
    expect(set.vector_source ?? "internal").toBe(ownership === "external" ? "external" : "internal");
  }, 20_000);

  it.each([
    ["invalid vector_source", (sets: EmbeddingRecord[]) => { sets[0].vector_source = "remote"; }],
    ["query without placeholder", (sets: EmbeddingRecord[]) => { sets[0].query_template = "no placeholder"; }],
    ["repeated query placeholder", (sets: EmbeddingRecord[]) => { sets[0].query_template = "{text}{text}"; }],
    ["UTF-8 query limit", (sets: EmbeddingRecord[]) => { sets[0].query_template = `${"😀".repeat(512)}{text}`; }],
    ["provider dimension below storage", (_sets: EmbeddingRecord[], configs: EmbeddingRecord[]) => { configs[0].provider_dimension = 512; }],
    ["provider dimension above limit", (_sets: EmbeddingRecord[], configs: EmbeddingRecord[]) => { configs[0].provider_dimension = 16385; }],
  ] as const)("rejects %s before any database call", async (_label, mutate) => {
    const destination = await manager.create("shard22-invalid");
    const query = vi.spyOn(destination, "query");
    const transaction = vi.spyOn(destination, "transaction");
    await expect(importAiwgFortemiKnowledgeShard(destination, corpusShard(mutate)))
      .rejects.toThrow(/Canonical full-v1 validation failed/);
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  }, 20_000);

  it.each(["core-v1", "record-v1", "unknown-v1"])("fails closed for un-upgraded 2.2.0/%s with zero writes", async profile => {
    const archive = corpusShard((_sets, _configs, manifest) => { manifest.profile = profile; });
    expect((await validateAiwgFortemiKnowledgeShard(archive)).valid).toBe(false);
    const destination = await manager.create("shard22-profile");
    const transaction = vi.spyOn(destination, "transaction");
    const query = vi.spyOn(destination, "query");
    await expect(importAiwgFortemiKnowledgeShard(destination, archive)).rejects.toThrow(/Unsupported/);
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    await expect(exportAiwgFortemiKnowledgeShardWithReport(destination, { profile, schemaVersion: "2.2.0" }))
      .rejects.toThrow(/Unsupported/);
  }, 20_000);

  it("exports edits to the candidate fields and rejects invalid persisted ownership", async () => {
    const destination = await manager.create("shard22-edits");
    expect((await importAiwgFortemiKnowledgeShard(destination, corpusShard())).success).toBe(true);
    await destination.query(
      "UPDATE knowledge_shard_component_record SET record_json = jsonb_set(record_json, '{query_template}', $1::jsonb) WHERE schema_version = '2.2.0' AND component = 'embedding_sets' AND ordinal = 0",
      [JSON.stringify("Find matching synthetic records:\n{text}")],
    );
    await destination.query(
      "UPDATE knowledge_shard_component_record SET record_json = jsonb_set(record_json, '{provider_dimension}', '8192'::jsonb) WHERE schema_version = '2.2.0' AND component = 'embedding_configs' AND ordinal = 0",
    );
    const options = { profile: "full-v1", schemaVersion: "2.2.0" as const, blobStore: new MemoryBlobStore() };
    const exported = await exportAiwgFortemiKnowledgeShardWithReport(destination, options);
    expect(exported.success, exported.errors.join("; ")).toBe(true);
    const files = unpackTarGz(exported.archive!);
    expect(readJson<EmbeddingRecord[]>(files.get("embedding_sets.json")!)[0]).toMatchObject({
      query_template: "Find matching synthetic records:\n{text}", vector_source: "external",
    });
    expect(readJson<EmbeddingRecord[]>(files.get("embedding_configs.json")!)[0]).toMatchObject({ provider_dimension: 8192 });
    expect(await validateAiwgFortemiKnowledgeShard(exported.archive!)).toEqual({ valid: true, errors: [] });
    await destination.query(
      "UPDATE knowledge_shard_component_record SET record_json = jsonb_set(record_json, '{vector_source}', $1::jsonb) WHERE schema_version = '2.2.0' AND component = 'embedding_sets' AND ordinal = 0",
      [JSON.stringify("invalid")],
    );
    const invalid = await exportAiwgFortemiKnowledgeShardWithReport(destination, options);
    expect(invalid.success).toBe(false);
    expect(invalid.archive).toBeNull();
    expect(invalid.errors.join("; ")).toMatch(/embedding_sets/);
  }, 20_000);

  it("retains 2.1.0 and 2.0.0 full-v1 support and legacy 1.x core-v1 support", async () => {
    for (const version of ["2.0.0", "2.1.0"]) {
      const files = unpackTarGz(fs.readFileSync(path.join(shardFixtureRoot, "aiwg-full-v1.shard")));
      const manifest = readJson<Record<string, unknown>>(files.get("manifest.json")!);
      manifest.version = version;
      manifest.min_reader_version = version;
      files.set("manifest.json", jsonBytes(manifest));
      const archive = packTarGz(files);
      const destination = await manager.create(`shard-${version}`);
      const imported = await importAiwgFortemiKnowledgeShard(destination, archive);
      expect(imported.success, imported.errors.join("; ")).toBe(true);
      const exported = await exportAiwgFortemiKnowledgeShardWithReport(destination, {
        profile: "full-v1", schemaVersion: version as "2.0.0" | "2.1.0", blobStore: new MemoryBlobStore(),
      });
      expect(exported.success, exported.errors.join("; ")).toBe(true);
      expect(unpackTarGz(exported.archive!).get("manifest.json")).toEqual(files.get("manifest.json"));
    }
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const files = unpackTarGz(fs.readFileSync(path.join(shardFixtureRoot, "aiwg-core-v1.shard")));
      const manifest = readJson<Record<string, unknown>>(files.get("manifest.json")!);
      manifest.version = version;
      manifest.min_reader_version = version;
      if (version === "1.0.0") {
        const notes = new TextDecoder().decode(files.get("notes.jsonl")!).split("\n").filter(Boolean)
          .map(line => { const note = JSON.parse(line); delete note.deleted_at; return JSON.stringify(note); });
        const bytes = new TextEncoder().encode(notes.join("\n"));
        files.set("notes.jsonl", bytes);
        (manifest.checksums as Record<string, string>)["notes.jsonl"] = sha256(bytes);
      }
      files.set("manifest.json", jsonBytes(manifest));
      const destination = await manager.create(`shard-${version}`);
      const imported = await importAiwgFortemiKnowledgeShard(destination, packTarGz(files));
      expect(imported.success, imported.errors.join("; ")).toBe(true);
    }
  }, 45_000);
});
