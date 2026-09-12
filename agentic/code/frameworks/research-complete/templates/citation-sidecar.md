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
discovery:                           # optional source-tracking block (see discovery subsystem)
  date: YYYY-MM-DD
  surface: x-search                  # x-account|x-search|rss|newsletter|web|referral|direct|...
  via: "source handle or URL"
  curator-id: PROF-S-slug            # PROF-S backlink; omit/null if no curator
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
- One row per distinct cited work (cap at ~30 most relevant if the paper has 100+ refs;
  note which were cut, and why, in Notes).
- "Inducted REF" links to corpus REFs when the cited work is in the corpus; "—"
  (em dash) when it is not (yet).
- "Confirmed by" records HOW the edge was established: `arxiv-id`, `exact-title`, or
  `printed-entry` (read the entry directly). Title similarity against a corpus index is
  not confirmation — author-year collisions defeat it (e.g. "Zou et al. 2023" may be GCG
  or Representation Engineering: same first author, same year, different work). Normalise
  brace-escaped titles (`{AI}`, `{Prompt}-{Driven}`) before comparing.
- Authors: "Lastname et al." for ≥4 authors; full list for ≤3.
- DOI/URL: prefer `arXiv:NNNN.NNNNN` for preprints; DOI for peer-reviewed; URL otherwise.
- Direction is a check, not an assumption: a work cannot cite something published after
  it. Verify both publication dates before writing the edge.
- Bidirectionality: when an Outgoing row points to an inducted REF, that target REF's
  Incoming table MUST contain a corresponding row pointing back here.
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
- One row per in-corpus REF that cites this paper (the bidirectional pair to that
  REF's Outgoing table).
- For external (not-yet-inducted) citers, list notable ones (high-impact follow-ups,
  replications, critiques) with "Inducted REF" marked "—".
- Backfill rule: when REF-A is induced and its Outgoing lists REF-B (already in corpus),
  REF-B's Incoming MUST be updated to include REF-A.
- Empty state until the paper accumulates citers:
    | — | (none recorded yet; preprint posted YYYY-MM-DD) | — | — | — | — |
-->

## Outgoing: Spoken References and Informal Mentions

| # | Reference / mention text | Timestamp | Quote | Type | Inducted REF |
|---|--------------------------|-----------|-------|------|--------------|
| 1 | "{verbal reference as spoken}" | HH:MM:SS | "{exact transcript quote}" | informal | REF-YYY |
| 2 | "{paper, project, person, or idea named verbally}" | HH:MM:SS | "{exact transcript quote}" | formal-citation | — |

<!--
Time-based media rules:
- Use this table for talks, podcasts, interviews, lectures, and videos where a
  speaker references work verbally instead of through a formal reference list.
- Timestamp MUST point into the transcript sidecar.
- Quote MUST match the transcript exactly.
- Type values: formal-citation, informal, project, person, venue, unclear.
- "Inducted REF" links to a corpus REF when the mentioned work is already in
  the corpus; use "—" when the mention is unresolved or not yet inducted.
- Do not force DOI/paper metadata for informal spoken references.
-->

## Notes

{Optional free-form notes about the citation network. Common patterns:
- **Hub character**: central REFs and intellectual lineage of the cluster this sits in.
- **Author overlap**: shared authors with REF-AAA, REF-BBB (same lab / research line).
- **Methodological lineage**: extends / contradicts / parallels REF-XXX's approach.
- **External replication state**: known replications or rebuttals not yet inducted.
- **Reference list size**: entries in the compiled bibliography vs included here, with the
  counting method. Never `.bib` size and never a sum of artifacts — summing `.bib` and
  `.bbl` without dedup has produced counts inflated 2-3x.

If acquisition is incomplete, document it with the named obstacle and the paths tried, not
just the fact: "PDF not acquired — structurally-unobtainable: closed access; Unpaywall zero
OA locations, Semantic Scholar reports abstract elided, no arXiv preprint. Outgoing deferred."}

<!--
Format conventions:
- Frontmatter `ref:` MUST equal `REF-XXX` matching the filename.
- The sidecar pairs with documentation/references/REF-XXX-*.md (analysis doc) and
  documentation/radar/REF-XXX-radar.md (radar sidecar) — all three share the REF id.
- Outgoing is canonically 7 columns (`# | Title | Authors | Year | DOI/URL | Inducted REF |
  Confirmed by`); Incoming remains 6. Older sidecars without `Confirmed by` are valid;
  add it when the sidecar is next touched.
- Bidirectional consistency is enforced by the corpus audit (research-lint).
- The spoken-reference table is additive for time-based media and does not
  change existing paper citation sidecars.
-->
