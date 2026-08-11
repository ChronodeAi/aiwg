---
id: pm-os-runtime
name: PMOS Runtime Safety and Resolution
enforcement: high
severity: HIGH
tier: addon
description: Resolve PMOS resources from the addon root and preserve confirmation gates for writes, external systems, hooks, and upgrades.
---

# PMOS Runtime Rule

Treat the directory containing `manifest.json` as the PMOS addon root. Resolve PMOS references through its `skills/`, `agents/`, `registry/`, `knowledge/`, `templates/`, `examples/`, `bin/`, `docs/`, and `references/` subtrees; do not assume the original standalone `plugins/pm-os` repository layout exists.

Before writing or moving project artifacts, sending feedback or testimonials, changing memory or project state, enabling hooks, connecting an MCP server, or running upgrade tooling, show the intended target and obtain the confirmation required by the selected PMOS skill. Never infer authorization from discovery or addon deployment.

The files in `hooks/` and `.mcp.json` are packaged provider sources, not proof that hooks or external services are installed, authenticated, enabled, or reachable. Report those states separately. A Codex deployment is valid only when its dry run reports exactly 26 PMOS command adapters, one `pm-os-quickref` kernel skill, and `pruned=0`; refuse the live deployment on any zero count, mismatch, collision, or prune plan.
