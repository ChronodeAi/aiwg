---
title: "AIWG - September 2026 Report"
slug: "2026-9-aiwg-september-2026-report"
date: "2026-10-13"
project: "AIWG"
type: report
tags: [report, "2026-09", aiwg]
summary: "September brought more provider choices, a shared alpha contract for decisions, and civic workflows that keep sources and human review close to the work."
hero: "https://docs.aiwg.io/assets/blog/2026-9-aiwg-september-2026-report.png"
hero_alt: "Three blue glass supports with fitted pads carry a heavy white stone slab above calm water, beside a clear inspection prism and a small amber tile."
status: "published"
canonical: "https://aiwg.io/blog/2026-9-aiwg-september-2026-report"
---

# AIWG — September 2026

*AIWG brings project guidance and reusable skills into the AI tools you use. Its setup puts those files where each tool can read them. September added tools for coding, saved decision records, and checks on civic sources.*

## TL;DR

September widened the choice of tools you can use with AIWG. Pi, Oh My Pi, Google Antigravity CLI, and DeepSeek Harness gained support. Grok Bot reached stable support, while Grok Build joined as an experimental coding provider.

The Decision Engine added an alpha contract that defines decision inputs, results, and saved run records. Civic Action added workflows for public sources, records, meetings, and corrections, with people still approving contact, submissions, and publication.

## By the numbers

| What's public | Value |
|---|---|
| Managed npm packages | `aiwg`, `@aiwg/cli`, `@aiwg/cockpit` |
| Stable provider milestone | Grok Bot in `2026.9.16` |
| New decision contract | `decision.aiwg.io/v1alpha1` and structured `v1alpha2` entries |
| Civic workflow kit | Opt-in `civic-action` addon |
| Docs | docs.aiwg.io |
| Public repository | github.com/jmagly/aiwg |

## Highlights

**1. More tools can read the same project notes.** For a coding session in Pi, AIWG now supports coding runs and session import. If you use Grok Bot, deploy native skills under its own provider name. Grok Bot loads them through its own setup, replacing the Cursor workaround.

**2. Small decisions now have a shared contract.** To test a rule for routing a work item, opt into the Decision Engine and define its inputs and rules. It saves the result and run record for you to inspect. The inputs and result format stay the same when you switch backends.

**3. Civic work has a source and review trail.** A vote in a meeting transcript may differ from the approved minutes. Civic Action's structured workflows for work in the public interest let you compare the two and flag the mismatch, with the evidence and open questions attached to the review packet.

**4. Data workflows have a clearer handoff.** Before importing data, use Dataset Intelligence to define the sources and preview the plan. After the import, you can inspect what ran through its run record and checks, which connect the plan to that record and the result.

**5. Tests can be reviewed for what they prove.** When reviewing a test suite, ask Testing Quality for an inventory and a plan to repair weak checks. It can collect test-run evidence and assess the checks, including through deliberate failures that a sound test should catch.

**6. Session evidence can travel with its files.** To move selected sessions with their supported attachments and registered outputs, review a session export plan and build the archive. The export creates portable Fortemi Knowledge Shards that you can then verify and unpack.

## Features shipped

**Pi and Oh My Pi.** Pi began with project notes, skills, and prompt files in 2026.9.1. Version 2026.9.2 added model discovery, headless runs, and session import. Session import preserves the session tree. Pi remained experimental, and its core had no MCP support.

Oh My Pi arrived in 2026.9.3 with its own experimental support. It supports native agents, model lookup, teams with set limits, and session import. Choose `omp` when that is the tool you run. Pi and Oh My Pi each need their own setup paths.

**Google Antigravity CLI and DeepSeek Harness.** Antigravity arrived in 2026.9.3 with project agents, skills, and a bounded headless adapter. Its checks used CLI 1.1.26 offline. Live model runs still lacked proof. DeepSeek Harness followed in 2026.9.5 with project notes, native skills, defaults that limit permissions, and session import. Both remained experimental.

**Grok Bot reaches stable support.** Version 2026.9.16 gives Grok Bot a stable provider name, skill setup, guides, and manual session-export import. Use `grokbot` when setting up the Bot. The migration guide covers projects that had used the Cursor workaround.

For user-scope skills, set an absolute `AIWG_GROKBOT_SKILLS_DIR`. AIWG stops when that root is missing rather than guessing where to write. After setup, start a new Bot chat or ask it to read the skills again. The stable status rests on Linux checks. The release waived checks on macOS and Windows/WSL.

The later `aiwg bot-handoff` command prepares a draft for a routine, teammate, connector, or memory reference. You can review that draft before creating anything in the provider. The extra Grok Bot native adapters still had blocked writers. Stable skill support did not let AIWG create those objects for you.

