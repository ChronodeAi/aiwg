<!-- Detailed per-source analysis and verification gates for induct-research. -->

### Phase 2.5: Per-Source Analysis (on full content)

Only after full content is acquired, run analysis:

**For PDFs / full papers** (with full text available):
- Read the **full extracted text**, not just the abstract
- Extract title, authors, year, abstract, methodology, key findings, limitations
- Identify key claims with specific evidence (quotes, figures, tables)
- Assess relevance to existing corpus (check `.aiwg/research/` for related REF-XXX files)
- Assign GRADE quality level (A–D) based on source type and peer-review status
- Target: analysis docs should be 150-300 lines with substantive content from the paper

**For web sources** (with full content saved):
- Read the full saved page content
- Extract key points, methodology if applicable, credibility indicators
- Assess relevance and quality

**Quality gate**: If the resulting analysis doc is under 80 lines, flag it as a potential
stub. Either the source content wasn't fully read or the analysis was superficial.
Consider re-running with explicit instructions to read the full text.

#### Cheap-verification gate (stated uncertainty is not a terminal state)

Honest limitation sections are good, but they are the **residue after cheap checks**, not a
substitute for them. An induction that completes while carrying "no OpenReview query was
run" has not declared a limitation — it has skipped a one-request check and described the
skip. That reads as diligence and is a provenance gap.

**Rule.** Before writing any statement of the form *"X was not checked / not retrieved /
not queried / is unverified / rests on Y rather than an independent record"*, either:

1. **Resolve it**, if resolving costs roughly one request against a known endpoint; or
2. **Record why it is not cheap** — endpoint unknown, rate-limited after N attempts with
   backoff, requires a credential, behind an anti-bot wall, paywalled — naming the
   specific obstacle.

"I did not check" is not an acceptable terminal state on its own. "I could not check,
because `pubpeer.com` returns HTTP 403 to this client" is.

**The four cheap checks to run by default.** Named explicitly because agents do not reach
for them unprompted:

- **Venue confirmation.** If `source_type` is `peer_reviewed_*` on the strength of an arXiv
  comment or a LaTeX template, confirm against an independent record — OpenReview, ACL
  Anthology, PMLR, DBLP — before asserting it. **A conference template is not evidence of
  acceptance.** If confirmation fails, demote to `preprint` rather than asserting the venue.
- **Published version.** Once a peer-reviewed venue is confirmed, fetch the camera-ready and
  archive it alongside the preprint. Record the diff — page count, extracted-text size,
  occurrence counts for the doc's own headline claims — so a reader knows whether the
  analysis needs re-reading. "Materially identical, no analysis changed" is a *finding*;
  assuming it is not.
- **Asserted URLs.** Probe every code, project and dataset URL the document asserts. An
  originating issue carrying a wrong GitHub URL is a normal occurrence, and nothing else in
  this flow would catch it.
- **Retraction and citation census.** Run both by default. OpenAlex (`is_retracted`,
  unauthenticated) and Semantic Scholar (`citationCount`, `influentialCitationCount`) are one
  call each. Record the source and the date, and **record a null result as a null result**
  — `is_retracted: false, OpenAlex, 2026-09-12` — never as the absence of a check. A census
  also does real work: a high influential-citation count independently corroborates a GRADE
  assignment and can reframe in-corpus sidecars that reference the work.

  **Use OpenAlex for `is_retracted` only — never for counts.** It indexes the preprint and
  published records separately and does not merge them; an 18x undercount has been observed
  (178 vs 3,205 for the same paper). It is the obvious fallback when Semantic Scholar
  throttles, and substituting it records wrong counts with no error and no signal. Never
  swap in a count source without calibrating it against a known-high-count paper first.
  Semantic Scholar throttles hard enough that misses are expected — record a miss as a miss
  rather than substituting an uncalibrated source. Per-service operating characteristics,
  failure modes, and API-key handling:
  [`bibliographic-services.md`](../../../docs/bibliographic-services.md).

