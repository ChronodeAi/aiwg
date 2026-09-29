---
name: hidden-agendas
description: >-
  Use when multiple stakeholders' stated positions may not match what they
  actually want — a situation and stakeholder list in, a hidden-agenda map
  out (per-stakeholder likely motivation, fear, and stake). Also `/meeting`
  Step 1, feeding Step 2's `cialdini` influence design. Not for a fast
  field-read when short on time (`prep-the-room`), turning the map into
  influence tactics (`cialdini`), mapping formal authority instead of
  motivation (`power-map`), or reviewing your own delivery afterward
  (`leadership-presence`).
---

# Surface what each stakeholder actually wants

## Step 1 — Take the situation and stakeholder list

Get the situation description and the list of stakeholders involved — their stated positions, roles, and any known history between them.

Done when every stakeholder in scope is named with their stated position.

## Step 2 — Read each stakeholder's likely motivation

For each stakeholder, weigh financial interest, power dynamics, reputation, career stakes, ideology, personal relationships, and org politics. Ground the read in what's actually known — relationships, history, stated position — not unfounded speculation.

Done when every stakeholder has a specific likely motivation, fear, or stake, each tied to a stated factor rather than a guess.

## Step 3 — Note where agendas conflict

Across the full set, flag where two or more stakeholders' likely motivations pull against each other — that's where the meeting or decision gets hard.

Done when every real conflict between stakeholders' agendas is named, or the set is confirmed aligned.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-hidden-agendas-{situation-slug}.md`. Never hand-build the path.

The doc holds: each stakeholder's stated position, likely motivation/fear/stake, and the conflicts across the set.
