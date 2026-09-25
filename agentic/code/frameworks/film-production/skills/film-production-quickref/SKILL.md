---
name: film-production-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: Route film production, DaVinci Resolve editing, and Tesseract video/motion graphics through verified skills and tool adapters.
triggers:
  - AI film production
  - film production workflow
  - film-production
  - DaVinci Resolve film editing
  - Tesseract video editing
  - Tesseract motion graphics
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Production — Quick Reference

Use for reference-driven films, shorts, animated episodes and generated-video content. One lifecycle: **develop → design → previs → generate → finish → deliver**. Start at the current decision, not at inception on every turn. Production pause, approvals and spend authority are separate states.

## Discover then load

Run `aiwg discover "<phrase>" --limit 3`, then `aiwg show skill <name>`.

| Need / discovery phrase | Skill |
|---|---|
| film intake | film-intake |
| prove film story | film-story-proof |
| build film continuity pack | film-continuity-pack |
| plan film shots | film-shot-plan |
| preflight film provider | film-provider-preflight |
| edit film reference | film-reference-edit |
| generate film motion coverage | film-motion-coverage |
| direct film performance and sound | film-performance-sound |
| conform film edit | film-edit-conform |
| review film quality gate | film-review-gate |
| deliver film package | film-delivery |
| review film retrospective | film-retrospective |

For roles, rules and artifacts use `aiwg show agent film-continuity-supervisor`, `aiwg show rule film-source-fidelity`, `aiwg show template film-shot-record`, or `aiwg show flow film-revise-with-impact`. The source README and taxonomy document the complete catalog; avoid loading every body into context.

## Fast path

1. Read the current production state and affected shot; preserve approved decisions and immutable reference versions.
2. Identify the cheapest useful next proof. A draft guides blocking; it is not a final quality master.
3. Verify current tool/model capability, source quality, physical action and authority before submission. Reconcile a known task before retrying an ambiguous write. Paid motion waits for the coverage lock; delivery waits for picture and sound locks (criteria: `docs/taxonomy.md`; check with `scripts/validate-film-state.mjs`).
4. Inspect target change **and** scene invariants. Review motion in playback, audio in context. Record candidate/verified/accepted distinctly.
5. Continue authorized work to a coherent review package. Ask only for missing decisions or permissions that materially block the next action.

## Editor and motion-graphics routing

Keep the intended native project as the source of truth; do not migrate an existing edit merely because another editor is available. Pair the execution route below with `film-edit-conform`, `film-review-gate`, and `film-delivery`.

| Need | Execution route | Native handoff |
|---|---|---|
| Existing Resolve timeline, editorial conform, Fusion compositing, Color grading, Fairlight mix, or Resolve delivery | DaVinci Resolve through the session's verified Resolve MCP tools or installed Python/Lua scripting adapter | Resolve project/archive, source media, current timeline and export |
| Local footage editing, cuts, framing, dialogue/music, and a portable editable composition | Load the installed `tesseract-video` skill, then use Mirage's `tsrct` CLI | `.tsrct`, source assets, review media and finished render |
| Editable animated titles, typography, diagrams, native shapes/keyframes, or overlays | Load the installed `tesseract-motion` skill, then use `tsrct` | `.tsrct` plus rendered preview; verified alpha export when needed |

### Discover the real transport

- Skills are instructions; MCP servers and local CLIs are execution surfaces. Check each provider's actual skill/tool discovery separately. A successful OMP render does not establish Codex or Claude sandbox permissions.
- **Tesseract by Mirage:** the official package provides `tesseract-video`, `tesseract-motion`, and the local `tsrct` runtime. It does not declare an official MCP server. Do not invent `tesseract-mcp`, require MCP for this route, or confuse `tsrct` with the unrelated `tesseract` OCR executable. The installer places `tsrct` in a per-user location that is often not on `PATH` (macOS: `~/Library/Application Support/Tesseract/bin/tsrct`); a failed `command -v tsrct` or a found OCR `tesseract` does not establish that Tesseract is absent.
- **DaVinci Resolve:** discover the configured server name and live tool schemas; `davinci-resolve` is a possible registration, not a guaranteed tool in every provider. Recent installations may bundle `ResolveMCP`; otherwise use only an installed, verified scripting/GUI adapter. Never infer a working connection from an app, executable, plugin, or config entry alone.
- Keep hosted generation adapters separate from editing. Their account, upload permissions, task identity, cost and spend gates still require `film-provider-preflight`; neither local editor installation authorizes a paid generation.

