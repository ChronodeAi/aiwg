---
ref: REF-XXX
title: "Short title of paper"
type: citations
authors:
  - name: "Lastname, First"
    orcid: "0000-0000-0000-0000"    # add where available
    prof-id: PROF-P-slug             # add where resolved
  - name: "Lastname2, First"
affiliation-primary: PROF-O-slug     # primary author's org (PROF-O- ID or free text)
funders:                             # extracted from paper acknowledgements (omit list if none)
  - id: PROF-F-funder-slug
    grant-id: "AGENCY-GRANT-NUMBER"  # if stated; null if not
status: induction-complete           # optional: placeholder | pending-acquisition | acquisition-deficit
acquisition-obstacle:                # required when status is pending-acquisition/acquisition-deficit
  state: not-attempted               # not-attempted | credential-required | structurally-unobtainable | artifact-absent
  detail: ""                         # the specific obstacle, e.g. "needs HF_TOKEN"; never a bare boolean
  paths-tried: []                    # ["resolve/main/README.md 200", "raw/main/README.md 401"]
bibliography:                        # how the edges below were established
  source: bbl                        # bbl | inline-thebibliography | pdf-reference-list
  count: 0                           # entries in the compiled bibliography
  count-method: 'counted \bibitem in .bbl'   # single-quoted: YAML "\b" is a backspace escape
  unique-count:                      # when printed ≠ unique (duplicate entries), else omit
---

# REF-XXX Citation Network

## Outgoing: Papers This Work Cites

| # | Title | Authors | Year | DOI/URL | Inducted REF | Confirmed by |
|---|-------|---------|------|---------|--------------|--------------|
| 1 | {cited title} | {Lastname et al.} | YYYY | arXiv:NNNN.NNNNN | REF-YYY | arxiv-id |
| 2 | {cited title} | {authors} | YYYY | DOI / URL | — | printed-entry |
| ... | ... | ... | ... | ... | ... | ... |

<!--
Outgoing rules:
- Membership comes from the COMPILED bibliography, in this order of preference:
    1. `.bbl` (`\bibitem` for natbib/plain, `\entry{}` for biblatex)
    2. `\begin{thebibliography}` inline in the `.tex`
    3. the reference list in the extracted PDF text
    4. the shipped `.bib` — ONLY to enrich metadata for entries already confirmed by 1-3
  The shipped `.bib` is the author's library, not the reference list. An entry present in
  `.bib` and absent from the compiled bibliography is NOT a citation; asserting it
  fabricates an edge. A 15-entry gap between the two is ordinary.
- One row per distinct cited work in the paper's reference list (cap at ~30 most relevant
  if the paper has 100+ refs; note which references were cut and why in Notes).
- "Inducted REF" column links to corpus REFs when the cited work is in the corpus.
  Mark as "—" (em dash) when the cited work is not (yet) in the corpus.
- "Confirmed by" records HOW the edge was established: `arxiv-id`, `exact-title`, or
  `printed-entry` (read the entry directly). Title similarity against a corpus index is
  not confirmation — author-year collisions defeat it (e.g. "Zou et al. 2023" may be GCG
  or Representation Engineering: same first author, same year, different work). Normalise
  brace-escaped titles (`{AI}`, `{Prompt}-{Driven}`) before comparing.
- Authors column: "Lastname et al." for ≥4 authors; full list for ≤3.
- DOI/URL: prefer arXiv ID format `arXiv:NNNN.NNNNN` for arXiv preprints; DOI for
  peer-reviewed; URL for blog posts / technical reports.
- Direction is a check, not an assumption: a work cannot cite something published after
  it. Verify both publication dates before writing the edge.
- When an outgoing row points to an inducted REF, that target REF's Incoming table
  MUST contain a corresponding row pointing back here. See bidirectionality below.
-->

## Rejected Candidates

| # | Title | Authors | Year | Why rejected |
|---|-------|---------|------|--------------|
| 1 | {candidate title} | {authors} | YYYY | `.bib`-only — absent from compiled `.bbl` |

<!--
Rejected-candidate rules:
- Record every candidate edge dropped after investigation, so a later extraction pass
  does not silently reintroduce it.
- Most common reason: present in the shipped `.bib`, absent from the compiled
  bibliography. Others: wrong node after author-year disambiguation; direction
  impossible by publication date.
- REF ids here are deliberately NOT edges. Corpus tooling stops treating a section as
  an edge source at this heading, so a rejection cannot assert the edge it records.
- Omit this section only when no candidate was rejected.
-->

## Incoming: Papers That Cite This Work

| # | Title | Authors | Year | DOI/URL | Inducted REF |
|---|-------|---------|------|---------|--------------|
| 1 | {citing paper title} | {Lastname et al.} | YYYY | arXiv:NNNN.NNNNN | REF-ZZZ |
| 2 | ... | ... | ... | ... | ... |

<!--
Incoming rules:
- One row per in-corpus REF that cites this paper (the bidirectional pair to that REF's
  Outgoing table).
- For external (not-yet-inducted) citers, list known notable citations (high-impact
  follow-ups, replications, critiques) with "Inducted REF" marked "—".
- Backfill rule: when REF-A is induced and its Outgoing table lists REF-B (already in
  corpus), REF-B's Incoming table MUST be updated to include REF-A. The Tier-5 backlink
  fan-out (commit 2c5b014) automates this; manual induction follows the same rule.
- Empty state: until the paper accumulates citers, use a single row:
    | — | (none recorded yet; preprint posted YYYY-MM-DD) | — | — | — | — |
-->

## Notes

{Optional free-form notes about the citation network. Common patterns:

- **Hub character**: this paper sits at the center of {cluster name} cluster — note central
  REFs and the cluster's intellectual lineage.
- **Author overlap**: shared authors with REF-AAA, REF-BBB (same lab / research line).
- **Methodological lineage**: this paper extends / contradicts / parallels REF-XXX's approach.
- **External replication state**: known independent replications or rebuttals not yet inducted.
- **Reference list size**: entries in the COMPILED bibliography vs included here, stating
  the counting method (e.g., "66 `\bibitem` in .bbl; this sidecar includes the 30 most
  relevant per Outgoing rules"). Never `.bib` size, and never a sum of artifacts — summing
  `.bib` and `.bbl` without dedup has produced counts inflated 2-3x. Note printed-vs-unique
  where they differ.

If acquisition is incomplete, document the named obstacle and the paths tried, not just
the fact:
- "PDF not acquired — structurally-unobtainable: closed access; Unpaywall zero OA locations,
  Semantic Scholar reports abstract elided, no arXiv preprint. Outgoing deferred."
- "PDF not acquired — credential-required: dataset repo returns 401 to anonymous client on
  `raw/main`; `resolve/main` also 401. Needs HF_TOKEN."
}

<!--
Format conventions (CLAUDE.md → "Citation Sidecars" section):
- Frontmatter `ref:` field MUST equal `REF-XXX` matching the filename.
- The sidecar pairs with documentation/references/REF-XXX-*.md (the analysis doc) and
  documentation/radar/REF-XXX-radar.md (the radar sidecar). All three share the same REF
  identifier and are kept in sync.
- The 6-column table format (`# | Title | Authors | Year | DOI/URL | Inducted REF`) is
  the canonical structure. A few older sidecars use 3-col or 5-col variants — those are
  accepted-state legacy but new sidecars should use 6-col.
- Bidirectional consistency is enforced by the corpus audit. See `/tmp/full-backlink-fanout.py`
  (audit P3 script) for the automated fan-out pattern when adding new REFs to a cluster.
-->
