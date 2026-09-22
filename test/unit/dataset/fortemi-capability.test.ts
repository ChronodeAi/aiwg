import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareFortemiCapabilityVersions,
  negotiateFortemiCapabilities,
  validateFortemiCapabilityDescriptor,
  validateFortemiCapabilityRequest,
} from "../../../src/dataset/fortemi-capability.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = (name: string) => read(`../../fixtures/dataset/fortemi-capability/${name}`);
const json = (name: string) => JSON.parse(fixture(name));
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const authority = JSON.parse(read("../../../schemas/dataset/fortemi-capability-validation/1.0.1/authority.json"));
const manifest = json("authority-manifest.json");
const wire = json("wire-vectors.json");

describe("Fortemi capability authority pin", () => {
  it("retains the authority files byte-for-byte under the recorded digests", () => {
    const pinned: Record<string, string> = {
      "schema.json": read("../../../schemas/dataset/fortemi-capability-validation/1.0.1/capability.schema.json"),
      "negotiation-vectors.json": fixture("negotiation-vectors.json"),
      "wire-vectors.json": fixture("wire-vectors.json"),
    };
    for (const file of manifest.files) expect(digest(pinned[file.path]), file.path).toBe(file.sha256);
    expect(digest(fixture("authority-manifest.json"))).toBe(authority.authority.manifestSha256);
    for (const file of authority.files) {
      const source = file.authorityPath === "schema.json" ? pinned["schema.json"] : pinned[file.authorityPath];
      expect(digest(source), file.authorityPath).toBe(file.sha256);
    }
    expect(manifest.revision).toBe(authority.revision);
    expect(manifest.consumers).toContain("roctinam/aiwg dataset execution");
  });

  it("keeps the retained producer descriptor under its recorded digest", () => {
    expect(digest(fixture("server-descriptor.json"))).toBe(authority.observedDescriptor.sha256);
  });
});

describe("Fortemi capability SemVer precedence", () => {
  it("satisfies every shared authority version vector in both directions", () => {
    const vectors = json("negotiation-vectors.json").versions;
    expect(vectors).toHaveLength(20);
    for (const vector of vectors) {
      const comparison = compareFortemiCapabilityVersions(vector.offered, vector.minimum);
      expect(comparison !== null && comparison >= 0, vector.id).toBe(vector.accepted);
      if (comparison !== null) {
        expect(compareFortemiCapabilityVersions(vector.minimum, vector.offered)! + comparison, vector.id).toBe(0);
        expect(compareFortemiCapabilityVersions(vector.offered, vector.offered), vector.id).toBe(0);
      }
    }
  });

  it("reports unparseable versions as incomparable rather than equal", () => {
    for (const value of ["", "1.0", "01.0.0", "1.0.0\n", "9007199254740992.0.0", null, 1, {}]) {
      expect(compareFortemiCapabilityVersions(value, "1.0.0"), String(value)).toBeNull();
      expect(compareFortemiCapabilityVersions("1.0.0", value), String(value)).toBeNull();
    }
  });
});

