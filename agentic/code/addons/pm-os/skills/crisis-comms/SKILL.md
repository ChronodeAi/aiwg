---
name: crisis-comms
description: >-
  Use when a severe product outage needs a communication plan — stakeholders ranked by impact, a tailored message per group, a promised update *cadence*, and a post-mortem framework to fill after. Not for a routine communication plan (`comms-plan`), a launch announcement (`press-release`), or mapping stakeholder power and interest (`stakeholder-map`).
---

# Build a crisis communication plan for an outage

## Step 1 — Scope the outage

State what's down, who's affected, how severe it is, and what's known versus still unknown. Comms cannot wait for a full root-cause analysis — capture the current picture.

Done when impact, severity, and the known/unknown split are stated.

## Step 2 — Rank stakeholders by impact

Order the stakeholder groups by how hard the outage hits them — affected customers, execs, support, partners, internal teams — each with the one thing they most need to hear.

Done when every group is ranked by impact with its core concern named.

## Step 3 — Draft the message per group

For each group: acknowledge the issue, express empathy, say what's being done, and say what they should do — tailored to the group and in the company's voice. The first message can go out before the cause is known.

Done when each priority group has a message covering acknowledge / doing / their action, in the company's voice.

## Step 4 — Set cadence, channels, and spokesperson

Lay out the timeline: initial notice, the update rhythm ("next update within 30 minutes"), and the resolution note — plus the channel for each group and who speaks for it.

Done when each group has a channel, a spokesperson, and a promised update cadence.

## Step 5 — Stand up the post-mortem framework

Set up (to fill after resolution): a timeline of events, the root cause, the impact assessment, lessons, and action items with owners and deadlines.

Done when the post-mortem skeleton has all five parts and its action items carry owner + deadline fields.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-crisis-comms-{incident-slug}.md`. Never hand-build the path.

The doc holds: the outage scope, the impact-ranked stakeholders, the per-group messages, the cadence/channels/spokespeople, and the post-mortem framework.
