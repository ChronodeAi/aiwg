---
name: skill-browser
description: >-
  Use when the user wants to browse, discover, or get an overview of
  available skills, or asks "what skills are available", "show me
  everything I can do", "what can PM OS do", "list all skills", or "browse
  the skill library". Not for matching one task to one skill
  (`pm-os-skill`) or a live, personalized command tour (`pm-help`).
---

# /skill-browser — Catalog

## How it runs

Resolve the HTML path relative to this SKILL.md, **always print the `file://` path first** (it's the user's backup link if the launcher can't reach a host browser), then attempt to open it via the platform's launch command:

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HTML="$SKILL_DIR/skill-browser.html"
echo "Open in browser: file://$HTML"

if command -v open >/dev/null 2>&1; then
  open "$HTML"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$HTML"
elif command -v start >/dev/null 2>&1; then
  start "" "$HTML"   # empty-quote arg avoids Windows title-misparse
fi
```

If Bash isn't available (some sandboxed contexts), just print the `file://` path — the user can click it in chat clients that linkify file URLs.

Done when the `file://` path has been printed and an open attempt (or its absence, for sandboxed contexts) has been reported to the user.

## What you see

- **Left sidebar:** Workflows anchor at the top (returns to landing), then 11 main categories grouped under "What we choose / produce / interact / think & grow", then a de-emphasized "Inside PM OS" group for the PM OS System & Operations bucket.
- **Top header:** site title, search box (`/` to focus, `Esc` to clear), live skill counter.
- **Content pane:**
  - Default landing — 11 workflow cards as the "Start here" showcase.
  - Category view — card grid of skills in the selected category, alphabetical.
  - Search view — flat result list across all categories, name-weighted scoring.
  - Zero-results state — recovery chips linking to all 14 categories.

Each skill card shows: name, full description, a provider-neutral invocation hint (`Run PMOS skill: <slug>`), inputs it expects (parsed from `## Required Inputs` in the SKILL.md), output it produces, and workflow membership.

## Catalog freshness

The HTML is regenerated at release time and shipped inside the plugin. Skills added or renamed locally between releases won't appear until the next plugin update. The release pre-flight (`bin/release.sh`) and CI (`.github/workflows/ci.yml`) enforce categorization invariants via `bin/validate-skill-categories.sh` — drift is impossible at merge time.

## Browser support

Light mode only. Uses `oklch()` color tokens — minimum Safari 15.4 / Chrome 111 / Firefox 113. Older browsers degrade gracefully (colors approximate). Headings load IBM Plex Sans from Google Fonts via `font-display: swap`; if the CDN is unreachable the system sans stack takes over instantly.
