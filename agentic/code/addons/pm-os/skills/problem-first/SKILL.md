---
name: problem-first
description: >-
  Use when a team has locked onto a solution and needs pulling back to the problem — the *solution jump* diagnosed, the embedded assumptions surfaced and challenged, alternative framings generated, and validation research proposed before design starts. Not for turning a vague stakeholder brief into a problem statement (`brief-to-problem`), framing from a workshop transcript (`problem-framing-canvas`), or finding the pivotal obstacle in a strategy problem (`find-the-strategic-crux`).
---

# Pull the team back to the problem

The team is not wrong to have ideas — they are ahead of their evidence. Frame everything here as de-risking their solution, not rejecting it. A rejected team stops sharing ideas; a de-risked team brings you the next one earlier.

## Step 1 — Take the solution and its context

Get the proposed solution as it was actually stated and the context around it: who is pushing it, what triggered it, what deadline sits behind it, and what the team believes it will achieve. The exact wording matters — it carries the assumptions.

Done when the solution is captured verbatim and its trigger is named.

## Step 2 — Diagnose the solution jump

Name what is being proposed, then list the assumptions built into it: assumes users need X, assumes the problem is Y, assumes the best approach is Z. State the problem the solution implies it is solving, and the evidence status — what actually supports this being the right problem, and what is missing.

Done when every embedded assumption is listed and each is marked validated, partially validated, or unevidenced.

## Step 3 — Extract the problem underneath

Pull out the user need, the job-to-be-done, the desired outcome, how users accomplish this today and what goes wrong, and the real constraints — technical, business, user, environmental.

Done when the underlying need is stated without reference to the proposed solution.

## Step 4 — Challenge the assumptions

For each key assumption: is it validated, what evidence supports or contradicts it, what breaks if it is false, and what test would settle it. An assumption whose failure costs nothing does not need a test — say so and move on.

Done when every unevidenced assumption carries a risk-if-wrong and a proposed test, or an explicit "not worth testing".

## Step 5 — Write the problem statement

Fill: who experiences it, what friction, when and where, what impact and how severe, what workarounds exist today, and what measurable success looks like. Then state it in one line — "Users [who] struggle to [what] when [context] because [root cause], which leads to [impact]. Success would mean [outcome]."

Done when the statement names a measurable success condition and no solution.

## Step 6 — Generate alternative framings

Produce two or three genuinely different ways to frame this problem, each of which would lead somewhere the original framing would not. If all three point back at the proposed solution, the framing has not moved — try again from a different actor, timescale, or scope.

Done when at least two framings imply different solution spaces from the original.

## Step 7 — Propose the validation and the redirect

Write 5–7 research questions that would validate the problem — do users experience it, how often and how severely, what triggers it, how do they cope, what does "solved" look like to them — plus the method (problem-space interviews, observational research, diary study, analytics), the success criteria that would confirm this is the right problem, and a timeline.

Then arm the user for the conversation: how to acknowledge the solution thinking, reframe as problem exploration, show the value of validation, and set the phase boundary between problem and solution work. Draft the actual message to the team.

Done when the research plan has a timeline and the draft team message is written and ready to send.

## Output

In order: solution-jump diagnosis, underlying problem, assumption challenges, problem statement, alternative framings, validation research plan, and the redirect message. Once the problem is validated, the divergence questions ("how might we…", "what if [constraint] didn't exist", "how do other domains solve this") open the solution space.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-problem-framing.md`. Never hand-build the path.
