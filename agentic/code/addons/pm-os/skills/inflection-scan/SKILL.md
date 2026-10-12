---
name: inflection-scan
description: >-
  Use when forecasting future product opportunities from external
  shifts — a timeframe in, regulatory/technological/belief inflection
  points identified, their intersections found, and opportunities derived
  from those intersections out. Not for backcasting from an idealized end
  state of a specific product (`limit-strategy`), mapping where an existing
  product generates value (`value-chain`), or a general competitive scan
  (`netmba-competitor-analysis`).
---

# Scan for inflection points and the opportunities where they collide

## Step 1 — Set the scan window

Get the current year and the research timeframe (how far out to look).

Done when the current year and timeframe are both set.

## Step 2 — Identify inflection points on three axes

List 3-5 significant shifts each in: regulatory (law/policy changes), technological (emerging or rapidly improving tech), and belief (shifts in societal attitude, behavior, or expectation).

Done when each of the three axes has 3-5 named, specific shifts — not vague trend labels.

## Step 3 — Find where they intersect

Look across the three axes for shifts that combine — a regulatory change plus a technology shift, a belief shift enabling a technology's adoption — and name the second-order effect of each intersection.

Done when at least 3 intersections are named, each with a stated second-order effect.

## Step 4 — Derive opportunities

For each intersection, describe a concrete product, service, or business model it enables: the concept, the enabling trends, the challenges to building it, and a realistic timeline.

Done when 3-5 opportunities are derived, each traceable to a specific intersection with challenges and a timeline stated.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-inflection-scan-{topic-slug}.md`. Never hand-build the path.

The doc holds: the inflection points by axis, the named intersections with second-order effects, and the derived opportunities with challenges and timeline.
