# Source register

This register records seven primary web sources inspected on **2026-09-18**.
The notes are original, bounded paraphrases; no full source copies or media are
included. Retrieval date is not publication date. Publication dates are recorded
only when exposed by the retrieved source. Mutable documentation should be
rechecked before relying on current provider capabilities or format versions.

This portable bibliography maps `FP-SRC-01` through `FP-SRC-07` to local
source intake notes `REF-FILM-001` through `REF-FILM-007` under the resolved
artifact root at `research/sources/`. Formal research-complete induction and
study-quality grading are not claimed; preserve these intake references when
expanding the research corpus. Technical documentation describes capabilities and conventions;
research GRADE scores and film aesthetic acceptance are separate judgments.

## Bibliography and ingestion metadata

| ID | Primary source / canonical URL | Source type and version | Publication / retrieval evidence |
|---|---|---|---|
| FP-SRC-01 | [ScreenSkills: Script supervisor skills](https://www.screenskills.com/skills-checklists/scripted-film-and-tv/script-supervisor-department/script-supervisor-skills/) | Professional role checklist; version unspecified. | Publication unknown. Search-indexed source text inspected; direct page fetch returned HTTP 403. |
| FP-SRC-02 | [OpenUSD: Introduction to USD](https://openusd.org/release/intro.html) | Official project documentation; retrieved page identified release 26.08. | Publication unknown. Direct HTML retrieval. |
| FP-SRC-03 | [OpenTimelineIO: Documentation overview](https://opentimelineio.readthedocs.io/en/latest/) | Official project documentation; retrieved page identified 0.19.0.dev1. | Publication unknown. Direct HTML retrieval; `latest` is a mutable development reference. |
| FP-SRC-04 | [ACES: Encodings](https://docs.acescentral.com/encodings/introduction/) | Official encoding documentation. | Page displayed 2025-09-10. Direct HTML retrieval. |
| FP-SRC-05 | [Runway: Gen-4 Video Prompting Guide](https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide) | Official provider guidance, specific to Gen-4 video. | Publication unknown. Direct HTML retrieval. |
| FP-SRC-06 | [Blackmagic Design: DaVinci Resolve Fairlight](https://www.blackmagicdesign.com/products/davinciresolve/fairlight) | Official product capability documentation; retrieved page identified Resolve 21. | Publication unknown. Direct HTML retrieval. |
| FP-SRC-07 | [C2PA: Content Credentials Explainer](https://spec.c2pa.org/specifications/specifications/2.2/explainer/Explainer.html) | Official explanatory specification material, version 2.2. | Publication unknown. Direct HTML retrieval of the versioned page. |

Storage for this ingestion is **URL plus paraphrased notes**. No downloaded source
snapshot, source-file hash, or archived media is claimed. A changed webpage can
therefore require fresh verification rather than hash comparison. Access to a
source does not grant permission to redistribute its content.

## Observed claims and design implications

- **FP-SRC-01:** Script supervision spans advance breakdowns, physical and
  emotional continuity, dialogue/action changes, coverage, viable takes, and
  editorial handoff. This supports a continuity role across phases. The checklist
  is professional guidance, not a technical standard or proof of automated QC.
- **FP-SRC-02:** USD composes assets into sets, scenes, and shots using references
  and layers, with nondestructive overrides. Optional USD interchange can help
  real scene assets; generated viewpoints do not thereby become a consistent
  model. USD itself is not a complete rigging system.
- **FP-SRC-03:** OTIO represents editorial timing, clips, tracks, transitions,
  markers, and metadata while referencing media externally. An optional adapter
  can support editorial handoff; this overview does not establish lossless
  transfer of every application's effects or timeline behavior.
- **FP-SRC-04:** ACES2065-1 is associated with a SMPTE-standard encoding suited to
  interchange and archiving; ACEScg and ACEScct serve other workflow needs.
  Record source, working, and output color treatment. Selecting ACES is a
  pipeline choice and cannot restore degraded source detail.
- **FP-SRC-05:** Runway recommends clean, high-quality input images and concise,
  concrete motion descriptions, with incremental changes. Its Gen-4 guide
  discourages negative phrasing and overloaded scene/action instructions.
  Keep such guidance in model-specific preflight; it is not a universal rule or
  a guarantee that a requested action will occur.
- **FP-SRC-06:** Fairlight provides contextual sound audition, dialogue replacement,
  foley, picture/audio alignment, loudness monitoring, and configurable mix
  outputs. These capabilities support a dedicated sound review and specified
  delivery settings; they do not certify that a soundtrack has been checked.
- **FP-SRC-07:** C2PA describes ingredient/action provenance and identification of
  AI use. It explicitly distinguishes provenance from factual truth. Use Content
  Credentials where the actual toolchain supports them; a local receipt or hash
  manifest alone is not a C2PA implementation or proof of content accuracy.

## Framework practices and limitations

The taxonomy IDs, one-current-state rule, version-bound approval dimensions,
two-attempt repair threshold, representative-shot gate, and exact-source layer
policy are proposed framework practices informed by production failure analysis.
They are not requirements imposed by the seven sources.

The sources do not establish exact seed reproduction, automatic identity or prop
continuity, a guaranteed quality improvement, or a measured cost saving. A
bounded production pilot must measure those outcomes separately. Provider and
application capabilities must be checked against the actual selected model,
version, account, and interface before execution.

## Local production evidence

A private production session audit (2026-09-18), stored in that project,
supplies observed failure modes and proposed repairs. It is a bounded production
case, not a controlled study. Raw user media and transcripts are not copied into
this framework. No measured speedup or creative-quality gain is established yet.
