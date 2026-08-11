---
name: press-release
description: >-
  Use when a product needs an Amazon-style working-backwards PR/FAQ — the
  release written as though it ships today with a customer quote, a leader
  quote and one hard proof point, then the external and internal FAQs that
  answer what press, customers and leadership will actually ask. Every
  unknown is left as a marked placeholder rather than invented. Not for a
  product requirements document
  (`prd-draft`), an outage or incident announcement (`crisis-comms`), a
  routine stakeholder communication plan (`comms-plan`), or the positioning
  statement the release leans on (`positioning`).
---

# Write a working-backwards press release

Amazon's forcing function: write the announcement first, and the parts of the product you can't describe to a customer are the parts you haven't thought through. The release is visionary but it is not vague — every feature becomes an outcome, every claim carries a number or a source.

Structure comes from `templates/amazon-prfaq.md` — a press release followed by an external FAQ (what press and customers will ask) and an internal FAQ (what leadership will ask). Read it before drafting; this skill owns the process, the evidence bar, and the edge cases.

## Step 1 — Gather the inputs

Ask one at a time for: the product (what it is, its name, its stage); the primary and secondary personas; what differentiates it; the company mission and background; the problems or goals it addresses; the evidence available (metrics, testimonials, research, competitive context, launch date, price, availability); and the audiences the release has to land with.

Anything the user doesn't have becomes a bracketed placeholder — `[CITY]`, `[DATE]`, `[STAT]` — collected into a "Fill these gaps" list, never a plausible-sounding invention.

Done when all seven input categories are either answered or converted to a named placeholder.

## Step 2 — Draft the release

Write the press release section of `templates/amazon-prfaq.md` — headline, one-line description, dateline, problem, solution, how it works, and the bolded availability line. 350–550 words. Plain, AP-style, active voice, grade 8–10 readability, present tense — future tense only for roadmap items labelled "Planned".

Two quotes exactly, as the template lays them out: a customer on what the product lets them do, and a company leader on why the company built it. Turn every capability into an outcome with "so that", and replace every vague claim with who, by how much, by when, compared to what.

Done when the draft holds both quotes, at least one concrete metric or external signal, and no hype adjective ("revolutionary", "game-changing") outside a quotation.

## Step 3 — Clear the edge cases

Check the draft against the four cases that break a release:

- **Stealth or unnameable customers** — use anonymous descriptors ("a Fortune 500 retail brand") and aggregate metrics.
- **Regulated, medical or financial claims** — no efficacy language; use "designed to", "may help".
- **Localisation** — local date and currency if a region was given, otherwise Month Day, Year and USD.
- **Confidentiality** — no internal code names, no non-public numbers unless explicitly released.

Done when each of the four has a verdict of applied or not applicable.

## Step 4 — Write the FAQs

Working backwards is finished by the questions, not the release. Write the external FAQ (what press and customers will ask — pricing, availability, what it replaces, how it works) in customer-facing language, then the internal FAQ (what leadership will ask — why now, why us, what we're betting, what happens if we're wrong) with the honest answer rather than the reassuring one.

Done when both FAQ sections are written and every question a skeptical reader would ask about the availability line has an answer.

## Step 5 — Polish and hand over

Tighten verbs, cut filler, verify every number traces to something the user gave you. Then offer two add-ons: a one-liner and tweet-length CTA, and three alternative headlines (benefit-led, outcome-led, category-defining).

Done when the numbers are verified, the "Fill these gaps" list is attached, and the add-ons have been offered.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-press-release-{product-slug}.md`. Never hand-build the path.

The doc holds: the press release, the external and internal FAQs, the "Fill these gaps" list, and any add-ons the user accepted.
