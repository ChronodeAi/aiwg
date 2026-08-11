---
name: resume-skill-gaps
description: >-
  Use when placing a PM's resume on the career ladder and naming the skill
  gaps to the next level — a resume in, the current level with reasoning,
  the next level's requirements, and the specific named skill gaps out. Not
  for the actual learning plan to close a named gap (`skill-mastery`),
  broader career-direction guidance beyond a ladder placement
  (`career-guidance`), or tailoring the resume itself (`resume`).
---

# Place a resume on the PM career ladder and name the gaps

## The career ladder

1. **APM** — given a feature, ship that feature
2. **PM 1** — given a strategy, execute and ship the full product
3. **PM 2** — given a problem, craft and execute a winning strategy
4. **Lead PM** — given a problem space, identify the right problem(s) and focus the team
5. **Staff PM** — given a problem space, find the right problems while up-leveling others
6. **Manager** — given a team and a problem space, align talent and execute
7. **Director** — given multiple teams and no clear problem space, create the environment for others to achieve 1-5
8. **Sr Director** — same, for others to achieve 1-7, at higher complexity
9. **VP** — given a large org and several unclear problem spaces, create the environment for others to achieve 1-8
10. **CPO** — given a company with unclear spaces, create the problem spaces and org structure for others to achieve 1-9

## Step 1 — Place the current level

Extract job titles, responsibilities, years of experience, and achievements from the resume, and compare each against the ladder. Determine the current level with reasoning tied to specific resume evidence, and list 3-5 questions to validate the placement if evidence is thin.

Done when a level is named with reasoning that cites specific resume evidence, plus any validating questions.

## Step 2 — Compare to the next level

Name the concrete differences in responsibility, skill, and expectation between the current level and the next rung.

Done when the next-level differences are named specifically, not as a restatement of the ladder definition.

## Step 3 — Name the skill gaps

For each difference from Step 2, name the specific skill gap, the ladder line it maps to, and why it matters for that promotion — not a generic competency label.

Done when every skill gap is tied to a specific ladder-level difference and a stated reason.

## Step 4 — Hand off the learning plan

For each named gap, don't build the learning plan here — pass it to `skill-mastery` as a separate skill-by-skill run.

Done when every named gap has been handed to `skill-mastery`, not answered inline.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-resume-skill-gaps-{name-slug}.md`. Never hand-build the path.

The doc holds: the current-level placement with evidence, the next-level comparison, and the named skill gaps ready to hand to `skill-mastery`.
