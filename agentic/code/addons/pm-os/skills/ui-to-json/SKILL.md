---
name: ui-to-json
description: >-
  Use when you have an existing UI screenshot and need it transcribed into
  structured JSON — every element, its position, style, and text content —
  for dev handoff, a design-system audit, or feeding another tool. Not for
  extracting PM-level requirements from a design (`requirements-from-design`),
  or sketching a flow that doesn't exist yet (`wireframe-sketch`).
---

# Transcribe a screenshot into structured data

## Step 1 — Take the screenshot

Get the UI screenshot to transcribe.

Done when the screenshot is in hand.

## Step 2 — Capture layout and color

Describe the overall layout (main sections and their arrangement) and the color scheme (primary, secondary, background colors as used).

Done when the layout's main sections and the color scheme are both captured.

## Step 3 — Enumerate every element

For every button, field, image, icon, and text block visible: its type, its content, its position, and its style properties (color, size, font, and other visible characteristics).

Done when every visible UI element has type, content, position, and style captured — none skipped for being minor.

## Step 4 — Flag ambiguities

Note anything uncertain — obscured elements, ambiguous hierarchy, unreadable text — rather than guessing silently.

Done when every uncertain read is flagged, or the transcription is confirmed unambiguous.

## Output

Write the structured JSON to `{project_path}/YYMMDD-ui-to-json-{screen-slug}.json`, resolving the path with `bash bin/memory/resolve-project.sh --project {slug} --json`. Include `overall_layout`, `color_scheme`, `ui_elements`, `text_content`, and any flagged `notes`.
