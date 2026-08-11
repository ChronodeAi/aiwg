---
name: comms-plan
description: >-
  Use when a change has to be announced and neither the framing nor the rollout is settled — two or three viable frames, an IC draft and an exec draft in the user's own voice, then a *sequenced* plan naming channels, owners, what to leave out, and how you'll know it landed. Also /stakeholder Step 4, taking the stakeholder map and risk register as input. Not for a severe outage needing an incident cadence and post-mortem (`crisis-comms`), a recurring progress update (`status-update`), or critiquing a draft that is already written (`exec-update-review`).
---

# Frame a message and sequence its rollout

## Step 1 — Collect the raw material

Get four things: the facts of what's changing, the audiences who need to hear it, what the user wants each audience to do afterward, and a sample of the user's own writing to match tone against. Where a stakeholder map and risk register already exist, read them — the frames that work are the ones aimed at named incentives rather than a generic audience.

Done when the change is one paragraph of fact, each audience has a stated desired action, and a tone sample is in hand or explicitly unavailable.

## Step 2 — Offer two or three frames

Build genuinely different angles on the same facts — risk reduction, opportunity, customer impact, cost of the status quo. Give each a one-line rationale grounded in what makes it credible, what makes its logic hold, and what it makes the audience feel. Name the effect, not the theory behind it.

Done when there are at least two frames that lead to visibly different first sentences, each with its rationale, and the user has picked one.

## Step 3 — Match the register to each audience

Read the matching guide in `knowledge/Writing-Styles/` before drafting — executive, board, or VP → `writing-style-executive.md`; internal team → `writing-style-internal.md`; customers → `writing-style-customer.md`; engineers → `writing-style-technical.md`. Each carries tone rules with good and bad examples.

Done when the relevant guide has been read and the register it prescribes is named for each draft about to be written.

## Step 4 — Write both drafts in the user's voice

Short sentences, no buzzwords, scannable. Two versions:

- **ICs** (≤180 words): context, what changes for them, what to do, by when.
- **Execs** (≤120 words): the point first, then risks and asks, then the decision needed.

Add a subject line or headline that survives a notification preview, plus two Slack snippets — one announcement, one reminder.

Done when both drafts are inside their word caps, read in the user's tone rather than a corporate default, and every ask names an owner and a date.

## Step 5 — Sequence the rollout

Order the channels so nobody important hears it secondhand: exec pre-brief in a 1:1, then the team channel, then the written record, then Q&A. For each step give the channel, the owner, the timing, what to emphasize there, and the call to action. Add a **what to omit** list — detail that is true, available, and would only add noise.

Done when every step in the sequence has an owner, a time, and an emphasis, and the omit list has at least one item on it.

## Step 6 — Define how you'll know it landed

Name three success signals with thresholds: the decision made by a date, questions resolved within N hours, no repeat of the same question in the channel, sentiment in the replies.

Done when three signals are stated, each observable within a week without running a survey.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-comms-plan-{change-slug}.md`. Never hand-build the path.

The doc holds: the frames with rationales and the one chosen, both drafts plus the headline and Slack snippets, the sequenced plan as a table (step, channel, owner, timing, emphasis, CTA), the omit list, and the three success signals.
