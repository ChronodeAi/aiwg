---
name: vibe-code-leaf-finder
description: >-
  Use when someone wants to know where in a codebase AI can write freely —
  a repo, package or directory in, every file classified LEAF (vibe it),
  BRANCH (guardrails) or TRUNK (human writes it) out, with stress tests
  per leaf. Fires on "vibe-code audit", "leaf finder", "where can I let
  Claude loose", "which files are safe to rewrite". Not for shaping an
  engineering approach with the team (`eng-shape`), writing up a technical
  architecture decision (`tech-arch-brief`), or getting oriented in an
  unfamiliar technical domain (`tech-sensemaking`).
---

# Classify every file by risk-to-modify-with-AI

Erik Schluntz's framing from "Vibe coding in prod" (Anthropic, 2025): tech debt is acceptable in **leaf** nodes because nothing depends on them, while **trunks** and **branches** are core architecture that must be protected, deeply understood, extensible, and flexible. Full quotes and rationale: `references/schluntz-framework.md`.

This answers exactly one question — where is it safe to let AI write code without human review of every line. Run the four checks below against the target scope; if no scope is given, ask once: *"Scope this to a directory, a package, or the whole repo?"*

Every classification rests on evidence from `rg` and `git log` actually run. A hallucinated classification destroys the report's whole value.

## Step 1 — Dependency check (outward edges)

For each file in scope, find every reference from outside the file — and outside the scope directory, if scoped. Use ripgrep. Search import statements (`from <module>`, `import <module>`, `require('<path>')`), exported class and function names, and string references in dynamic imports, module registries and route tables.

External imports from outside the scope still count: zero references *within* the scope proves nothing.

Done when every file in scope has a list of external referrers, and files with zero referrers are marked as leaf candidates.

## Step 2 — Isolation check (inward edges)

Confirm each leaf candidate is a pure consumer, not a provider. Check whether it registers anything globally (plugins, middleware, migrations, event handlers, cron jobs), writes to shared state (singletons, global config, shared DB schema), or exposes a public surface (HTTP routes, SDK exports, CLI commands).

A file with zero importers that registers a middleware or a route is a hidden trunk — classify it **BRANCH**.

Done when every leaf candidate is confirmed as a pure consumer or downgraded.

## Step 3 — Stability check (time axis)

```bash
git log --follow --oneline --since="12 months ago" -- <file>
git log --follow --stat -- <file> | head -40
```

A true end-feature leaf shows low commit frequency after creation, commits that are bugfixes or copy changes rather than structural refactors, no `TODO`/`FIXME`/`HACK` pointing at future expansion, and no recent PR building on top of it. A hidden trunk shows high churn, frequent "refactor"/"extract"/"split" commits, and comments like "temporary" or "will move".

Run this on every candidate — a file with zero deps today but 40 commits last quarter is a trunk mid-extraction.

Done when every remaining candidate has 12 months of git history read and a churn verdict recorded.

## Step 4 — Testability check (verification axis)

The Schluntz test: can you verify this works without reading the implementation? For each candidate, answer whether it has clear observable inputs and outputs (HTTP request → response, CLI args → stdout, form input → rendered DOM), whether an end-to-end test could exercise it from outside, and whether a non-engineer could verify the behavior by using the product.

Any no downgrades it to **BRANCH**.

Done when every candidate has all three answers recorded.

## Step 5 — Classify and report

| Class | Definition | AI strategy |
|---|---|---|
| **LEAF** | Zero external deps, no registrations, stable history, externally verifiable | Vibe code freely. Claude writes, human runs tests, ships. |
| **BRANCH** | Leaf-like but with 1-2 of: light external refs, some registrations, moderate churn | AI drafts, human reviews structural decisions only. |
| **TRUNK** | Imported by many files, registers globally, high churn, or no external test surface | Human writes every line. AI may suggest. |

Fixed rulings: generated code (protobuf, GraphQL schemas, migrations) is always TRUNK — flag and skip. Config files (`.env`, `config.yaml`, infra-as-code) are always TRUNK. Test files are leaves by definition; report them separately as test-coverage context rather than classifying them. A monorepo scope crossing package boundaries gets one report per package. An empty or single-file repo returns: "Not enough structure to classify."

Judge each file on its actual dependencies, never on its filename — `utils.py` is not automatically a trunk.

For each LEAF, propose at least 3 end-to-end stress tests (one happy path, two failure modes), each writable from outside without reading the implementation.

Done when every file in scope carries a class with one-line reasoning, and every LEAF has 3+ outside-in stress tests.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write `{project_path}/YYMMDD-leaf-report.md` with the Write tool, following `assets/LEAF_REPORT_TEMPLATE.md`. Never hand-build the path.

The report holds: the full classification table; a **Safe to Vibe** section listing LEAF files with their stress tests; a **Hands Off** section listing TRUNK files with the blocking reason (who imports them, what they register, what churns); and a **Caution** section listing BRANCH files with the specific guardrail each needs.

For a non-technical reader (PM, founder), open with a plain-English line: "You can safely ask Claude to edit these N files. Do not let Claude touch these M files without an engineer present."
