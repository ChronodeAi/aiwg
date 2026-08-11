---
name: gut-check
description: >-
  Use when someone faces a personal opportunity or commitment and wants to check whether external pressure is overriding their *gut* — capture the instinct, name the pressures, weigh the honest costs, and see if the gut holds. Not for classifying a decision's reversibility (`two-way-door`) or the full product-decision workflow (`decisions`).
---

# Gut-check a decision under pressure

## Step 1 — Capture the gut reaction

Before any analysis: the immediate instinct, where they feel it, and — absent all social or professional pressure — would they do this? Write it down before it gets rationalized away.

Done when the raw gut reaction and the no-pressure answer are recorded first.

## Step 2 — Name the pressures

Sort why they're considering it: to impress someone, obligation, FOMO, opportunity, or genuine interest. Ask who they're trying to please and what they fear losing by saying no.

Done when the real driver is named and separated from genuine interest.

## Step 3 — Weigh it honestly

Worst case if they do it versus if they don't; whether a gut-aligned alternative exists; competency (do they have the skills or would they fake it); and values/well-being alignment.

Done when the downside both ways, an alternative (or its absence), the competency read, and the values check are all stated.

## Step 4 — Pressure-test timing and red flags

Is the urgency real or manufactured — can they sleep on it? Then the red flags: making excuses to ignore the gut, "it might lead to something," can't articulate why it's good, would feel relieved if it were cancelled.

Done when the urgency is judged real or manufactured and each red flag is checked.

## Step 5 — Final gut check and recommendation

Has the gut changed, and if so on what new information? If not and they're still overriding it, name why. Give a recommendation grounded in the answers, not in the pressure.

Done when the recommendation states whether to proceed and ties to the gut and the honest weighing.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-gut-check-{decision-slug}.md`. Never hand-build the path.

The doc holds: the captured gut reaction, the pressures, the honest weighing (risk / competency / values), the timing and red-flag check, and the final recommendation.
