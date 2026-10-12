import { readFileSync } from "node:fs";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { fortemiPinnedSchemaPath } from "./fortemi-schema-path.js";

/**
 * Independent AIWG implementation of the Fortemi dataset capability wire rules
 * (Fortemi/fortemi-react#422 validation revision 1.0.1). AIWG pins the authority
 * schema and vectors but never imports the producer's validator, so agreement is
 * established by shared vectors rather than by shared code.
 */
export const FORTEMI_CAPABILITY_CONTRACT = "fortemi.dataset-execution-capabilities/v1";
export const FORTEMI_CAPABILITY_SCHEMA_MAJOR = 1;

export interface FortemiCapabilityDeclaration {
  id: string;
  version: string;
  status: "supported" | "experimental" | "unsupported";
  limits?: Record<string, number>;
  evidence: string[];
}

export interface FortemiCapabilityDescriptor {
  contract: string;
  schemaVersion: string;
  runtime: { id: string; version: string; plane: string; dataClass: string; maturity: string };
  guarantees: Record<string, string>;
  capabilities: FortemiCapabilityDeclaration[];
  evidence: Array<{ id: string; kind: string; uri: string; digest?: string }>;
}

export interface FortemiCapabilityRequirement {
  id: string;
  minimumVersion?: string;
  minimumLimits?: Record<string, number>;
  fallback?: string[];
}

export interface FortemiCapabilityRequest {
  contract: string;
  required: FortemiCapabilityRequirement[];
  optional?: FortemiCapabilityRequirement[];
}

export interface FortemiCapabilityDegradation {
  requested: string;
  selected?: string;
  reason: "unsupported" | "version-insufficient" | "limit-insufficient";
  changedGuarantees: string[];
}

export interface FortemiCapabilityDecision {
  accepted: boolean;
  selected: string[];
  degradations: FortemiCapabilityDegradation[];
  diagnostics: string[];
}

const schema = JSON.parse(readFileSync(
  fortemiPinnedSchemaPath("schemas/dataset/fortemi-capability-validation/1.0.1/capability.schema.json"),
  "utf8",
)) as {
  $id: string;
  $defs: { semver: { pattern: string; maxLength: number }; capabilityId: { enum: string[] } };
};

const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addSchema(schema);
const descriptorStructure = ajv.compile({ $ref: `${schema.$id}#/$defs/descriptor` }) as ValidateFunction<FortemiCapabilityDescriptor>;
const requestStructure = ajv.compile({ $ref: `${schema.$id}#/$defs/request` }) as ValidateFunction<FortemiCapabilityRequest>;
const versionPattern = new RegExp(schema.$defs.semver.pattern);
const CAPABILITY_IDS = new Set(schema.$defs.capabilityId.enum);
const LIMIT_KEYS = ["maxInputBytes", "maxRecordBytes", "maxBatchRecords", "maxConcurrency", "maxPageSize", "maxTraversalDepth"] as const;
const REQUIRED_TOGETHER: Array<[string, string[]]> = [
  ["ingest.incremental", ["identity.stable-revision", "checkpoint.read", "checkpoint.write"]],
  ["lineage.field", ["lineage.relationship-evidence"]],
  ["mutation.reconcile", ["mutation.upsert", "mutation.tombstone"]],
  ["index.hybrid", ["index.lexical", "index.vector"]],
];

function parseVersion(value: unknown): { core: number[]; prerelease: string[] } | null {
  if (typeof value !== "string" || value.length > schema.$defs.semver.maxLength) return null;
  const match = versionPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, prerelease: match[4]?.split(".") ?? [] };
}

/** SemVer 2.0.0 precedence; build metadata is ignored. `null` means unparseable. */
export function compareFortemiCapabilityVersions(left: unknown, right: unknown): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    // Numeric prerelease identifiers can exceed Number's exact integer range.
    if (leftNumeric && leftPart.length !== rightPart.length) return leftPart.length > rightPart.length ? 1 : -1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function majorVersion(value: string): number | null {
  const parsed = parseVersion(value);
  return parsed && parsed.prerelease.length === 0 ? parsed.core[0] : null;
}

function supported(capability: FortemiCapabilityDeclaration | undefined): capability is FortemiCapabilityDeclaration {
  return capability !== undefined && (capability.status === "supported" || capability.status === "experimental");
}

