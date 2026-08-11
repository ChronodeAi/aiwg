---
name: app-design-foundation
description: >-
  Use when a new app needs its design *foundation* set before any screens get built — the one core feature, a grayscale sketch of the main screen, and a deliberately tiny design system. Fires at project kickoff or "where do I start designing this?". Not for full wireframe flows (`wireframe-sketch`), a testable prototype (`clickable-prototype`), or translating a PM spec to design (`pm-to-design`).
---

# Set the design foundation for a new app

## Step 1 — Get the project and the audience

Ask for the project description and the target audience. If the audience is "everyone," push once: who opens this app on a bad day, and what for?

Done when the description and a specific audience are in hand.

## Step 2 — Name the one core feature

From the description and audience, name the single most important task the user performs — one sentence, stated as the user's action ("log an expense in under ten seconds"), not the app's capability ("expense tracking"). Everything else in the description goes on a not-now list. If two tasks genuinely tie, ask the user to break the tie; a foundation with two cores splits every later decision.

Done when the core feature is one user-action sentence and the not-now list holds everything else.

## Step 3 — Sketch the main screen in grayscale

Describe the one screen that serves the core feature: layout regions, the essential elements, and where the core action lives — reachable without hunting. Grayscale only, no aesthetics; every element must earn its place by serving the core feature. If an element doesn't, it goes to the not-now list.

Done when the sketch description names each element's purpose and nothing on the screen is unexplained.

## Step 4 — Fix the tiny design system

Set the constraints the whole app will inherit: 3–4 font sizes with their roles (screen title, body, caption), one primary color plus at most 2–3 supporting colors with their jobs (action, warning, background), one spacing scale (a base unit and its multiples), and 1–2 button styles mapped to primary/secondary actions. Each choice gets one line of reasoning tied to the audience.

Done when every token has a named job, and the totals stay inside the limits — the limits are the system.

## Step 5 — Check the foundation against the core feature

Walk the core feature through the sketch using only the design system: can the user complete the task with the elements and styles defined, nothing missing, nothing extra? Fix what fails; note what the not-now list will pressure first.

Done when the walkthrough completes with zero missing tokens or elements, and the first future pressure point is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-app-design-foundation-{app-slug}.md`. Never hand-build the path.

The doc holds: the audience, the core feature and not-now list, the sketch description, the design system with per-token jobs, the walkthrough result.
