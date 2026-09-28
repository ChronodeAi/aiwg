# Decision DMN and OPA Interoperability Profile

AIWG exposes deterministic decision interoperability through `decision-interop.aiwg.io/v1`. The profile is dry-run by
default: import/export builds a normalized `DecisionRuleset` plus provenance, warnings, source digests,
parser/profile versions, and a round-trip status. It never activates or mutates an active ruleset; activation still
requires the ordinary reviewed artifact publish path.

The DMN side targets OMG DMN 1.6 using the `https://www.omg.org/spec/DMN/20240513/MODEL/` namespace. The
supported subset is one `definitions` document with one executable `decisionTable`, optional local acyclic
`informationRequirement` links to external evidence-producing decisions, JSON-pointer `inputExpression` text under the
AIWG JSON-pointer expression language, named outputs, ordered rules, and unary tests limited to dash, literals,
equality, inequality, and scalar comparisons. Supported hit policies are `UNIQUE`, `ANY`, `FIRST`, `RULE ORDER`, and
`COLLECT`; `COLLECT` supports list, sum, min, max, and count. `FIRST`, `RULE ORDER`, and `COLLECT` require explicit
`aiwg:order`, so imported behavior is declared rather than inferred from incidental file order.
`aiwg:conflict="defer-on-conflict"` is an AIWG extension and is not represented as standard DMN.

A DMN `informationRequirement` is executable only when it can be represented as external AIWG evidence. The importer
walks local required-decision references, rejects cycles and executable dependency decisions, and requires the caller to
supply exact `ArtifactPin` values for every external dependency. XML never supplies that authority. The normalized
ruleset includes decision-source predicates for those aliases, so missing, review-only, or failed dependency evidence
routes to review. Exported DMN retains canonical required-decision links, and re-import requires the same
caller-supplied pins.

Unsupported DMN and FEEL constructs fail before activation. The importer rejects arbitrary FEEL expressions, scripts,
literal-expression execution, extension execution, imports, remote references, DTDs, entities, XInclude, namespace
confusion, ambiguous order, cyclic dependency graphs, unpinned dependency evidence, cyclic/recursive expansion surfaces,
oversized inputs, and unsupported table shapes. XML parsing is bounded by byte, element, depth, rule, input, output, and
text limits.

OPA interoperability is a profile for exchange boundaries, not a Rego compiler or OPA server. AIWG maps reviewed
structured input/evidence projections, deterministic result, bundle name/revision/digest in OPA's object-shaped
`bundles` map, `decision_id`, trace/span correlation, metrics, revision lineage, and a separate enforcement contract.
Decision-log input export is default-deny: caller input fields are omitted unless an explicit reviewed JSON-pointer
projection allowlist is supplied, and projected values still pass through key and value redaction. Imported OPA
envelopes cannot select providers, credentials, egress policy, models, calibration records, executors, backends,
acceptance policy, or action authorization; those remain independently authorized by the AIWG contract.

DMN and OPA decisions do not calibrate probabilistic evidence. Model outputs enter the profile only as typed evidence
with explicit status and uncertainty fields. Missing, unknown, abstained, unsupported, error, review, and canceled
evidence cannot become a permissive boolean match: unsuccessful evidence routes to review, and missing predicates remain
non-matches rather than false approvals.

Primary compatibility references used for this profile are OMG DMN 1.6 (`https://www.omg.org/spec/DMN/1.6`) and OPA
management documentation for bundles (`https://www.openpolicyagent.org/docs/management-bundles`) and decision logs
(`https://www.openpolicyagent.org/docs/management-decision-logs`). The machine-readable profile is packaged at
`src/decision/interop-profile.v1.json`; schemas are packaged under
`schemas/decision/DecisionInteropMapping.v1.schema.json` and
`schemas/decision/OpaDecisionLogExport.v1.schema.json`. Example DMN and OPA fixtures are under
`agentic/code/addons/decision-engine/examples/interop/`.
