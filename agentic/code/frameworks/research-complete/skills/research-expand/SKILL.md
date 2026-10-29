---
namespace: aiwg
name: research-expand
platforms: [all]
description: Find papers similar to the corpus using seed-based Semantic Scholar recommendations and a ranked candidate queue
triggers:
  - "find papers similar to the corpus"
  - "expand the research corpus"
  - "recommend papers from corpus seeds"
commandHint:
  argumentHint: "[--seeds REF-0001,REF-0002 | --since YYYY-MM-DD | --all] [--max-seeds N] [--write]"
  category: research-discovery
---

# Research Expand

Find papers similar to the corpus without automatically inducting them or filing issues.

## Triggers

- "find papers similar to the corpus"
- "expand the research corpus"
- "recommend papers from corpus seeds"

## Instructions

1. Preview with `aiwg corpus expand --all --max-seeds 20 --json`. A scope is required: choose one of `--seeds REF-0001,REF-0002`, `--since YYYY-MM-DD` or `--all`. Without one, the command exits 1 and makes no requests. `--since` uses induction/discovery dates from reference or citation-sidecar frontmatter, then the reference document’s first-add date in the corpus repository’s Git history (following renames). Untracked files, corpora outside Git, or unavailable Git history fall back to document modification time; one summary warning reports how many REFs used that fallback. Fresh-clone mtimes do not override available Git dates.
2. Seeds come from arXiv or DOI frontmatter in references and citation sidecars; both `arxiv:` and `arxiv_id:` work. An arXiv body URL is a fallback. Version suffixes and old-style IDs use the shared research identity normalization.
3. Review the preview, then run with `--write` when the user requests persistence. Only `--write` writes files. Use `--max-seeds N` to resume a large first pass. Successful seeds stay explored for `--reexplore-after 180d`; throttled or failed seeds are retried next run. An immediate repeat of a completed run makes no API calls.
4. Recommendations use Semantic Scholar's paced, retrying client and `S2_API_KEY` when set. Defaults: `--per-seed 20`, `--from recent` (alternative: `all-cs`), `--min-year 2018`. `--overlap` optionally adds one graph lookup per top-20 candidate, with normal transport retries; it is off by default and cached in the queue.
5. Resolve the payload destination with `aiwg artifacts path --json --check-write`. Under its `artifact_root`, read `research/discovery/expansion-state.jsonl`, `candidates.jsonl`, `expansion-report.md`, and `rejected-candidates.jsonl`. An unavailable external root is an error; never substitute a local payload directory.
6. Rank candidates by distinct seed convergence, publication year, then optional in-corpus reference overlap. Queue rows include `paper`, `identity_keys`, `seed_refs`, `score_parts` and `discovery`. Dedup uses arXiv, DOI, S2 ID and normalized title against corpus, queue and rejected list. To dismiss a candidate, append its queue row, or a flat object such as `{"doi":"10.1234/example"}` or `{"title":"Paper title"}`, to `rejected-candidates.jsonl`. The next expansion removes matching queued rows and suppresses future matches.
7. Present the report and let the user select papers for `induct-research`. Never auto-induct and never auto-file intake issues. On an explicitly requested induction, preserve the queued provenance in the new citation sidecar with `aiwg corpus discovery-log --ref REF-XXXX --surface s2-recommendation --via "S2 recommendations for REF-0001, REF-0002" --write`.

## Examples

```bash
aiwg corpus expand --all --max-seeds 100 --write --json
aiwg corpus expand --seeds REF-0001,REF-0002 --from all-cs --per-seed 30
aiwg corpus expand --since 2026-10-01 --reexplore-after 180d --overlap
```

Exit codes: 0 complete, 3 incomplete with retryable failures, 1 usage/storage error. JSON results remain available on exit 3. A capped pass reports remaining seeds; run again with the same cap to continue.
