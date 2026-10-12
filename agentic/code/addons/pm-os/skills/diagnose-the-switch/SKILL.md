---
name: diagnose-the-switch
description: >-
  Use when one buyer's *switch* is stuck and needs diagnosing — a transcript,
  thread, or pipeline note in, their timeline stage, the four forces scored
  against evidence, a qualify/disqualify verdict, the dominant blocker, and the
  verbatim next move out. Also fires on prepping or debriefing a sales call. Not
  for coding one customer interview into JTBD forces (`interview-insights`),
  clustering forces across many interviews (`jtbd-forces`), or writing the job
  statements for a whole market (`jtbd-jobs`).
---

# Diagnose one buyer's stuck switch

Read [`forces.md`](forces.md), [`timeline.md`](timeline.md), [`interviewing.md`](interviewing.md), and [`interventions.md`](interventions.md) on demand — each step names which.

The buyer is making a **switch**. Your job is to place them on the **timeline**, find the **dominant force** blocking the switch, and emit the move that gets them through — or disqualify and stop.

Run every step in order. Do not skip steps. Each step ends on its completion criterion; if the criterion fails, redo that step before moving on.

## 1. Place the buyer on the timeline

Read the artifact (transcript, email thread, ticket, pipeline note, or pre-call brief). Name the buyer's stage and quote one line of evidence.

Stages: **first-thought** → **passive looking** → **active looking** → **deciding** → **onboarding** → **ongoing use**. Definitions and stage markers: [`timeline.md`](timeline.md).

**Done when:** one stage is named and one verbatim quote from the artifact supports it. If the artifact has no buyer voice at all, declare `stage: unknown` and skip to step 2's interview branch.

## 2. Score the four forces

Score **push, pull, anxiety, habit** with one evidence quote each from the artifact. Evidence patterns per force: [`forces.md`](forces.md).

**Branch — thin artifact.** If the artifact gives you fewer than ~20 substantive lines of buyer voice, or step 1 returned `stage: unknown`, switch into interview mode: emit the next 3–5 questions following the **switch interview** protocol in [`interviewing.md`](interviewing.md) and stop. Do not invent forces.

**Done when:** every force has either an evidence quote *or* the explicit token `weak/unknown`. Inventing a force from inference, not the artifact, fails the step.

## 3. Apply the disqualify check

Compute:

- No **struggling moment** in push? → disqualify.
- No **time wall** anywhere on the timeline? → disqualify.
- Both present? → qualified, continue.

A time wall is a concrete forcing event (deadline, expiring sale, broken thing, scheduled life event) that produces a "today's the day" moment. Habit and anxiety scores do not gate this step — the disqualify is about whether the switch is *possible*, not whether it's *blocked*.

**Done when:** one of `disqualified` or `qualified` is declared with the missing element named (if disqualified). Disqualified runs stop here — emit the verdict and the reason.

## 4. Pick the dominant blocker

Compute `(push + pull) vs (anxiety + habit)`. Name the single force that, if you flipped it, would tip the equation toward the switch.

- Push weak → buyer hasn't felt the struggle hard enough yet.
- Pull weak → buyer can't see the better life.
- Anxiety high → buyer afraid of the new.
- Habit high → buyer attached to the old.

**Done when:** one force is named as the blocker with one sentence of reasoning grounded in the step-2 evidence. Naming two forces fails the step — pick one.

## 5. Emit the intervention

Look up the intervention for the dominant blocker in [`interventions.md`](interventions.md). Emit verbatim language the user can say or send next — questions, scripts, offer structures, or a 60–90 day **play-it-out** sim.

If the dominant blocker is *push weak* or *pull weak* and the buyer is still in passive or active looking, the intervention is usually more interview, not more pitch. Default to questions over scripts when in doubt.

**Done when:** the user has a concrete next move with verbatim language — not a category of move.

## 6. Write the job statement

Format:

```
HELP ME    [the progress the buyer is trying to make]
WHEN I AM  [the struggling situation they're in]
SO I CAN   [the outcome they expect on the other side]
```

Each slot must trace back to an evidence quote from the artifact. Cite the source line for each slot.

If a slot has no evidence, write `[NO EVIDENCE — ask: <specific question>]` rather than invent. The unfilled slot becomes the next interview question.

**Done when:** all three slots either have a source-line citation or an explicit `[NO EVIDENCE]` marker with the question that would fill it.

## Output

Emit, in order: stage, four-forces scorecard with evidence, qualify/disqualify verdict, dominant blocker, intervention, job statement. Nothing more, nothing less.