### Preflight before editing

1. For Tesseract, read the installed skill's `references/installation.md` and adjacent `cli-version.txt`. Resolve the absolute `tsrct` path and match `--version` to that pin. If setup is authorized, follow the [official installation guide](https://github.com/mirage-hq/Tesseract/blob/main/skills/tesseract-video/references/installation.md): supported OS/architecture, exact release, checksum verification, renderer/encoder requirements, and a short inspected preview. Do not substitute the latest runtime or silently enable telemetry.
2. A sandbox can hide a working GPU. If rendering fails, retain the exact error, distinguish host capability from agent permissions, and use the provider's normal per-command approval for the scoped render when authorized. Do not disable the sandbox globally, bypass platform security, guess missing drivers, or count `--version` as render proof.
3. For Resolve, verify a fully loaded application, MCP handshake/tool discovery or scripting connection, external-scripting settings where required, and the actual project, timeline, frame rate, media links and export range before writing. Use the installed scripting/API documentation; check Free/Studio, Extras and version-dependent support for the requested operation. Do not launch a different project or expose network scripting as an automatic repair.
4. Read the selected Tesseract skill's authoring, motion, review and delivery references, or the Resolve adapter's equivalent. Preserve editable text, graphics and audio; inspect native previews, temporal playback and the encoded output. Record untested audio/alpha paths rather than claiming full coverage from a silent still preview.

### Cross-editor delivery

Exchange rendered media between Resolve and Tesseract only with checked dimensions, frame rate, source ranges, color handling, audio and alpha where applicable. Do not imply an editable Resolve/Tesseract round-trip or convert native layers into a flattened substitute without authorization. Keep each native project, original source assets, useful previews and the matching finished render together for revision.

### Repair and finishing toolkit

Inside an existing Resolve project, prefer its native tools over custom per-frame code, and move to them no later than the second failure of another method (`film-source-fidelity`):

| Defect class | Resolve-native route |
|---|---|
| Exact art or in-world screen text riding a moving surface | Fusion Planar Tracker with Planar Transform or Corner Positioner; check containment and occluders with masks |
| Hand, finger, or object mattes | Magic Mask (Color page or Fusion) |
| Stray marks, ghost objects, small cleanup | Fusion paint, Vector Warp or patch-based tools |
| Noisy foley, hum, level mismatch | Fairlight noise reduction, EQ, dynamics and loudness matching |
| Soft or lower-resolution shots | Super Scale / sharpening / deblur, judged only at native-size crops against the controlling master |
| Speed changes | Retime curves with optical-flow or AI frame interpolation, reviewed in playback |
| Structural edit safety | Native timeline backups/compare before each structural change |

Availability differs by version, Free/Studio, and downloaded Extras, and some analysis steps (for example running a tracker) may be GUI-only. Confirm each tool and whether it can be driven from the scripting API through the connected Resolve MCP's API search or the installed scripting documentation before planning an automated path; record GUI-only steps as operator actions.

Local open-source tracking, segmentation, optical-flow, video-inpainting or audio-denoising models are an escalation after native tools fail, not a default. They are software installs: require explicit approval, pinned official releases, recorded versions and weight checksums, and a test on one representative shot first.

## Boundaries and adapters

Marketing owns campaign positioning/distribution; research owns cited source induction; media-curator owns acquisition/catalog integrity. Film-production owns shot acceptance and editorial delivery. Discover existing provider/NLE skills for execution; this framework neither installs software nor grants publishing/spending authority. Never freeze transient model prices or assert a seed guarantees identical output.

New skills/agents require provider session reload after deployment. Use only runtime tools actually exposed; a capability-matrix label alone is not evidence of working integration.