/** Structural and semantic validation of an advertised capability descriptor. */
export function validateFortemiCapabilityDescriptor(descriptor: unknown): string[] {
  if (!descriptorStructure(descriptor)) {
    const contract = (descriptor as { contract?: unknown } | null)?.contract;
    return contract !== undefined && contract !== FORTEMI_CAPABILITY_CONTRACT
      ? ["CONTRACT_MAJOR_UNSUPPORTED:/contract"]
      : ["DESCRIPTOR_INVALID:/structure"];
  }
  const diagnostics: string[] = [];
  if (descriptor.contract !== FORTEMI_CAPABILITY_CONTRACT) diagnostics.push("CONTRACT_MAJOR_UNSUPPORTED:/contract");
  if (majorVersion(descriptor.schemaVersion) !== FORTEMI_CAPABILITY_SCHEMA_MAJOR) diagnostics.push("SCHEMA_VERSION_UNSUPPORTED:/schemaVersion");
  if (!parseVersion(descriptor.runtime.version)) diagnostics.push("DESCRIPTOR_INVALID:/runtime/version");
  const declared = new Map<string, FortemiCapabilityDeclaration>();
  descriptor.capabilities.forEach((capability, index) => {
    if (!CAPABILITY_IDS.has(capability.id) || !parseVersion(capability.version)) {
      diagnostics.push(`DESCRIPTOR_INVALID:/capabilities/${index}`);
      return;
    }
    if (declared.has(capability.id)) diagnostics.push(`CAPABILITY_DUPLICATE:/capabilities/${index}/id`);
    declared.set(capability.id, capability);
    for (const key of LIMIT_KEYS) {
      const value = capability.limits?.[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        diagnostics.push(`DESCRIPTOR_INVALID:/capabilities/${index}/limits/${key}`);
      }
    }
    if (capability.status !== "unsupported" && capability.evidence.length === 0) {
      diagnostics.push(`DESCRIPTOR_INVALID:/capabilities/${index}/evidence`);
    }
    for (const evidenceId of capability.evidence) {
      if (!descriptor.evidence.some(entry => entry.id === evidenceId)) {
        diagnostics.push(`DESCRIPTOR_INVALID:/capabilities/${index}/evidence`);
      }
    }
  });
  for (const [source, requirements] of REQUIRED_TOGETHER) {
    if (!supported(declared.get(source))) continue;
    for (const requirement of requirements) {
      if (!supported(declared.get(requirement))) diagnostics.push(`CAPABILITY_INCONSISTENT:${source}`);
    }
  }
  if (descriptor.guarantees.transaction === "atomic-batch" && !supported(declared.get("transaction.atomic-batch"))) {
    diagnostics.push("CAPABILITY_INCONSISTENT:transaction.atomic-batch");
  }
  if (descriptor.runtime.plane === "static-cache" && descriptor.runtime.dataClass !== "static-cache") {
    diagnostics.push("CAPABILITY_INCONSISTENT:/runtime/dataClass");
  }
  if (descriptor.runtime.plane === "live-remote-persistence" && descriptor.runtime.maturity === "stable"
    && !descriptor.evidence.some(entry => entry.kind === "live-qualification")) {
    diagnostics.push("CAPABILITY_INCONSISTENT:/runtime/maturity");
  }
  return diagnostics;
}

/** Structural and semantic validation of a negotiation request AIWG is about to send. */
export function validateFortemiCapabilityRequest(request: unknown): string[] {
  if (!requestStructure(request)) {
    const contract = (request as { contract?: unknown } | null)?.contract;
    return contract !== undefined && contract !== FORTEMI_CAPABILITY_CONTRACT
      ? ["CONTRACT_MAJOR_UNSUPPORTED:/request/contract"]
      : ["REQUEST_SCHEMA_INVALID:/request"];
  }
  const diagnostics: string[] = [];
  for (const [group, requirements] of [["required", request.required], ["optional", request.optional ?? []]] as const) {
    requirements.forEach((requirement, index) => {
      if (requirement.minimumVersion !== undefined && !parseVersion(requirement.minimumVersion)) {
        diagnostics.push(`DESCRIPTOR_INVALID:/request/${group}/${index}/minimumVersion`);
      }
    });
  }
  return diagnostics;
}

function assess(
  requirement: FortemiCapabilityRequirement,
  declared: Map<string, FortemiCapabilityDeclaration>,
): { ok: boolean; reason?: FortemiCapabilityDegradation["reason"]; diagnostic?: string } {
  const capability = declared.get(requirement.id);
  if (!supported(capability)) return { ok: false, reason: "unsupported", diagnostic: `REQUIRED_CAPABILITY_MISSING:${requirement.id}` };
  if (requirement.minimumVersion !== undefined) {
    const comparison = compareFortemiCapabilityVersions(capability.version, requirement.minimumVersion);
    if (comparison === null || comparison < 0) {
      return { ok: false, reason: "version-insufficient", diagnostic: `CAPABILITY_VERSION_INSUFFICIENT:${requirement.id}` };
    }
  }
  for (const key of LIMIT_KEYS) {
    const required = requirement.minimumLimits?.[key];
    if (required !== undefined && (capability.limits?.[key] ?? -1) < required) {
      return { ok: false, reason: "limit-insufficient", diagnostic: `CAPABILITY_LIMIT_INSUFFICIENT:${requirement.id}/${key}` };
    }
  }
  return { ok: true };
}

/**
 * Pure negotiation of a request against an advertised descriptor. Performs no
 * I/O and mutates neither input, so a caller can compare the result with the
 * decision a server reports for the same pair.
 */
export function negotiateFortemiCapabilities(descriptor: unknown, request: unknown): FortemiCapabilityDecision {
  const diagnostics = [...validateFortemiCapabilityDescriptor(descriptor), ...validateFortemiCapabilityRequest(request)];
  const selected: string[] = [];
  const degradations: FortemiCapabilityDegradation[] = [];
  if (diagnostics.length) return { accepted: false, selected, degradations, diagnostics };
  const typed = descriptor as FortemiCapabilityDescriptor;
  const negotiation = request as FortemiCapabilityRequest;
  const declared = new Map(typed.capabilities.map(capability => [capability.id, capability]));
  for (const requirement of negotiation.required) {
    const assessment = assess(requirement, declared);
    if (assessment.ok) selected.push(requirement.id);
    else diagnostics.push(assessment.diagnostic!);
  }
  for (const requirement of negotiation.optional ?? []) {
    const assessment = assess(requirement, declared);
    if (assessment.ok) {
      selected.push(requirement.id);
      continue;
    }
    const fallback = requirement.fallback?.find(id => supported(declared.get(id)));
    if (fallback) selected.push(fallback);
    degradations.push({
      requested: requirement.id,
      ...(fallback ? { selected: fallback } : {}),
      reason: assessment.reason!,
      changedGuarantees: [fallback ? `${requirement.id} replaced by ${fallback}` : `${requirement.id} omitted`],
    });
  }
  return { accepted: diagnostics.length === 0, selected: [...new Set(selected)], degradations, diagnostics };
}
