---
name: workshop-design
description: >-
  Use when a workshop has to be designed against hard constraints — a problem or
  a source transcript, a participant count, a time limit, and a platform in,
  either 3–5 activity variants to choose between or one sequenced agenda that
  reaches a named decision, with a minute-by-minute timeline that sums exactly to
  the time available. Not for a general pre-meeting brief (`meeting-outcomes`),
  a product refinement session's agenda (`refinement-session`), or running the
  ideation itself rather than designing the container for it
  (`brainstorm-genius`).
---

# Design a workshop that fits its constraints exactly

Miro board mechanics, referenced by Step 5: [miro-runbook.md](miro-runbook.md).

## Step 1 — Take the constraints and pick the mode

Collect the problem, the participant count and roles, the minutes available, and the platform (remote, in-person, hybrid). Where something is missing, state the assumption you are running on rather than asking again.

Then pick the mode:

- **Variants** — the facilitator wants options to choose between. Produce 3–5 distinct activity designs, each self-contained.
- **Agenda** — the facilitator has a source transcript, spec, or conversation and one goal, and wants a single runnable session plan that reaches a decision.

Done when problem, participants, time, and platform are all fixed — stated or assumed out loud — and one mode is named.

## Step 2 — Agenda mode only: read the source first

Pull from the transcript or spec: key themes, the decisions and questions the session must answer, constraints and risks, and any assumption you had to make (participant count, roles).

Done when the themes, the decisions to be made, and the risks are each listed, and every one traces to something in the source.

## Step 3 — Choose the shape

Let the constraints pick the structure rather than decorating a default:

**Time.** Under 30 minutes: rapid divergence, tight timeboxes, one convergence step. 30–90 minutes: diverge → cluster → prioritize. Over 90 minutes: add validation or a second round.

**Participants.** Over 20: swarm → pods of 4–6 → gallery walk → synthesis. 9–20: pods of 3–5 with rotating roles and report-outs. 8 or fewer: whole-group flow, silent ideation first.

**Platform.** Remote or hybrid: tech check, breakout choreography, explicit handoffs, mirrored pod boards. In-person: room setup, physical materials, wall space, visible timers.

Across the whole set, cover rapid ideation (Crazy 8s, 6-3-5), prioritization (2×2 impact/effort, ICE/RICE, dot voting), and synthesis (affinity clustering, How Might We reframes). Agenda mode covers these in sequence; variants mode covers them across the set.

If the goal cannot be reached in the time available, say so and propose a right-sized goal or a revised time — do not compress it into a plan that will overrun.

Done when the chosen shape names the specific time, participant, and platform rule it follows, and any unreachable goal has been re-scoped explicitly.

## Step 4 — Build the timeline

Write the minute-by-minute timeline, intro and breaks and wrap-up included. In agenda mode there is one timeline of 3–6 activities; in variants mode each variant carries its own.

Each activity gets: objective, duration, format, participant instructions, facilitator notes, materials and pre-reads, and the output artifact it produces.

Chain the activities so each one's output is the next one's input — themes → options → criteria → decision. Build in bias mitigation (silent write before discuss, timeboxed rounds, anonymous votes, rotating speakers) and accessibility (fonts 14pt or larger, no meaning carried by color alone, captions enabled). State what gets shortened or extended if time slips by ±10%.

Done when the durations sum exactly to the time available, every activity names the artifact it produces, and each artifact is consumed by a later activity or by the wrap-up.

## Step 5 — Write the facilitation detail

For each activity, write the facilitator process as concrete instructions: broadcast text, role assignments, timings, scaling notes for small (≤8), medium (9–20), and large (>20) groups. Then the participant process — what attendees do, what they create, what they decide.

For remote and hybrid, add the Miro setup from [miro-runbook.md](miro-runbook.md): frames, locked headings, pod structure and return protocol, timer durations, votes per person and criteria, 2×2 or Kanban configuration, export and decision log. For in-person, specify room layout and physical materials instead.

In variants mode, close each variant with pros and honest cons — real trade-offs like speed against depth, inclusivity, cognitive load, tooling complexity — each con paired with its mitigation.

Done when a facilitator who has never run this could execute it from the text alone, and every con carries a mitigation.

## Step 6 — Close the session on paper

Write the wrap-up: the decision log (what was decided, alternatives considered, rationale), owners and deadlines recorded as @mentions, the artifacts to export, and where and when results get shared.

Then the fallback: if the goal is not reached, why that would happen, what to right-size to, and what has to be gathered or pre-decided before a part two.

Done when the decision log format, an owner-and-date line, and a named fallback with its prerequisites are all present.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-workshop-{goal-slug}.md`. Never hand-build the path.

The doc holds: the constraints and assumptions, the source analysis in agenda mode, the timeline or timelines, the per-activity facilitation detail, and the wrap-up with its fallback.
