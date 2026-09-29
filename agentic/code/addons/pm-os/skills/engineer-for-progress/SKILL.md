---
name: engineer-for-progress
description: >-
  Use when a build needs engineering in function-space rather than
  problem-space — symptoms reframed as measurable functions, the chain
  designed right-to-left, prototypes laid out as orthogonal arrays instead of
  A/B tests, scope cut to a kick-ass half, and a wall set. Not for shaping an
  idea into a pitch with an appetite (`shape-up`), finding the application
  archetype before building (`eng-shape`), holding scope once it is already
  under pressure (`scope-defense`), or a retrospective on a finished project
  alone (`situation-retrospective`).
---

# engineer-for-progress

The build lives in **function-space**, not problem-space. **Symptoms** are not problems; **features** are not jobs. You design **right-to-left**: outcome → requirement → input → build. You prototype with **orthogonal arrays** that test multiple factors at once, not A/B tests that move one variable at a time. You ship the **kick-ass half**, not the half-assed whole. You set a **wall**.

Run steps in order. Each step ends on its completion criterion. If the user enters mid-loop (postmortem on a shipped build, mid-build scope cut), skim earlier steps to confirm the foundation, then enter at the relevant step. Mark earlier steps `n/a` only when they are genuinely settled, not when they are inconvenient.

## 1. Reframe to function

Read the input. Restate as: *"the system is supposed to do [function]."*

A **function** is a mechanism with a measurable quantity. A **symptom** is the effect a user notices.

- *"Paint doesn't drip"* → symptom. *"Paint settles at thickness 200μm under spray velocity X"* → function.
- *"Onboarding is broken"* → symptom. *"New users reach first value moment in under 10 minutes"* → function.
- *"App feels slow"* → symptom. *"Interaction-to-paint completes under 100ms p95"* → function.

If the function statement still uses a symptom word (*broken, slow, confusing, failing, dropping, dripping, sluggish, confusing*) or a vague qualifier (*easy, intuitive, smooth, fast*), iterate. Read [`reframing.md`](reframing.md) for the symptom→function move, the job/feature/requirement distinction, and the vague-word unpack.

**Done when:** the function statement names a mechanism with a measurable quantity and contains no symptom words or vague qualifiers.

## 2. Design right-to-left

Write the chain:

```
outcome  →  technology-agnostic requirement  →  input  →  build steps
```

The **requirement** must be tech-agnostic — a number, a duration, a constraint. *"Postgres on RDS"* is an input; *"writes complete within 50ms p99 under 1k concurrent writers"* is a requirement.

**Done when:** the chain has all four links, the requirement is measurable and tech-agnostic, and the input is downstream of the requirement (not the other way around). If the user cannot name the outcome, return to step 1 — the function is still soft.

## 3. Separate control from noise

List every variable that affects the function. Mark each:

- **control** — you choose this. Configs, feature flags, UI affordances, model parameters, retry counts.
- **noise** — the world inflicts this. User network, browser, hardware, time of day, prior context, what else they have open, their mood.

Flag any variable you've been treating as control that is actually noise. This is the most common build mistake.

**Done when:** every variable is classified `control` or `noise`. No variable is left as *"depends"* or *"it varies."*

## 4. Design the orthogonal prototype

Build the **orthogonal array**: N variants that test M factors simultaneously, with noise factors injected at extremes.

- Pick 3+ control factors you suspect drive the function.
- Pick 2+ noise factors and define their extreme values (worst network, worst hardware, hostile user, edge timezone).
- Lay out a matrix where each variant pairs different factor combinations.
- Run each variant under each noise extreme.
- Goal: find where the function **breaks**, not whether it works.

Refuse A/B tests for build decisions. A/B isolates one variable and teaches you nothing about the system. Read [`prototyping.md`](prototyping.md) for the matrix template and noise-factor patterns.

**Done when:** the plan tests at least 3 control factors and at least 1 noise factor per variant set. If the prototype is already chosen and design is closed, mark `n/a — design closed` and continue.

## 5. Cut to the kick-ass half

List current scope. Classify each item:

- **big hire** — required for initial adoption to make sense. Protect.
- **little hire** — required for daily use to form the habit. Protect.
- **everything else** — delete or defer, with a one-line reason.

A **kick-ass half** ships robustly under noise. A half-assed whole ships bloated and breaks. The cut protocol with examples lives in [`prototyping.md`](prototyping.md).

**Done when:** scope is reduced to big-hire + little-hire features only, and every cut item has a recorded reason. Cutting nothing fails the step — there is always slack on the first pass.

## 6. Set the wall

Set a **time wall** (a date) and/or a **dollar wall** (a cost ceiling). Name the tradeoff the wall forces.

- *"By Friday → cut feature X."*
- *"Under $20k inference cost → use a smaller model."*
- *"Before the offsite → ship onboarding, defer the dashboard."*

A wall without a named tradeoff is a wish, not a wall.

**Done when:** the wall has a date or a number, and one named tradeoff it forces.

## 7. Scan failure modes

Check the build against four traps:

- **confirmation bias** — am I A/B testing to *prove* my hypothesis instead of *break* it?
- **falling in love with the solution** — am I scoping around a prototype I'm attached to, rather than the function?
- **premature scaling** — am I building isolated components assuming they'll integrate cleanly later?
- **optimizing the wrong metric** — am I measuring the symptom (drips) instead of the function (thickness)?

For each: mark `present / absent / n/a` with one line of evidence.

**Done when:** every trap has a verdict. Any `present` verdict triggers a return to the relevant earlier step (bias/wrong metric → step 1; falling-in-love → step 4; premature scaling → step 5).

## 8. Emit the postmortem skeleton

Use the **FWBU** template from [`postmortem.md`](postmortem.md): mark each timeline event with Frustration / Washed-out / steppedBack / Unsure-what-to-do.

If the build is in flight, emit the skeleton with stages pre-marked for the team to fill as they go. If the build is done, walk the team through coding the timeline now.

**Done when:** the skeleton has at least one event per known stage with an FWBU code attached, and the "red pill" question is pre-filled at the bottom.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-engineer-for-progress-{build-slug}.md`. Never hand-build the path.

Emit in order: function statement, right-to-left chain, control/noise table, prototype plan, kick-ass-half scope with cut list, wall, failure-mode scan, postmortem skeleton. Mark `n/a` only for steps the user's entry point made genuinely irrelevant.
