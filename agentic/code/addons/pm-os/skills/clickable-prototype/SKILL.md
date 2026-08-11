---
name: clickable-prototype
description: >-
  Use when you have a screen sketch or image description and need a
  working, clickable HTML/CSS/JS prototype for user testing — built
  incrementally so each layer can be checked before the next. Takes a
  `wireframe-sketch` or `app-design-foundation` sketch as input. Not for
  the sketch itself (`wireframe-sketch`), or converting an existing
  screenshot into structured data (`ui-to-json`).
---

# Build the prototype layer by layer, checkable at each

## Step 1 — Take the screen description and app context

Get the screen description or sketch, and the app's purpose and context.

Done when the screen description and app context are both in hand.

## Step 2 — Build the HTML structure

Create the basic HTML with placeholder sections for every element named in the screen description — no styling yet, just structure and semantic tags.

Done when every element from the screen description has a corresponding HTML section, and the structure is shown before styling begins.

## Step 3 — Style it

Add CSS for layout, alignment, a clean modern look fitting the app's purpose, and responsive behavior across screen sizes.

Done when every structural element is styled, the layout is responsive, and the styling is shown before interactivity begins.

## Step 4 — Add interactivity

Implement click events and feedback states (hover, active, transitions) for every interactive element named in the screen description.

Done when every interactive element has a working click handler and visible feedback state.

## Step 5 — Combine into one file

Merge the HTML, CSS, and JS into a single, runnable file.

Done when the combined file runs standalone and every element from Step 2 is present, styled, and interactive where specified.

## Output

Write the combined prototype file to `{project_path}/YYMMDD-clickable-prototype-{screen-slug}.html`, resolving the path with `bash bin/memory/resolve-project.sh --project {slug} --json`. Never hand-build the path.
