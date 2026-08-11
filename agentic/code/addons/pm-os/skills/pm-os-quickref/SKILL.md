---
name: pm-os-quickref
namespace: pm-os
platforms: [all]
kernel: true
description: AUTO-INVOKE for PMOS product or project management work, PMOS capability discovery, workflow selection, PM artifacts, product strategy, research, prioritization, stakeholder work, measurement, or when the correct PMOS skill is unclear.
triggers:
  - "what can PMOS do"
  - "which PMOS skill should I use"
  - "product management workflow"
  - "project management artifact"
---

# PMOS — Quick Reference

PMOS packages 230 focused source skills. Do not enumerate or guess them from memory. Route through AIWG's local index, then fetch the selected artifact.

## Canonical route

```bash
aiwg discover "PMOS <the user's goal>" --backend local --limit 5
aiwg show skill <selected-name> --backend local
```

If the result is an agent, rule, or template, replace `skill` with that artifact type. Surface the best match and, when the top choices represent meaningfully different approaches, at most two alternatives.

## Useful discovery phrases

```bash
aiwg discover "PMOS onboarding and context setup" --backend local --limit 5
aiwg discover "PMOS product strategy workflow" --backend local --limit 5
aiwg discover "PMOS opportunity and assumptions" --backend local --limit 5
aiwg discover "PMOS research synthesis" --backend local --limit 5
aiwg discover "PMOS PRD requirements" --backend local --limit 5
aiwg discover "PMOS stakeholder meeting" --backend local --limit 5
aiwg discover "PMOS measurement and prioritization" --backend local --limit 5
aiwg discover "PMOS skill browser" --backend local --limit 5
```

Use `pm-os-start` for onboarding, `pm-help` for the guided tour, `pm-status` for current project orientation, and `skill-browser` for the complete visual catalog when those are already available in context.

## Runtime boundary

Treat the bundle directory as the PMOS addon root. Resolve `skills/`, `agents/`, `registry/`, `knowledge/`, `templates/`, `examples/`, `bin/`, and `docs/` from that root. Follow `pm-os-runtime` before any write, external send, MCP connection, hook activation, or upgrade action.

If `aiwg show` fails in the installed CLI, use the absolute artifact path returned by `aiwg discover` as a temporary read-only fallback and report the CLI failure; do not search provider deployment directories.
