---
name: transcript-cleanup
description: >-
  Use when a raw interview transcript needs a light readability pass before
  analysis — a raw transcript in, a clean one out with filler and false
  starts stripped, speaker voice and meaning untouched. Also `/research`
  Step 1. Not for extracting structured notes from the cleaned transcript
  (`interview-notes`), JTBD analysis of a customer interview
  (`interview-insights`), or writing the interview guide that precedes the
  interview (`mom-test-guide`).
---

# Clean a transcript without touching its voice

## Step 1 — Take the raw transcript

Get the full raw transcript with its speaker labels intact (e.g. "Interviewer:", "Interviewee:").

Done when the raw transcript and its speaker labels are in hand.

## Step 2 — Strip noise only

Remove filler words ("um," "uh," "like," "you know"), false starts, and redundant repeated phrases. Leave every unclear or inaudible marker (`[inaudible]`) exactly as it appears — never guess at it.

Done when filler, false starts, and redundancy are removed, and no inaudible marker was altered or invented.

## Step 3 — Preserve voice and meaning

Do not alter what was said or how casually it was said — no formalizing casual language, no cutting content for brevity, no paraphrasing. Fix only punctuation and capitalization for readability.

Done when the edited transcript says exactly what the speaker said, in their own register, with only punctuation and capitalization changed.

## Step 4 — Verify the edit was light

Spot-check: would the speaker recognize their own words? If a sentence reads meaningfully shorter or more formal than the original, revert it — this step catches over-editing before it reaches analysis.

Done when every edited passage still reads as something the speaker would recognize as their own.

## Output

Hand the clean transcript directly to the next step (`interview-notes` or `interview-insights`) — no file save required mid-pipeline. If the user wants a standalone record, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write to `{project_path}/YYMMDD-transcript-cleanup-{participant-slug}.md`. Never hand-build the path.
