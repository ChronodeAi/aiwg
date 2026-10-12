---
name: transcript-insights
description: >-
  Use when a conversation transcript — a long meeting, a sprawling Slack thread, a call recording — needs *reconstruction*: who said what, how the discussion branched, what got committed, and what's still dangling. Fires on "what happened in this conversation" or "pull the decisions and actions out of this." Not for an IDEAS-format meeting summary (`meeting-summary`), customer-interview analysis (`interview-insights`), or extracting requirements (`requirements-from-talk`).
---

# Reconstruct a conversation from its transcript

## Step 1 — Get the transcript and the purpose

Get the transcript and why the user needs it unpacked — catching up after missing it, preparing a follow-up, finding who owns what, settling a "who said that" dispute. The purpose decides what Step 5 leads with.

Done when the transcript is in hand and the purpose is one sentence.

## Step 2 — Identify the participants

List every participant with their role — from the transcript itself or the user. A speaker whose role is unknown gets marked unknown, not guessed; misassigned authority corrupts the commitments step.

Done when every speaker has a role or an explicit unknown.

## Step 3 — Reconstruct the flow and its branches

Trace the conversation in order: the main topics, and every point where it branched — split into a new subject, doubled back, or got interrupted. Mark each branch **closed** (reached a conclusion, with the conclusion) or **dangling** (abandoned mid-air). Dangling branches are findings, not noise.

Done when the topic sequence is complete and every branch carries a closed-with-conclusion or dangling mark.

## Step 4 — Extract the commitments

Pull out every commitment: who agreed to do what, by when if stated, each backed by the line it comes from — quote the words, keep hedges ("I could probably look at it" is not "I'll do it"), and never merge statements from different parts of the conversation into one commitment.

Done when every commitment has an owner, a supporting quote, and hedged statements are marked as hedged.

## Step 5 — State where it landed

Write the current status: what was decided (with the deciding line), what remains open, and the open-items list — every dangling branch from Step 3 and every question raised but never answered lands here with a suggested owner. Lead with what the Step 1 purpose asked for.

Done when every dangling branch and unanswered question appears in open items, and the status distinguishes decided from discussed.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-transcript-insights-{conversation-slug}.md`. Never hand-build the path.

The doc holds: the participants, the flow with branch marks, the commitments with quotes, the status, the open items with suggested owners.
