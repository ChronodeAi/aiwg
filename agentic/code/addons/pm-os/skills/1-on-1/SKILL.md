---
name: 1-on-1
description: >-
  Use when you're preparing a 1:1 and want it to be a real conversation, not a status readout — framed around the one outcome it must produce, with the 2–3 topics that need live discussion prepped. Not for prepping a general meeting (`meeting-prep`), a standalone difficult conversation (`difficult-conversation`), or managing up as an ongoing channel (`manage-the-upward-channel`).
---

# Prepare a high-impact 1:1

## Step 1 — Frame the relationship and the outcome

Name who this is with (manager, direct report, peer) and the dynamic, then the single thing that must come out of this meeting. Anything that's just an FYI moves to async.

Done when the relationship type is named and the one required outcome is written.

## Step 2 — Pick the 2–3 topics that need a conversation

Choose the few topics that genuinely need real-time discussion, marked must-discuss vs if-time. Not ten updates — the ones a message couldn't resolve.

Done when there are at most 3 topics, each marked must-discuss or if-time.

## Step 3 — Prep each topic

For each: one or two lines of context, the question or discussion, and what you actually need — a decision, input, an unblock, or just to think out loud.

Done when every topic has context, the discussion point, and the specific thing you need.

## Step 4 — Prep the hard part

If there's tension or feedback to give, don't route around it: name it, lead with facts not interpretation, own your view in "I" statements, and structure feedback as situation → impact → request.

Done when any tension/feedback topic has facts, an "I"-framed view, and a situation/impact/request — or it's confirmed there's none.

## Step 5 — Build the agenda

Their topics first (~5 min), your key topics (~15–20), then open time and action review (~5–10). Share it beforehand so they can add to it.

Done when the agenda is ordered their-topics-first and ready to share.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-1-on-1-{person-slug}.md`. Never hand-build the path.

The doc holds: the shared agenda (their topics, your 2–3 topics, action review) and your prep notes — the one outcome, what you need per topic, and any prepared feedback.