**Grok Build gets its own path.** Grok Build is the coding CLI, separate from Grok Bot and the web Build experience. AIWG added it by 2026.9.17, with support still marked experimental. Project skills use `.grok/skills`, and the context files point back to shared project notes.

Before a coding task starts, run `aiwg build-verify --provider grok-build` to check setup and tool lookup. It uses `grok inspect` to check what Grok Build sees, so you can spot missing context before the build. The check does not prove a model followed that context. Version 2026.9.21 added a test contract and a gate for stable status. The adapter still needed proof from the released CLI across the required platforms.

**Decision Engine alpha.** For a trial that routes work items, you can define the allowed result, try a backend, and inspect its record. Version 2026.9.19 shipped one contract for Jev and ordinary LLM subagent backends, so switching between them keeps the same AIWG contract.

A definition states what to ask, a ruleset combines decisions, and a binding selects the backend. Instructions and criteria follow a set format, with pinned versions and limits on retries and fallback paths. A receipt saves the record of a call for checking retries and replay.

Version 2026.9.21 expanded the runtime with opt-in batching, human review, and an offline playground. It also requires a policy that selects which data may leave the process for a network call. The playground runs recorded examples through the real evaluator. The runtime stays off by default. Offline checks show how local code behaves. They do not prove a live model is right or grant the right to act.

**Civic Action workflows.** The September 1 release, 2026.9.0, shipped an opt-in kit for source review and civic writing. Start by asking the steward to set up Civic Action and check its tools. Then ask for a narrow artifact, such as a draft public-records request or a meeting review packet.

Each source record lists its origin, license and terms, how it was obtained, the legal region, and planned uses. Meeting work keeps the transcript, motions, votes, and approved minutes tied to sources. A missing vote stays unresolved. The workflows also cover public-technology review, local-resource profiles, corrections, and publication review.

Say a transcript and approved minutes disagree about a motion. The workflow cites the mismatch and sends a packet to a named human reviewer. It does not fill in the gap from a guess. A correction plan tracks changed claims and affected files. A reviewer can see what needs another check.

Local checks reject malformed records before checking policy rules. The rules block claims with no source, unresolved vote evidence, and publication without named approval of the exact file. People still decide whether to get source material, make contact, submit, approve a correction, or publish. A passing check only covers the declared fields. It does not verify every fact or settle legal questions. The kit did not ship adapters for local laws and rules.

**Data, schemas, and portable sessions.** When planning a data operation, you can check whether it fits what the receiving tool says it can do. Dataset Intelligence arrived in 2026.9.1 alongside a catalog of data shapes and checks for changes that might break them. Later releases exposed the data runtime through `aiwg/dataset` and shipped the Fortemi capability contracts used to check the receiving tool's stated support.

Session exports use a reviewed plan tied to the selected records. The 2026.9.16 updates added available attachment and output bytes, plus checks against changes after planning. You can check an export before you restore it. An export will not write over an archive unless you choose to do so.

**Writing controls and another provider.** When reviewing edits, you can protect required terms and facts with the writing controls added in 2026.9.5. These include opt-in author profiles, fact and audience briefs, protected text, and checks that edits keep the meaning. Choosing a profile alone does not rewrite every reply from your AI tool. Version 2026.9.21 also shipped experimental Muse Code support, including skills, a trusted context bridge, and export-first session import.

## Fixes

A refresh for one tool leaves the other tools' files in place. A bundle install also leaves another bundle's agents, commands, and rules in place. These repairs landed in 2026.9.7.

Project skills remain discoverable when the project cache is missing, stale, or corrupt. Nested workspaces can also find checked shared bundles outside their own folder.

The lightweight CLI now stops an unsupported bundled setup early and points to the full package. Later doctor output names a stale install when it causes an unknown-provider error.

Session export rejects changed selections and files after planning. It also protects an existing archive from accidental overwrite.

## Performance & reliability

The rule engine can keep compiled data checks in a cache with a size limit. It can reuse them on the next call.

The final September patches fixed CPU measurement and the test for the cap on active tasks. The CPU test gate now measures use by the thread under test. The dispatch-cap test holds work open while it checks a full queue. Discovery also warns about stale framework caches and gives steps to repair the affected cache.

## Breaking changes & migrations

Code that uses the Decision Engine in 2026.9.21 must supply a policy that sets which data a network call can send. New batch, context, and cache result fields require readers that accept `v1alpha2`. Durable batch stores need keys to check records and encrypt stored results; old unkeyed stores need an approved move to the new format.

Version 2026.9.20 retired the `next` stable package alias. Use `latest` for the stable channel or choose an exact release version.

## Releases

The shipped changes below use dates from the CHANGELOG.

