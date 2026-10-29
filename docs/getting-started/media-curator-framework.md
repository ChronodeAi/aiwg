# Media Curator Framework

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You're building a media archive — music, film, video, or any other collection. You want complete coverage of an artist or catalog, consistent metadata, proper file organization, and the ability to export to whatever platform you're using (Plex, Jellyfin, Navidrome, etc.).

The media curator framework handles catalog research, source discovery,
acquisition planning, quality review, tagging, completeness checks, and export
preparation. Use it to make collection decisions traceable before moving or
renaming files.

Each section below starts with what you can ask your assistant, then gives the command reference. Every command is kept exactly as shipped.

---

## Before You Start

Complete [Install, Connect, and Verify](install-connect-verify.md) first. If
you intentionally run a targeted deployment instead of the complete system,
`aiwg use media-curator` remains the manual command for this framework.

The first useful result should be a catalog reference, source plan,
completeness report, or export plan you can review before changing the
collection.

---

## The curation workflow

```
analyze → discover sources → acquire → assess quality → tag → check completeness → export
```

---

## Researching a catalog

> "Research the complete Radiohead catalog. Save a canonical reference I can review before acquiring anything."

Your assistant researches the artist's complete discography and recommends how to structure the catalog.

Start by understanding what a complete collection looks like:

### Command reference — catalog research

```bash
/analyze-artist "Radiohead"
```

The `discography-analyst` agent researches the artist's complete discography — studio albums, EPs, singles, live releases, compilations — identifies creative eras, and recommends how to structure the catalog. You get a canonical reference before you start acquiring anything.

---

## Discovering sources

> "Find complete sources for Radiohead. Rank them so I can review the list before acquiring anything."

Your assistant searches configured sources for available content and ranks candidates by the evidence available for quality, legitimacy, and completeness.

### Command reference — source discovery

```bash
/find-sources "Radiohead" --scope "complete"
```

The `source-discoverer` agent searches configured sources for available
content. It ranks candidates by the evidence available for quality,
legitimacy, and completeness so you can review a source list before acquiring
anything.

Filter by format or quality threshold:

```bash
/find-sources "Radiohead - OK Computer" --min-quality "lossless"
```

---

## Acquiring content

> "Acquire the approved source plan. Track progress and flag errors for review."

Your assistant orchestrates parallel downloads with format selection and logs the download plan for reproducibility. Where the manager briefs a worker, the brief names the goal, inputs, boundaries, result, and success check.

### Command reference — acquisition

```bash
/acquire --plan sources.yaml
```

The `acquisition-manager` orchestrates parallel downloads with format
selection, tracks progress, records errors for review, and logs the download
plan for reproducibility.

Acquire a specific item:

```bash
/acquire "https://archive.org/details/..." --format flac
```

---

## Quality assessment

> "Assess this collection at threshold 0.85. Flag replacements with the evidence I should check."

Your assistant scores every acquired file across audio quality, completeness, and uniqueness dimensions.

Every acquired file gets scored across audio quality, completeness, and uniqueness dimensions:

### Command reference — quality assessment

```bash
/quality-assess /path/to/collection --threshold 0.85
```

Files below the threshold are flagged for replacement. The `quality-assessor` agent compares against other copies in your collection and against source metadata to detect encoding artifacts, clipping, and truncation.

---

## Metadata and tagging

> "Tag this collection with consistent metadata and artwork. Enforce my naming convention and do not rename anything else."

Your assistant applies consistent metadata tags from MusicBrainz and your discography analysis.

### Command reference — tagging

```bash
/tag-collection /path/to/collection
```

The `metadata-curator` agent applies consistent metadata tags, embeds artwork, enforces your naming conventions, and organizes files into the directory structure you specify. Works from MusicBrainz and your discography analysis — not guesses.

Enforce a specific naming convention:

```bash
/tag-collection /path/to/collection --convention "artist/year - album/track - title"
```

---

## Checking completeness

> "Check this collection against the canonical discography. Show me what is missing in priority order."

Your assistant compares your collection against the canonical discography to identify gaps.

### Command reference — completeness

```bash
/check-completeness "Radiohead"
```

Compares your collection against the canonical discography to identify gaps. Shows what you have, what's missing, and what's available to acquire. The `completeness-tracker` prioritizes gaps by significance — studio albums before obscure B-sides.

---

## Verifying integrity

> "Verify the integrity of this collection and report anything that does not match acquisition records."

Your assistant runs SHA-256 integrity verification across the entire collection.

### Command reference — integrity

```bash
/verify-archive /path/to/collection
```

SHA-256 integrity verification across the entire collection. Detects corruption, identifies files that have changed unexpectedly, and reports anything that doesn't match acquisition records.

---

## Exporting to a platform

> "Export this collection for Plex without touching the source files."

Your assistant applies the metadata structure and directory organization that the target platform expects.

### Command reference — export

```bash
/export --profile plex /path/to/collection /path/to/output
/export --profile jellyfin /path/to/collection /path/to/output
/export --profile navidrome /path/to/collection /path/to/output
```

Each export profile applies the metadata structure and directory organization that the target platform expects. The `asset-manager` handles the transformation without touching your source collection.

---

## Full orchestration

> "Curate Radiohead end to end at lossless quality. Pause for confirmation at key decisions and save verification records."

Your assistant runs analyze → discover → acquire → assess → tag → verify in sequence, pausing for confirmation at key decision points.

Run the entire pipeline from scratch:

### Command reference — full orchestration

```bash
/curate "Radiohead" --output /path/to/collection --quality lossless
```

This runs analyze → discover → acquire → assess → tag → verify in sequence,
pausing for confirmation at key decision points. Success is a reviewed
collection plan plus verification records for the files AIWG actually handled.

**Agent-to-agent brief (example):**

```brief
Goal: acquire approved Radiohead sources at lossless quality. Inputs: source plan and output path. Boundaries: no renames outside the output path; keep source collection intact. Result: acquired files with checksums and error log. Success check: every file has a verification record.
```

---

## Key references

- `/check-completeness` — Collection gap analysis
- `/verify-archive` — Integrity verification
- `@agentic/code/frameworks/media-curator/README.md` — Full framework documentation
