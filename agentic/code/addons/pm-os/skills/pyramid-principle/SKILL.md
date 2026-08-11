---
name: pyramid-principle
description: >-
  Use when a piece of writing buries its conclusion under detail and needs
  Minto's pyramid structure — text in, the key message first, then 2-3
  supporting arguments with their strongest evidence, out. Not for
  designing influence tactics for a specific person (`cialdini`),
  reviewing your own spoken delivery (`leadership-presence`), or
  signposting a message so it survives a skim (`skimmable-writing`).
---

# Lead with the conclusion, not the path to it

## Step 1 — Extract the key message

Read the full text and identify the single most important conclusion or recommendation it's building toward — not a summary of the topic, the actual point.

Done when one key message is named, and it's a conclusion, not a topic restatement.

## Step 2 — Select the supporting arguments

Choose 2-3 arguments that directly justify the key message, and for each, the strongest evidence from the original text. Drop anything that doesn't directly support the key message, however interesting.

Done when 2-3 arguments are selected, each with its strongest supporting evidence, and nothing extraneous survives.

## Step 3 — Assemble in pyramid order

Lead with the key message, then the supporting arguments with their evidence, using concise phrases over full sentences where possible.

Done when the key message is the first thing stated, and no argument requires reading ahead to make sense.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-pyramid-principle-{topic-slug}.md`. Never hand-build the path.

The doc holds: the key message, and the supporting arguments with evidence in pyramid order.
