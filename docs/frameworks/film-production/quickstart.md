# film-production Quickstart

> **First time using AIWG?** Begin with [Install, Connect, and
Verify](../../getting-started/install-connect-verify.md). This guide assumes AIWG is already installed and connected
to the target project.

Use film-production when an AI assistant should carry a film, animated short, or episode from story intent to a
verified delivery while keeping one current production state, controlling references, and explicit locks.

## Before You Start

The framework plans, reviews, and verifies production work; it does not generate media, install editors or generation
services, change your model selection, or grant spend or publication authority. Image, video, speech, and editing
tools stay separate and must be installed and authorized on their own.

## Installation

```bash
aiwg use film-production
```

Verify what was deployed:

```bash
aiwg list
```

You should see `film-production` listed as an installed framework. Reload the provider session so it sees the new
`film-production-quickref` kernel skill. The 12 operational skills are reached through discovery rather than the flat
skill list:

```bash
aiwg discover "film production workflow" --limit 3
aiwg show skill film-intake
aiwg show template film-shot-record
```

## First Useful Task

Start from a concrete piece and ask for one reviewable artifact:

```text
Use AIWG's film-production framework to write a production brief for a 60-second
animated short. Record format, audience, delivery requirements, constraints, and
existing authority, list unresolved decisions, and do not start any paid generation.
```

Success means a production brief and a current state file you can review before story work begins.

## Lock Gates

Each phase exit is a recorded lock in the production state (schema v2):

| Lock | What it blocks |
|------|----------------|
| FP-G03 coverage lock | All paid motion generation until the animatic is watched at real speed and every beat is covered |
| FP-G05a picture lock | Sound lock until every cut has an accepted playback review at the current timeline hash |
| FP-G05b sound lock | Delivery until every audio element is measured and the mix is heard in context |
| FP-G06 delivery accepted | Calling a version final; publication is authorized separately |

Check the recorded constraints with the state checker from the framework directory:

```bash
cd "$AIWG_ROOT/agentic/code/frameworks/film-production"
node scripts/validate-film-state.mjs /path/to/production-state.json
```

`examples/production-state.example.json` shows the format. The checker validates recorded evidence; it does not inspect
images, play media, or judge creative quality. State files from schema v1 must be migrated to v2 first.

## Common Patterns

### Resume a Paused Production

```text
Resume the film production from the current state and reconcile any outstanding generation jobs.
```

The `film-resume` flow reads current state, reconciles uncertain jobs by task ID before creating new ones, and reports
the next permitted action.

### Revise One Shot

```text
Fix the prop count in shot 12 without disturbing the accepted takes around it.
```

The `film-revise-with-impact` flow marks affected shots, cuts, and locks pending, retains the previous version, and
re-checks the target change plus the scene's invariants.

### Edit in DaVinci Resolve or Mirage Tesseract

The quickref routes editing to DaVinci Resolve (verified Resolve MCP tools or scripting) or to Mirage Tesseract's
`tesseract-video` / `tesseract-motion` skills with the local `tsrct` CLI. Tesseract has no official MCP server. Verify
the connection and a real render in the current provider before editing.

## Next Steps

- Read the [overview](overview.md) for the full component catalog.
- Review the [taxonomy](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/film-production/docs/taxonomy.md)
  for capability IDs and the complete gate criteria.
- Read the [framework README](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/film-production/README.md)
  for the production contract.
