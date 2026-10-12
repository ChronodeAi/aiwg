# Governed discovery evaluator bridge

`DiscoveryShadowEvaluator` implements `DiscoveryShadowHost` through the existing
`evaluateDecisionRuleset` runtime. Construct it from trusted host configuration,
then pass the instance to `DiscoveryShadowRoute` as its host. The focused test
`test/unit/artifacts/discovery-shadow-evaluator.test.ts` provides an executable,
offline configuration using the real Jev adapter with an injected fake transport.

The host supplies a pinned Choice definition, single-evaluation ruleset, binding,
D10 projection policy, existing D02 scheduler with estimates, registered calibration
artifact, adapters, credential resolver, protected receipt store and metadata receipt
sink. The bridge snapshots JSON configuration at construction. Query text and
candidate descriptions enter only the bounded input schema and must retain
`untrusted` projection trust. They cannot choose the provider, credential, model,
projection policy or answer domain.

The supported answer domain is a fixed sequence `candidate_0` through
`candidate_N`, followed by `none`. Candidate cardinalities that differ from the
pinned definition fail closed. Supporting another cardinality requires another
host-owned profile and its corresponding calibration. The binding must use a
single target, no retries or fallback, and deadlines within the shadow budget.
The runtime enforces D10 before resolving credentials or calling transport and
uses its existing admission controls. Workspace, principal and provider budgets
are narrowed to the observer limits before dispatch, and unknown estimated cost
is denied even if the broader host policy allows it. No action executor is installed.

`invocationScope` identifies the host's replay scope. An identical bounded input
and immutable profile in that scope derive the same invocation ID and replay the
protected terminal receipt. A changed scope deliberately permits a new invocation.
The receipt digest returned to the route covers the durable runtime receipt;
project access, receipt storage integrity and retention remain host responsibilities.
Admission callback behavior belongs to the trusted host and must be versioned
through its scheduler profile when changed.

The tests establish integration and failure behavior, not empirical discovery
quality. The native Jev adapter currently reports unknown monetary cost. The
bridge preserves that unknown value; a real route therefore records a budget
breach and disables itself even when the fake transport returns an accepted
answer. This implementation does not provide provider pricing, an approved live
calibration corpus, latency/quality qualification, or permission to enable routing.
Issue #2621 remains open for those external qualification requirements.

Import the bridge and observer from the installed package:

```typescript
import { DiscoveryShadowEvaluator, DiscoveryShadowRoute } from 'aiwg/discovery/shadow';

// trustedConfig contains the reviewed pins and host services described above.
const host = new DiscoveryShadowEvaluator(trustedConfig);
const route = new DiscoveryShadowRoute(trustedConfig.shadowPolicy, host);
await route.observe(query, authorizedCandidates);
```
