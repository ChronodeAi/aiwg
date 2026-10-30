# Research Framework

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You're doing academic or technical research. Finding papers manually is slow. Tracking what you've read and what it says is a spreadsheet nightmare. When you cite something, you're never sure you're representing the source correctly.

The research framework handles the mechanical parts: discovery, acquisition,
source-grounded notes, citation management, quality assessment, and archive
organization. You remain responsible for interpretation and final synthesis.

Each section below starts with what you can ask your assistant, then gives the command reference. Every command is kept exactly as shipped.

---

## Before You Start

Complete [Install, Connect, and Verify](install-connect-verify.md) first. If
you intentionally run a targeted deployment instead of the complete system,
`aiwg use research` remains the manual command for this framework.

The first useful result should be a traceable literature note, source list, or
corpus health report. Verify that claims cite stored source content before you
use them.

---

## The research workflow

```
discover → acquire → document → cite → assess quality → synthesize → find gaps → archive
```

Each stage has dedicated commands. Run them in sequence or jump to wherever you are.

---

## Finding papers

> "Find papers on transformer attention mechanisms. Return a prioritized list and tell me what is missing from my corpus."

Your assistant searches configured academic sources, ranks results by relevance and available metadata, and returns a prioritized list. The `discovery-agent` can compare the query with your existing corpus and surface likely gaps.

> "Limit it to open-access papers since 2023 and re-rank."

Your assistant re-runs the same search against the narrower scope.

### Command reference — finding papers

```bash
/research-discover "transformer attention mechanisms" --limit 20
```

Searches configured academic sources, ranks results by relevance and available
metadata, and returns a prioritized list. The `discovery-agent` can compare the
query with your existing corpus and surface likely gaps.

Filter by recency, citation count, or open access:

```bash
/research-discover "RLHF alignment techniques" --year-min 2023 --open-access-only
```

---

## Acquiring papers

> "Acquire the papers from the last result set into papers/. Flag anything paywalled instead of skipping it."

Your assistant downloads PDFs with Unpaywall integration for open-access versions, extracts metadata, validates against FAIR principles, and assigns persistent `REF-XXX` identifiers so later notes can refer back to stored sources.

### Command reference — acquiring papers

```bash
/research-acquire --from-results last --output papers/
```

Downloads PDFs with Unpaywall integration for open-access versions, extracts
metadata, validates against FAIR principles, and assigns persistent `REF-XXX`
identifiers so later notes can refer back to stored sources.

---

## Documenting papers

> "Document this paper from its PDF content and save a literature note I can cite later."

Your assistant uses RAG-based summarization against the actual PDF content — not from training data.

### Command reference — documenting papers

```bash
/research-document papers/attention-is-all-you-need.pdf
```

Uses RAG-based summarization against the actual PDF content — not from training data. Produces a structured literature note with:

- Key findings and contributions
- Methodology summary
- Limitations acknowledged by the authors
- Connections to other papers in your corpus
- GRADE quality assessment

This is the core citation-safety mechanism. The note should tie its claims to
source text stored in the corpus.

---

## Citation management

> "What paper does this reference mean: Vaswani et al. 2017, Attention Is All You Need? Resolve it against my corpus and do not guess."

Your assistant runs `aiwg corpus resolve` against stored sources. It reports ambiguous or unresolved instead of guessing.

> "Cite REF-042 in APA and check the citations in my draft for accuracy."

Your assistant generates the citation from stored metadata and flags anything that does not match.

### Command reference — citation management

```bash
/research-cite REF-042 --style apa
```

Generates properly formatted citations in 9,000+ styles from stored metadata. No manual formatting.

```bash
aiwg corpus resolve "Vaswani et al. 2017, Attention Is All You Need" --json
```

Resolves one quoted reference (title, URL, arXiv ID, DOI, or bibliography line) with optional `--year YYYY` and `--json`. Exit codes: 0 resolved, 2 ambiguous, 3 unresolved, 1 usage error. Ambiguous or unresolved results need review instead of guessing.

Check all citations in a document for accuracy:

```bash
/verify-citations path/to/paper.md
```

Flags citations that do not match stored source metadata or source content in
your corpus. Treat the result as a review queue for misquotes,
misattributions, and unsupported page references.

---

## Quality assessment

> "Assess the evidence quality of REF-042 and tell me how to hedge the citation if it is weak."

Your assistant produces a GRADE assessment with justification and hedging language.

Every paper gets a GRADE score (Grading of Recommendations, Assessment, Development and Evaluations):

- **High**: Systematic reviews, RCTs, large cohort studies
- **Moderate**: Smaller controlled studies, consistent observational evidence
- **Low**: Case reports, expert opinion, early-stage findings

### Command reference — quality assessment

```bash
/quality-assess REF-042
```

When you cite low-quality sources, the framework flags it and suggests appropriate hedging language. You can still use the source — you just do it honestly.

---

## Corpus health

> "How healthy is my corpus? Show me coverage, quality, and what needs verification."

Your assistant shows corpus statistics: total papers, quality distribution, coverage by topic, papers with incomplete metadata, and citations that need verification.

### Command reference — corpus health

```bash
/research-status
```

Shows corpus statistics: total papers, quality distribution, coverage by topic, papers with incomplete metadata, and citations that need verification. The `corpus-health` skill gives you a snapshot of where your research stands.

---

## Finding gaps

> "Find papers similar to my recent corpus entries on transformer fine-tuning. Preview the plan first and write nothing yet."

Your assistant runs `aiwg corpus expand` as a dry run. It needs a scope (`--seeds`, `--since`, or `--all`) and writes nothing unless you pass `--write`.

> "What is missing from my corpus on transformer fine-tuning approaches?"

Your assistant analyzes your corpus against the query topic to identify what's missing.

### Command reference — finding gaps

```bash
/research-gap "transformer fine-tuning approaches"
```

Analyzes your corpus against the query topic to identify what's missing — research questions that aren't answered by what you have, contradictions between sources that need resolution, and time periods with thin coverage.

```bash
aiwg corpus expand --since 2024-01-01 --per-seed 20 --min-year 2018
```

Previews similar-paper expansion without writing. A scope (`--seeds REF-0001,REF-0002`, `--since YYYY-MM-DD`, or `--all`) is required. The default is a dry run; add `--write` to save results. Other flags: `--from recent|all-cs`, `--reexplore-after 180d`, `--max-seeds N`, `--overlap`, `--json`.

---

## Synthesizing knowledge

> "Synthesize what my corpus says about attention mechanisms, with agreements and contradictions I should review."

Your assistant produces a synthesis note connecting related papers in your corpus.

### Command reference — synthesizing

```bash
/research-document --synthesize "attention mechanisms"
```

Produces a synthesis note connecting related papers in your corpus — agreements, contradictions, evolution of the idea over time. This is where individual literature notes become connected knowledge.

---

## Archiving the corpus

> "Archive my corpus with integrity verification so someone else can reconstruct the research process."

Your assistant packages the research corpus following OAIS standards.

### Command reference — archiving

```bash
/research-archive --verify-integrity
```

Packages the research corpus following OAIS standards: SHA-256 integrity verification, provenance tracking for all derivations, version control for notes, and reproducibility validation so anyone can reconstruct your research process.

---

## Key references

- `/corpus-health` — Corpus health report
- `/research-status` — Full research status dashboard
- `/grade-report` — GRADE quality distribution across corpus
- `@agentic/code/frameworks/research-complete/README.md` — Full framework documentation
