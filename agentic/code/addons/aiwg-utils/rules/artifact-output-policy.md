---
name: artifact-output-policy
description: Preserve canonical AIWG artifacts and require policy-authorized opt-in for provider-native presentation destinations
enforcement: high
scope: artifact-producing-workflows
activation: kernel
---

# Artifact Output Policy

Before any durable AIWG plan/review/report/SDLC artifact, MUST resolve `.aiwg/aiwg.config` `artifact_outputs`:

- Write the canonical artifact to the configured AIWG artifact store first as the unambiguous source of truth. Never substitute, relocate, or omit it because of provider defaults.
- Treat provider-native destinations as derived exports. Defaults: `canonical: aiwg`, `provider_native: explicit-only`. Only explicit task selection may choose an enabled supported destination; user/provider defaults cannot silently select one.
- When both outputs are selected, record presentation reference, canonical path, authority, and timestamp in artifact-output provenance.
- Unknown/unsupported destinations MUST fail safe with a clear diagnostic. Report honestly when the provider acts above AIWG's controllable prompt/tool boundary.
- Project policy is the ceiling; within it, explicit task selection outranks user preferences and provider defaults. Higher-authority safety, privacy, and project data boundaries always apply.

Supporting rationale and examples: [artifact-output-policy-guidance](./artifact-output-policy-guidance.md) (`aiwg show rule artifact-output-policy-guidance --body`, on-demand).
