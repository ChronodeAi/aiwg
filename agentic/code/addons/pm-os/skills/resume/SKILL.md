---
name: resume
description: >-
  Use when tailoring an existing resume to a specific job description — a
  resume, a JD, and a situation (perfect fit / stretch role / career pivot)
  in, a JD-matched resume out with every bullet rewritten in the JD's
  language and grounded in real experience. Not for building the STAR
  stories behind resume bullets (`star-stories`), preparing spoken interview
  answers (`pm-interview`), or broader career-direction guidance
  (`career-guidance`).
---

# Tailor a resume to match a job description

## Step 1 — Gather inputs

Collect the current resume, the full job description, and the situation (perfect fit, mostly qualified, stretch role, or career pivot). Note any page-length constraint.

Done when the resume, JD, situation, and length constraint are in hand.

## Step 2 — Map requirements against experience

Pull the JD's must-haves, nice-to-haves, and 10-15 scanned keywords. Sort the resume's content into strong matches, partial matches (with how to frame them), and genuine gaps (with how to mitigate or omit them).

Done when every JD requirement is classified as a strong match, partial match, or gap.

## Step 3 — Rewrite every bullet in the JD's language

For each experience bullet: [action verb] + [what was done] + [impact with numbers] + [a keyword from the JD]. Reuse the JD's exact terms for shared concepts (their "clients," not "customers"); never invent a number that wasn't in the source resume — use a reasoned estimate and flag it if the original had none.

Done when every kept bullet follows the formula and uses JD-matched language, and no fabricated fact was introduced.

## Step 4 — Fit the constraint and check honesty

Reorder so the strongest matches lead, trim to the page constraint, and verify: every claim is something the candidate can back up in an interview, no title or date was inflated, and no skill was added that isn't real.

Done when the resume fits the length constraint and every claim in it passes the interview-backable check.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-resume-{company-slug}.md`. Never hand-build the path.

The doc holds: the requirement-match analysis, the tailored resume, and a short list of the specific changes made.