describe("Fortemi capability wire negotiation", () => {
  it("reproduces every shared authority wire decision", () => {
    expect(wire.cases).toHaveLength(11);
    for (const vector of wire.cases) {
      const diagnostics = [
        ...validateFortemiCapabilityDescriptor(vector.descriptor),
        ...validateFortemiCapabilityRequest(vector.request),
      ];
      expect(diagnostics.length === 0, `${vector.id}: ${diagnostics.join(",")}`).toBe(vector.valid);
      const decision = negotiateFortemiCapabilities(vector.descriptor, vector.request);
      expect(decision.accepted, vector.id).toBe(vector.valid === true && vector.accepted === true);
      if (!decision.accepted) expect(decision.diagnostics.length, vector.id).toBeGreaterThan(0);
    }
  });

  it("names the rejection cause for each invalid authority descriptor or request", () => {
    const causes: Record<string, string> = {
      "next-schema-major": "SCHEMA_VERSION_UNSUPPORTED",
      "unknown-status": "DESCRIPTOR_INVALID",
      "missing-evidence": "DESCRIPTOR_INVALID",
      "null-descriptor": "DESCRIPTOR_INVALID",
      "null-request": "REQUEST_SCHEMA_INVALID",
      "unknown-request-field": "REQUEST_SCHEMA_INVALID",
      "invalid-limit": "REQUEST_SCHEMA_INVALID",
      "next-contract-major": "CONTRACT_MAJOR_UNSUPPORTED",
      "unavailable-required": "REQUIRED_CAPABILITY_MISSING",
    };
    for (const [id, code] of Object.entries(causes)) {
      const vector = wire.cases.find((item: { id: string }) => item.id === id);
      const decision = negotiateFortemiCapabilities(vector.descriptor, vector.request);
      expect(decision.diagnostics.some(entry => entry.startsWith(code)), `${id}: ${decision.diagnostics.join(",")}`).toBe(true);
    }
  });

  it("accepts the retained producer descriptor and binds the live request decision", () => {
    const descriptor = json("server-descriptor.json");
    expect(validateFortemiCapabilityDescriptor(descriptor)).toEqual([]);
    const request = JSON.parse(read("../../fixtures/dataset/fortemi-run-receipt/supported-request.json"));
    const decision = negotiateFortemiCapabilities(descriptor, request.negotiation);
    expect(decision.accepted).toBe(true);
    expect(decision.selected).toEqual([
      "ingest.incremental", "mutation.upsert", "checkpoint.write", "transaction.atomic-batch", "lineage.record", "index.lexical",
    ]);
    expect(decision.degradations).toEqual([
      { requested: "index.graph", selected: "index.lexical", reason: "unsupported", changedGuarantees: ["index.graph replaced by index.lexical"] },
    ]);
  });

  it("rejects a descriptor whose guarantees outrun its declared capabilities", () => {
    const descriptor = json("server-descriptor.json");
    descriptor.capabilities = descriptor.capabilities.filter((capability: { id: string }) => capability.id !== "transaction.atomic-batch");
    expect(validateFortemiCapabilityDescriptor(descriptor)).toContain("CAPABILITY_INCONSISTENT:transaction.atomic-batch");
  });

  it("rejects duplicated and unevidenced capability declarations", () => {
    const duplicated = json("server-descriptor.json");
    duplicated.capabilities.push(structuredClone(duplicated.capabilities[0]));
    expect(validateFortemiCapabilityDescriptor(duplicated).some(entry => entry.startsWith("CAPABILITY_DUPLICATE"))).toBe(true);
    const unevidenced = json("server-descriptor.json");
    unevidenced.evidence = [];
    expect(validateFortemiCapabilityDescriptor(unevidenced).some(entry => entry.startsWith("DESCRIPTOR_INVALID"))).toBe(true);
  });

  it("reports a version-insufficient requirement rather than silently degrading it", () => {
    const descriptor = json("server-descriptor.json");
    const decision = negotiateFortemiCapabilities(descriptor, {
      contract: "fortemi.dataset-execution-capabilities/v1",
      required: [{ id: "ingest.incremental", minimumVersion: "1.1.0" }],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.diagnostics).toContain("CAPABILITY_VERSION_INSUFFICIENT:ingest.incremental");
  });

  it("reports a limit-insufficient optional requirement as a visible degradation", () => {
    const descriptor = json("server-descriptor.json");
    const decision = negotiateFortemiCapabilities(descriptor, {
      contract: "fortemi.dataset-execution-capabilities/v1",
      required: [],
      optional: [{ id: "ingest.full", minimumLimits: { maxBatchRecords: 100000 }, fallback: ["ingest.snapshot"] }],
    });
    expect(decision.accepted).toBe(true);
    expect(decision.selected).toEqual(["ingest.snapshot"]);
    expect(decision.degradations[0].reason).toBe("limit-insufficient");
  });

  it("never mutates the descriptor or request it negotiates", () => {
    const descriptor = json("server-descriptor.json");
    const request = JSON.parse(read("../../fixtures/dataset/fortemi-run-receipt/supported-request.json")).negotiation;
    const before = [JSON.stringify(descriptor), JSON.stringify(request)];
    negotiateFortemiCapabilities(descriptor, request);
    expect([JSON.stringify(descriptor), JSON.stringify(request)]).toEqual(before);
  });
});
