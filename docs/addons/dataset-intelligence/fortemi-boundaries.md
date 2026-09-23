# AIWG and Fortemi boundaries

| Layer | Authority | Persistence claim | Recovery |
|---|---|---|---|
| AIWG Dataset Intelligence | canonical source/revision, policy, plan, approval, ledger and receipts | control authority in governed AIWG artifacts | verify ledger and source revision |
| Fortemi Core | execution/search integration and static projections when negotiated | regenerable cache/index, not canonical storage | rebuild from canonical source and receipts |
| Fortemi Server | only capabilities proven by a live negotiated contract and receipt | do not claim durable persistence from package presence | follow the server capability’s documented recovery |
| Local compatibility projection | bounded legacy/portable view | explicitly lossy or regenerable | retain canonical ledger and loss report |

The static v1/v2 export contract is documented in [Fortemi index
export](../../integrations/fortemi-index-export.md). A successful Fortemi
query proves neither source availability nor provenance. The Fortemi search
projection is not provenance, and relationships without evidence require a
separate evidence-bearing conversion.

A negotiated contract means the advertised capability descriptor, not the
server's own claim about it. AIWG validates that descriptor before any preview
or execute call, negotiates the request against it independently, and refuses a
reported decision the descriptor does not support; the run receipt's capability
decision is bound to the same independent negotiation. The wire rules come from
Fortemi Core capability-validation 1.0.1, pinned with its shared vectors under
`schemas/dataset/fortemi-capability-validation/1.0.1/` and reimplemented rather
than imported.

The checked-in matrix reports Fortemi Core parity pending until a compatible
dependency is pinned. Live Fortemi Server persistence is separately pending
explicit authorization and a cross-repository receipt. Never infer live Server
support from a schema, adapter manifest, static shard, or local package
installation.
