---
name: prd-draft
description: >-
  Use when structured requirements need to become a full PRD in one pass —
  the format picked from the `templates/` library by stage, audience and
  detail level, every section filled, and every assumption you had to make
  listed as a follow-up question instead of buried. Covers enterprise scope
  (security, compliance, performance, technical requirements) when the
  product is regulated or enterprise-sold. Also /prd Step 6, assembling
  Steps 1–5 into the draft. Not for the full multi-step PRD pipeline with
  reviewers (`prd`), a market-level requirements document (`mrd`), a
  working-backwards launch announcement (`press-release`), or the technical
  architecture brief that follows the PRD (`tech-arch-brief`).
---

# Draft a PRD from structured requirements

A PRD fails in one of two ways: it leaves designers and engineers guessing, or it invents certainty it doesn't have. This skill closes the first gap by filling every section of a real format, and the second by making every assumption visible instead of confident.

Inside `/prd` this is Step 6, assembling the use cases, stories and acceptance criteria from Steps 1–5. Standalone, gather whatever requirements already exist.

## Step 1 — Pick the format

Read `templates/README.md`. Ask the user three diagnostic questions — what stage the work is at, who the audience is, and how much detail the document has to carry — then present the 1–2 formats whose metadata matches and let them pick.

If the product is regulated or enterprise-sold, say so and extend the picked format with the four enterprise sections: Security Requirements, Compliance Requirements, Performance Requirements, Technical Requirements.

Done when the user has picked one named file from `templates/` and the enterprise extension is either applied or explicitly ruled out.

## Step 2 — Calibrate on an example

Offer: "Want to see what high-quality PRD writing looks like before we start — not for the format, but to calibrate the level of evidence, specificity of outcomes, and clarity of language expected?" If yes, read `examples/README.md` and let the user pick one to review.

Done when the user has either reviewed an example or declined the offer.

## Step 3 — Fill every section

Work the picked template section by section, starting from what the user actually provided and expanding it. Each section is finished when a designer or engineer could act on it without asking a follow-up: the problem names the user pain and the business opportunity, goals carry numbers, non-goals say what's out and why, key flows and key logic are step-by-step, and the launch plan has phases with dates.

Write for both technical and non-technical readers. Where you had to reach beyond what the user gave you, mark the sentence as an assumption rather than asserting it.

Done when every section of the picked template has content and no section is a placeholder.

## Step 4 — Surface what you assumed

List the assumptions you made and the information that would materially change the document, as follow-up questions at the end. Rank them: the ones that would change the solution first, the ones that would change a detail last.

Done when every assumption marked in Step 3 appears as a follow-up question, ranked by how much its answer would move the document.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-prd-{feature-slug}.md`. Never hand-build the path.

The doc holds: the PRD in the picked template's structure, and the ranked follow-up questions.
