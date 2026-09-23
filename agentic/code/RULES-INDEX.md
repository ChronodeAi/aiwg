# AIWG Rules Index

Global rule index assembled from all installed AIWG components.
Scan component indexes to find relevant rules; load the full rule file via @-link when needed.

---

## Installed Components

| Component | Type | Rules | Index |
|-----------|------|-------|-------|
| sdlc-complete | framework | 32 | @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/RULES-INDEX.md |
| aiwg-utils | addon (core) | 14 | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/RULES-INDEX.md |

**Total**: 46 rules across 2 components

---

## Quick Reference by Context

Combined context table across all components. Use to identify which component index to consult.

| Task Type | Component | Key Rules |
|-----------|-----------|-----------|
| **Writing code** | sdlc-complete | no-attribution, executable-feedback, anti-laziness, code-shape |
| **Running tests** | sdlc-complete | executable-feedback, anti-laziness, reproducibility |
| **Creating artifacts** | sdlc-complete | mention-wiring, provenance-tracking, qualified-references, artifact-discovery |
| **Phase transitions** | sdlc-complete | hitl-gates, sdlc-orchestration, human-gate-display |
| **Agent loops** | sdlc-complete | tao-loop, actionable-feedback, best-output-selection |
| **Agent design** | sdlc-complete | few-shot-examples, conversable-agent-interface, agent-fallback |
| **Documentation** | sdlc-complete | citation-policy, reasoning-sections, research-metadata |
| **Security review** | sdlc-complete | token-security, failure-mitigation |
| **Versioning/release** | sdlc-complete | versioning, no-attribution |
| **Research** | sdlc-complete | research-metadata, index-generation, citation-policy |
| **Delegating to subagents** | aiwg-utils | subagent-scoping, context-budget, instruction-comprehension |
| **Interactive commands** | aiwg-utils | native-ux-tools, instruction-comprehension |
| **Agent deployment** | aiwg-utils | agent-deployment |
| **Diagrams** | aiwg-utils | diagram-generation |
| **Research/decisions** | aiwg-utils | research-before-decision |
| **Estimation and planning** | aiwg-utils | no-time-estimates, vague-discretion, subagent-scoping |

---

*Assembled from 2 component indexes — 46 rules total*
*Each component index contains full rule summaries with @-links to complete rule files*
