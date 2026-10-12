---
name: critical-decision-method
description: >-
  Use when expertise has to be extracted rather than asked for — Gary Klein's
  Critical Decision Method runs a 4-pass cognitive interview over one non-routine
  incident, surfacing the perceptual *cues* and hidden assumptions an expert
  cannot state when asked directly, and ends in decision requirements, a critical
  cue list, a debrief, and a training scenario. Runs on someone else or on your
  own past decision. Not for auditing one decision's process quality
  (`decision-audit`), debriefing a situation you just came out of
  (`situation-retrospective`), or coding a customer interview for JTBD forces
  (`interview-insights`).
---

# Extract an expert's invisible cues through a 4-pass cognitive interview

Probing question banks, output templates, the RPD model behind the method, and the pass/fail quality bar: [REFERENCE.md](REFERENCE.md).

## Step 1 — Pick the mode

Ask which mode applies:

- **Mode A — Self.** The user is the subject. You interview them directly, in "you".
- **Mode B — Expert.** The user interviews someone else. You supply the exact questions to ask and what to listen for, then analyze each report back and prompt the next probe.

Throughout, talk less than the subject. Follow their transitions rather than forcing an agenda, and hold missed items to return to instead of interrupting.

Done when one mode is named and the subject is identified.

## Step 2 — Pass 1, story triage

Open with: *"Tell me briefly about a decision that required real judgment — something non-routine where a less experienced person might have gotten it wrong."*

The best stories are the non-routine events people retell to colleagues. A story can be dramatic and still decision-poor ("someone died, but it was obvious what to do") — that one gets redirected, not deepened: *"That sounds intense — but I want a moment where you had to make a hard call. Was there a point where someone less experienced would have chosen differently?"*

Done when the story contains at least one decision point — a moment where multiple courses of action were open, or where the subject's read of the situation shifted. A decision-poor story sends you back for a new one before Pass 2.

## Step 3 — Pass 2, timeline

*"Walk me through it again — exactly what happened, and when?"*

Mark each decision point. Build a situation-awareness map: what did the subject know at each stage? Note inconsistencies — memory reorders events.

Done when the incident is a dated sequence you could draw, every decision point is marked on it, and what the subject knew at each stage is recorded.

## Step 4 — Pass 3, deep probing

At every decision point, probe:

- *"What did you notice when your read of the situation changed?"*
- *"What other options were you considering?"*
- *"If [specific cue] had not been there — what would you have done?"*
- *"Imagine [key event] didn't happen at all. Why might that be? What would that mean?"*

The hypotheticals are the unlock: they force assumptions into the open that the subject made without noticing. Keep every probe neutral or contrary — phrasing or tone that signals the answer you expect contaminates the response.

"Intuition", "experience", and "I just knew" are the start of an answer, never the end. Re-anchor: *"When you say you just knew — what specifically did you notice? What were you looking at?"*

Done when every decision point has been probed with at least one hypothetical, and no cue is left resting on "intuition", "experience", or "I just knew".

## Step 5 — Pass 4, novice check

*"If I were the one making this decision — what mistakes would I make? Why would I make them?"*

This is the master probe. Experts cannot see what is special about their own perception until they contrast it with a beginner's.

Done when at least one specific trap a novice would fall into is named, along with why they would fall into it.

## Step 6 — Synthesize all four outputs

Produce all four, using the templates in [REFERENCE.md](REFERENCE.md):

1. **Decision requirements** — per key decision: what made it hard, the cues and information used, the strategy applied.
2. **Critical cue list** — the specific signals a novice would miss, kept in story context, including negative cues (things that should have happened and didn't).
3. **Debrief summary** — prose on how expertise works in this domain: the patterns operating, the hidden assumptions, the shape of the novice-expert gap.
4. **Training scenario** — a tactical decision game: context, a dilemma with the cues embedded rather than flagged, an open "what do you do?", plus a facilitator debrief guide.

Run the pass/fail quality bar in [REFERENCE.md](REFERENCE.md) against the result.

Done when all four outputs exist, at least one cue is concrete enough to train someone to notice (a number, a word, a pause, an absence — not "experience"), and every quality-bar check passes.

## Guardrails

- CDM needs an **expert** — a subject with enough domain time to have formed patterns. A novice subject means reframing toward learning goals instead.
- CDM is **descriptive**: it reveals how a decision was made, not whether it was right.
- Anchor to one specific incident. General habits are outside the method.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-cdm-{incident-slug}.md`. Never hand-build the path.

The doc holds: the mode and subject, the timeline with its decision points, and the four synthesized outputs.