**Register the residue as a check, not as prose.** Any uncertainty that survives the gate
must be recorded as a declared check with an outcome, so it lands as `incomplete` or
`blocked` per [`verification-contracts.md`](https://github.com/jmagly/aiwg/blob/main/docs/verification-contracts.md)
instead of as narrative an automated reader cannot see.

The `research/uncertainty-registered` lint rule checks this on induction output: it flags a
clause stating an unperformed action against a verification target with no obstacle named
nearby. It is a prose heuristic, so it runs at `warn` — on a 2,544-reference corpus it
flagged 34 clauses, of which roughly 31 were genuine, including every gap a hand audit had
found independently. Run it with the rest of the research ruleset:

```bash
aiwg lint <corpus-root> --ruleset research
```

**Worked example.** The same uncertainty, stated three ways:

| Statement | Verdict |
|-----------|---------|
| "ICLR 2024 attribution rests on the arXiv comment and the `iclr2024_conference` template. No OpenReview or proceedings query was run." | **Not acceptable alone.** One query against a known endpoint was available and skipped. |
| "OpenReview queried 2026-09-12; acceptance confirmed as ICLR 2024 poster (plus an ATTRIB workshop listing)." | **Acceptable** — resolved. |
| "PubPeer not checked — `pubpeer.com` returns HTTP 403 to this client." | **Acceptable** — named obstacle, correctly not cheap. |

Scope note: this gate is about *cheap* checks. It does not ask for exhaustive verification,
and "expensive, and here is the specific reason" remains a valid outcome.

#### Bibliography ground truth (what the paper actually cites)

Citation edges and reference counts come from the **compiled** bibliography. For arXiv
e-print sources the shipped `.bib` is the author's *library*, not the paper's reference
list: it routinely contains entries that were never cited. Treating it as the membership
set fabricates edges and inflates counts.

**1. Authoritative sources, in order of preference:**

1. `.bbl` — `\bibitem` for natbib/plain, `\entry{}` for biblatex. What the paper printed.
2. `\begin{thebibliography}` inline in the `.tex`, when no `.bbl` ships.
3. The reference list in the extracted PDF text.
4. The shipped `.bib` — **only** to enrich metadata for entries already confirmed present
   by 1–3. Never as the membership set.

A 15-entry gap between a shipped `.bib` (81) and its compiled `.bbl` (66) is ordinary, not
a sign of a broken artifact.

**2. Counts come from counting entries in the compiled bibliography.** Count `\bibitem` /
`\entry` occurrences. Never use `.bib` size, and never sum artifacts — summing `.bib` and
`.bbl` without dedup has produced counts inflated by 2–3x (209 claimed vs 100 actual; 38 vs
12). **Record the counting method alongside the number**, and note printed-vs-unique where
they differ (92 printed, 90 unique).

**3. Confirm every asserted edge against the printed entry** — not by title similarity
against a corpus index. Record *how* each edge was confirmed: arXiv ID, exact title, or
printed-entry read.

Two failure modes title matching cannot catch:

- **Author-year collisions.** "Zou et al. 2023" may be GCG *or* Representation Engineering —
  same first author, same year, different work. Author-year and fuzzy-title resolution both
  land on the wrong node. Only reading the printed entry disambiguates.
- **Brace-escaped titles.** `{AI}`, `{Prompt}-{Driven}` defeat naive matching; normalise
  before comparing.

**4. Record rejections.** When a candidate edge is dropped because it is `.bib`-only, say so
in the sidecar. This stops a later extraction pass silently reintroducing it.

**Tooling.** `tools/research/bibliography-resolver.mjs` applies this hierarchy mechanically
against an e-print source directory — it picks the authoritative artifact, counts entries
with the method recorded, normalises brace-escaped titles, resolves against a corpus
`REF<TAB>title<TAB>arxivId` index, and lists `.bib`-only rejections:

```bash
node tools/research/bibliography-resolver.mjs <source-dir> --index <corpus-index.tsv> [--json]
```

Per entry it reports `title`, `year`, `arxiv`, `ref`, and `confirmedBy` — one of
`arxiv-id`, `exact-title`, or `unresolved`. An unresolved entry carries `ref: null`,
never an empty string. When a printed title matches more than one corpus REF (the
corpus inducts some works twice), it resolves to the lowest REF and lists the twins in
`ambiguous` so the `Confirmed by` choice is auditable rather than silent. It reads
acl_natbib `\href {url} {Title}`, biblatex `\field{title}`, plain natbib, ACM
`\showarticletitle`, and brace-delimited `.bib` fields; venue strings such as
"ArXiv preprint" are never returned as titles.

It refuses to answer from a `.bib` alone. When only `.tex` + `.bib` ship it uses the cited
keys, which is what BibTeX itself would print — the hierarchy's four levels have no answer
for that case, and it is common: one real paper shipped 80,568 `.bib` entries and cited six
works. Prefer the tool over re-deriving the rules per batch, and record its `countMethod`
verbatim.

**5. Direction is a check, not an assumption.** Publication dates bound edge direction: a
work cannot cite something published after it. Assert this explicitly — sidecars have
shipped with outgoing edges to works published up to three years *later*, incoming edges
from works that predate the paper, and edges to papers the work does not cite at all.

---