- **2026.9.0** (Sep 1) — Civic Action source, meeting, correction, and publication review workflows.
- **2026.9.1** (Sep 4) — Dataset Intelligence, schema governance, and Pi resource deployment.
- **2026.9.2** (Sep 4) — Pi runtime, model discovery, and session integration.
- **2026.9.3** (Sep 5) — Oh My Pi and Antigravity support, stable Hermes, and project discovery fixes.
- **2026.9.4** (Sep 5) — clear recovery guidance for lightweight CLI setup.
- **2026.9.5** (Sep 7) — DeepSeek Harness, shared bundles, and author-controlled writing tools.
- **2026.9.6** (Sep 8) — test conformance review and reversible repair plans.
- **2026.9.7** (Sep 12) — scoped deployment cleanup and safer provider settings changes.
- **2026.9.9** (Sep 13) — clearer install checks, stale-file previews, and rule discovery.
- **2026.9.11** (Sep 14) — bounded waits for package proof and pinned test workflow actions.
- **2026.9.12** (Sep 15) — separate release workflow lanes and longer waits for package proof.
- **2026.9.15** (Sep 15) — a longer setup-test allowance to ship the session-export work described in 2026.9.14.
- **2026.9.16** (Sep 17) — stable Grok Bot, session attachment bytes, and export safeguards.
- **2026.9.17** (Sep 20) — packaged dataset runtime and contracts, with Grok Build in the provider inventory.
- **2026.9.18** (Sep 21) — executable dataset checks against prior release evidence.
- **2026.9.19** (Sep 21) — Decision Engine contracts, provider handoff drafts, and build verification.
- **2026.9.20** (Sep 21) — one stable package alias and release-source checks.
- **2026.9.21** (Sep 27) — expanded decision runtime, experimental effect ledger, and experimental Muse Code support.
- **2026.9.22** (Sep 27) — doctor guidance for stale installation identity.
- **2026.9.23** (Sep 27) — isolated CPU measurement for a decision test gate.
- **2026.9.24** (Sep 27) — dispatch-cap test repair and framework-cache diagnostics.

## Dependencies & security

When it updates tool settings, AIWG keeps existing JSON and TOML values. It rejects input in the wrong shape. When a run saves receipts, the Decision Engine stops if the receipt key is missing or invalid. The decision runtime also rejects secret material in receipts and cache entries.

When code cannot prove the work is done, the experimental effect ledger keeps the result unknown. It records planned actions and what was seen after them, with checks that distinguish present, absent, and unknown results.

## Docs & DX

Tool guides cover setup, support limits, and how to remove managed files. Grok Bot has a migration guide; Grok Build has a guide to checks before a build. Civic Action's quickstart leads with tasks you can ask for and the review packet each task should return.

Session docs walk through import, choice of records, export, checks, and restore. Decision docs explain contracts, backend choices, replay, and how to move to new formats.

## Tests & CI

Testing Quality gained reviews tied to source files, test-run records, planned failure cases, and repair plans you can undo. Checks covered real Vitest and pytest runs.

Data tests run against the packed package and the prior release contract. Decision tests include offline fixtures and a playground that uses the production evaluator. Checks with live services remain a separate step.

## Cross-project impact

**Fortemi:** AIWG's session archives use Fortemi Knowledge Shards, and Dataset Intelligence carries Fortemi capability contracts. Live-server data checks were still pending in the 2026.9.18 evidence. These contracts do not prove that a server can keep or restore data.

## Known issues & open threads

Pi, Oh My Pi, Antigravity, DeepSeek Harness, Grok Build, and Muse Code remained experimental in the September releases. Grok Bot's stable support includes skill setup and manual session import; native object creation remains blocked.

The Decision Engine still needs live checks for load, linked stages, and saved human review. Civic Action still needs people to check consent, how long to keep data, and who should review it.

## What's next

Live tests must check decision load, linked stages, and saved human review before broader use. Civic work still needs source review and named people to approve contact, submissions, and publication. Grok Build needs checks of the released CLI on all four required platforms before it can reach stable status.

## Appendix

- **Managed packages:** `aiwg`, `@aiwg/cli`, `@aiwg/cockpit`.
- **Public repository:** [github.com/jmagly/aiwg](https://github.com/jmagly/aiwg).
- **Release notes:** [GitHub releases](https://github.com/jmagly/aiwg/releases).
- **Public changelog:** [CHANGELOG.md](https://github.com/jmagly/aiwg/blob/main/CHANGELOG.md).
- **Docs:** [docs.aiwg.io](https://docs.aiwg.io).
- **npm:** [aiwg](https://www.npmjs.com/package/aiwg), [@aiwg/cli](https://www.npmjs.com/package/@aiwg/cli), [@aiwg/cockpit](https://www.npmjs.com/package/@aiwg/cockpit).
- **Window:** September 1–30, 2026.
