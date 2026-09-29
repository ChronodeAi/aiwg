---
name: career-guidance
description: >-
  Use when someone shares career thoughts and wants tailored guidance — themes reflected back from their own words, a path direction with trade-offs, positioning help, and one concrete *next step*. Not for writing the résumé itself (`resume`), interview preparation (`pm-interview`), building interview stories (`star-stories`), or a plan to master a specific skill (`skill-mastery`).
---

# Turn career thoughts into personalized guidance

## Step 1 — Reflect their own words back

From the career thoughts, name the themes — interests, strengths, values, and what they're moving toward and away from. Ground each in something they said; don't project a story they didn't tell.

Done when the themes are named and each traces to something in their input.

## Step 2 — Structure the path

Recommend a direction, short- and long-term: the roles, industries, or specializations that fit the themes — each with the trade-off it carries, not just the upside.

Done when the path names concrete roles/industries with the trade-off of each.

## Step 3 — Position the story

Give guidance on their bio and summary: the through-line to lead with, what to cut, and how to tailor it per surface (LinkedIn, application, personal site).

Done when there is a through-line and per-surface tailoring guidance.

## Step 4 — Plan the next steps

Concrete moves: the company type and culture that fit, the skills to build, the people to talk to, and — if a pivot is in play — the bridge that makes it credible.

Done when the next steps name a fit profile, skills, and people, plus a pivot bridge if relevant.

## Step 5 — Name the one next step

Pick the single smallest move they could make this week. Guidance that ends in "reflect more" has failed.

Done when one specific, this-week action is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-career-guidance-{name-slug}.md`. Never hand-build the path.

The doc holds: the reflected themes, the path direction with trade-offs, the positioning guidance, the next steps, and the one this-week action.
