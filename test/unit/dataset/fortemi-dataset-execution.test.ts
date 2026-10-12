import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FortemiDatasetExecutionClient } from "../../../src/dataset/fortemi-dataset-execution.js";

const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const receipt = fixture("../../fixtures/dataset/fortemi-run-receipt/degraded-run-receipt.json");
const request = fixture("../../fixtures/dataset/fortemi-run-receipt/supported-request.json");
const descriptor = fixture("../../fixtures/dataset/fortemi-capability/server-descriptor.json");

const capabilities = {
  descriptor,
  contracts: { receipt: "fortemi.dataset-run-receipt/v1", capability: "fortemi.dataset-execution-capabilities/v1" },
  schemaVersions: { receipt: "1.0.0", capability: "1.0.0" },
  receiptValidation: { revision: "1.0.1", requestBindingRevision: "1.0.1" },
};
const negotiation = {
  contract: "fortemi.dataset-execution-capabilities/v1",
  accepted: true,
  runtime: descriptor.runtime,
  selected: receipt.capabilityDecision.selected,
  degradations: receipt.capabilityDecision.degradations,
  diagnostics: [],
};
const preview = { accepted: true, noSideEffects: true, negotiation, requestDigest: receipt.requestDigest };

type Overrides = { capabilities?: unknown; preview?: unknown; execute?: unknown };

function stub(overrides: Overrides = {}) {
  return vi.fn(async (tool: string, args: Record<string, unknown>) => {
    expect(tool).toBe("manage_dataset_execution");
    const result = args.action === "capabilities" ? overrides.capabilities ?? capabilities
      : args.action === "preview" ? overrides.preview ?? preview
      : overrides.execute ?? { state: receipt.state, verification: receipt.verification, receipt };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}

const actions = (callTool: ReturnType<typeof stub>) => callTool.mock.calls.map(([, args]) => args.action);

describe("Fortemi consolidated dataset tool binding", () => {
  it("requires exact approval before executing and independently verifies the returned receipt", async () => {
    const callTool = stub();
    const client = new FortemiDatasetExecutionClient({ callTool });
    await expect(client.execute(request, "")).rejects.toThrow("CONFORMANCE_LIVE_AUTHORIZATION_REQUIRED");
    expect(callTool).not.toHaveBeenCalled();
    await expect(client.execute(request, `sha256:${"0".repeat(64)}`)).rejects.toThrow("CONFORMANCE_FORTEMI_PLAN_NOT_APPROVED");
    expect(actions(callTool)).not.toContain("execute");
    expect(await client.execute(request, receipt.requestDigest)).toEqual(receipt);
  });

  it("rejects legacy validation revisions before preview or execution", async () => {
    const callTool = stub({ capabilities: { ...capabilities, receiptValidation: { revision: "1.0.0" } } });
    await expect(new FortemiDatasetExecutionClient({ callTool }).preview(request)).rejects.toThrow("CONFORMANCE_FORTEMI_RECEIPT_REVISION_UNSUPPORTED");
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("rejects an otherwise valid receipt for a different namespace", async () => {
    const callTool = stub();
    const different = { ...request, plan: { destination: { dataset: "different" } } };
    await expect(new FortemiDatasetExecutionClient({ callTool }).execute(different, receipt.requestDigest)).rejects.toThrow("CONFORMANCE_FORTEMI_PLAN_NOT_APPROVED");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects an invalid advertised capability descriptor before preview", async () => {
    const unevidenced = structuredClone(descriptor);
    unevidenced.evidence = [];
    const callTool = stub({ capabilities: { ...capabilities, descriptor: unevidenced } });
    await expect(new FortemiDatasetExecutionClient({ callTool }).preview(request)).rejects.toThrow("CONFORMANCE_FORTEMI_DESCRIPTOR_INVALID");
    expect(actions(callTool)).toEqual(["capabilities"]);
  });

  it("rejects a capabilities response that advertises no descriptor at all", async () => {
    const { descriptor: _absent, ...withoutDescriptor } = capabilities;
    const callTool = stub({ capabilities: withoutDescriptor });
    await expect(new FortemiDatasetExecutionClient({ callTool }).preview(request)).rejects.toThrow("CONFORMANCE_FORTEMI_DESCRIPTOR_INVALID");
    expect(actions(callTool)).toEqual(["capabilities"]);
  });

  it("refuses a requirement the advertised descriptor cannot satisfy without calling preview", async () => {
    const callTool = stub();
    const unsatisfiable = structuredClone(request);
    unsatisfiable.negotiation.required.push({ id: "index.vector", minimumVersion: "1.0.0" });
    await expect(new FortemiDatasetExecutionClient({ callTool }).preview(unsatisfiable))
      .rejects.toThrow("CONFORMANCE_FORTEMI_CAPABILITY_UNSATISFIED:REQUIRED_CAPABILITY_MISSING:index.vector");
    expect(actions(callTool)).toEqual(["capabilities"]);
  });

  it("rejects a reported decision that disagrees with the advertised descriptor", async () => {
    const overclaimed = { ...preview, negotiation: { ...negotiation, selected: [...negotiation.selected, "index.graph"], degradations: [] } };
    const callTool = stub({ preview: overclaimed });
    await expect(new FortemiDatasetExecutionClient({ callTool }).execute(request, receipt.requestDigest))
      .rejects.toThrow("CONFORMANCE_FORTEMI_CAPABILITY_DECISION_MISMATCH");
    expect(actions(callTool)).not.toContain("execute");
  });

  it("rejects a reported runtime that does not match the advertised descriptor", async () => {
    const swapped = { ...preview, negotiation: { ...negotiation, runtime: { ...descriptor.runtime, maturity: "stable" } } };
    const callTool = stub({ preview: swapped });
    await expect(new FortemiDatasetExecutionClient({ callTool }).preview(request)).rejects.toThrow("CONFORMANCE_FORTEMI_CAPABILITY_DECISION_MISMATCH");
    expect(actions(callTool)).not.toContain("execute");
  });

  it("rejects a receipt whose capability decision restates more than the negotiation allowed", async () => {
    const forged = structuredClone(receipt);
    forged.capabilityDecision.degradations = [];
    const callTool = stub({ execute: { state: receipt.state, verification: receipt.verification, receipt: forged } });
    await expect(new FortemiDatasetExecutionClient({ callTool }).execute(request, receipt.requestDigest))
      .rejects.toThrow(/CONFORMANCE_FORTEMI_(RECEIPT_INVALID|CAPABILITY_DECISION_MISMATCH)/);
  });
});
