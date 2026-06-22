---
namespace: ring-governance
name: governance-corpus-inventory
platforms: [all]
description: Inventory the live AIWG workspace in the invocation cwd, or an explicitly supplied corpus, for reusable governance-boundary patterns.
triggers:
  - governance corpus inventory
  - inventory governance patterns
  - mine governance corpus
  - archive governance baseline
  - migration inventory for governance addon
---

# Governance Corpus Inventory

Use this skill to inspect the live AIWG workspace in the invocation cwd for reusable
governance-boundary patterns. An external repository, archived workspace, or evidence corpus is
in scope only when the user explicitly supplies it.

## Inputs

- Current workspace `.aiwg/` tree by default.
- Optional target corpus path or repository root.
- Optional baseline report path.
- Optional focus areas such as evaluator boundaries, memory boundaries, evolution loops, or
  promotion gates.

If no path is provided, start from the `.aiwg/` tree in the current working directory, then inspect
adjacent project files only when they are needed to explain a governance artifact. If a path points
outside the current workspace, confirm it is intentional and keep the analysis read-only.

## Governance Corpus Definition

Treat the governance corpus as the project-local artifacts that define, constrain, judge, or record
agentic work. In an AIWG workspace, inventory these first when present:

- `.aiwg/AIWG.md`, project context files, workspace manifests, and active framework/addon records.
- `.aiwg/architecture/`, ADRs, decision records, design notes, and constraint docs.
- `.aiwg/audits/`, `.aiwg/reports/`, `.aiwg/evals/`, `.aiwg/tests/`, and review outputs.
- `.aiwg/rules/`, `.aiwg/extensions/`, `.aiwg/addons/`, `.aiwg/frameworks/`, and project-local
  bundles.
- Issue, gate, acceptance, rubric, checklist, promotion, release, and provenance artifacts under
  `.aiwg/` or linked from `.aiwg/AIWG.md`.
- Provider bridges such as `AGENTS.md`, `AIWG.md`, `CLAUDE.md`, `WARP.md`, and equivalent files only
  as routing/context surfaces, not as proof authority.

If the workspace lacks `.aiwg/`, use the explicitly supplied corpus root and classify any comparable
policy, evaluation, architecture, audit, issue, or provenance artifacts as candidate governance
corpus.

## Inventory Procedure

1. Locate the active corpus root: default to `${cwd}/.aiwg`; otherwise use the user-supplied path.
2. Build an artifact inventory grouped by role: context, policy/rule, evaluator, criteria/rubric,
   test/eval, audit/report, memory/provenance, workflow/gate, adapter/evolution, and provider bridge.
3. For each artifact, identify who can edit it, who relies on it, and whether it can affect its own
   evaluation or promotion path.
4. Mark protected surfaces: evaluator code/config, criteria, rubrics, benchmark data, policies,
   promotion gates, issue-closing rules, memory verdict rules, and deployment hooks.
5. Trace producer-to-verdict flow: proposal source, execution path, evidence collection, judgement,
   promotion, rollback, and audit log.
6. Flag governance smells: self-grading, editable evaluator, mutable criteria, memory-as-proof,
   policy widening, hidden promotion path, unverifiable audit trail, and evolution adapter ownership
   overlap.
7. Assign a disposition and cite evidence paths. Do not promote a pattern into addon content unless it
   is reusable without private project names, private paths, or local runtime state.

## Mining Categories

- Producer/grader separation.
- Protected evaluator, criteria, rubric, policy, corpus, and promotion path.
- Memory, retrieval, provenance, and semantic-context boundaries.
- Optimizer, search, evolution, or adapter boundaries.
- Audit, event, log, and proof-authority surfaces.
- Tests or reviews for reward hacking, self-grading, policy widening, benchmark rewrite, and
  governance bypass.
- Archive, discard, defer, and migration candidates.

## Dispositions

Use exactly these labels:

- `migrate-candidate`
- `reference-only`
- `defer`
- `archive-only`
- `discard-candidate`

## Constraints

- Do not copy source code between projects.
- Do not mutate the inspected corpus unless the user explicitly asks for edits.
- Do not treat reports, memory, generated summaries, or runtime state as proof authority.
- Prefer evidence-backed inventory over broad summary.
- Keep private or project-specific findings out of reusable addon artifacts unless they have been
  generalized.

## Output

Produce a concise table with artifact, disposition, evidence path, rationale, and the reusable
governance pattern it supports. Call out any findings that should remain private archive notes
rather than addon content.
