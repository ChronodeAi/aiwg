---
name: skimmable-writing
description: >-
  Use when a message is written but won't survive a skim — rebuilt with the point and its stakes in the first line, an explicit *signpost* opening every paragraph so the reader always knows what a passage is doing, and 20–40% of the words cut. Not for reordering a buried argument into Minto's key-message-first hierarchy (`pyramid-principle`), a progress update's fixed wins/risks/asks format (`status-update`), or an exec-lens critique of a draft before you present it (`exec-update-review`).
---

# Rewrite content to survive a skim

A skimmed reader lands mid-paragraph and decides in a second whether to keep going. Signposts are what let them re-enter anywhere: every paragraph announces its own job before it does it. Based on Wes Kao's course.

## Step 1 — Get the content, the audience, and the goal

Take the raw text, who reads it, and what they should think or do afterward. Where the goal is missing, infer the most plausible one and state it in the opening line rather than leaving it implied. Take a target length if there is one.

Done when audience and goal are both written in one line each, and the goal names an action or a belief change.

## Step 2 — Build the spine

Restructure to this order, adjusting where the content genuinely differs:

1. **In short,** the core point and why it matters to this audience.
2. **Context:** the problem or opportunity this addresses.
3. **What we're proposing:** first, second, third.
4. **Evidence & reasoning:** because… for example… therefore…
5. **You might be wondering,** the most obvious objection, answered.
6. **As a next step,** the specific ask with owner and timing.
7. **If you remember one thing,** the single takeaway.

Done when the point and its stakes are in the first sentence, and every section has content rather than a heading with nothing under it.

## Step 3 — Signpost every paragraph

Open each paragraph with a phrase that previews its role, drawn from the palette: *In short* / *Bottom line* for the thesis; *Context* / *Here's why this matters* for setup; *First, Second, Third* for ordered points; *Because* / *Therefore* for logic; *For example* for illustration; *In contrast* / *However* for a turn; *As a result* for implication; *You might be wondering* / *A fair concern is* for objections; *So what?* / *What this means is* for meaning; *As a next step* for action; *If you remember one thing* for the recap.

Done when a reader could tell what each paragraph is doing from its first four words alone.

## Step 4 — Run the editing pass

Cut 20–40% of the words without losing meaning. Replace jargon with plain terms this audience uses. Promote specifics — dates, owners, numbers — over general claims. Turn bullets back into sentences wherever the logic between them needs to be explicit. Prefer words over bold: formatting that carries the emphasis stops working the moment a reader skims past it.

Done when the draft is 20–40% shorter than the input, every vague quantity has become a number or an admitted unknown, and bolding is doing no work that a word could do.

## Step 5 — Answer the obvious objection

Add one sentence that names the objection the audience will raise first and answers it. Where the source content had no evidence, reason from first principles with *Because*, and label any illustration you supply as illustrative rather than actual.

Done when the objection sentence is present and any invented example is explicitly labelled as such.

## Output

Return the rewritten text as plain prose in full sentences, without the instruction scaffolding around it. Short inputs still get the *In short* opening and the *As a next step* close.

Where the piece is a project deliverable, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write to `{project_path}/YYMMDD-{topic-slug}.md`. Never hand-build the path.
