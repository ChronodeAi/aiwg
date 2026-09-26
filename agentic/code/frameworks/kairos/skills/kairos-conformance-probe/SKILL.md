---
name: kairos-conformance-probe
namespace: aiwg
platforms: [all]
description: Prove a live Kairos node behaves as its release documentation says by running the executable claim registry, recording a receipt, and emitting one finding per failed claim.
triggers:
  - kairos conformance probe
  - prove kairos works as documented
  - run kairos conformance baseline
  - check kairos after upgrade
commandHint:
  modelRole: coding
  modelTier: standard
---

# Kairos Conformance Probe

`claims/kairos-<version>.claims.json` holds executable claims. Each claim paraphrases one sentence of the release documentation (`PRODUCT.md`, `API.md`, `ARCHITECTURE.md`, `AGENT-SETUP.md`, `README.md`, `CHANGELOG.md`) and cites its `file:line`. `scripts/kairos_conformance.py` (Python 3.11+, standard library only) runs those claims against one node, then writes:

- a receipt (`kairos_conformance_receipt/v1`) under `.aiwg/kairos/conformance/<run_id>/receipt.json`;
- one `kairos_finding/v1` record per failed claim under `.aiwg/kairos/findings/`.

The registry schema is `schemas/conformance-claim.schema.json`. Findings conform to `schemas/finding.schema.json`.

A pass proves only that this node matched the cited sentence at run time. It certifies nothing about other nodes, profiles or releases.

## When to run

- **Connect gate (CG).** Run a read-only baseline as soon as the node is reachable and `/api/v1/meta` is recorded. Put the receipt path and its sha256 in the connection record.
- **Every Kairos release.** A new tag needs a new registry (`claims/kairos-<version>.claims.json`). By default the runner loads the file that matches the node's `/meta` version.
- **After an upgrade, restore, profile change** (auth, namespace policy, store backend), or anything else that restarts the node with a different configuration.
- **Before relying on a capability** in `kairos-operate`, for example observation replay, when that capability has no passing claim in the latest receipt for this node.
- **On a dogfood or throwaway node.** Run the full mutating suite with `--allow-mutation` and, if the node uses SQLite, the store and CLI claims too.

## Safety

- The runner is **read-only by default**. Without `--allow-mutation` it runs only claims marked `"mutates": false`. A claim counts as mutating if it creates fixtures, calls a write tool, records an observation, or exhausts a shared rate-limit bucket. KC-MCP-008 is a burst of 31 or more `POST /mcp` requests: it spends the node's per-IP write budget for a minute, and every local client shares that budget.
- Run `--allow-mutation` only against a node this project configured and may write to (`kairos-node-isolation`). Never use it against a production PostgreSQL node without the operator's sign-off. All writes land in a fresh namespace, `kairos-conformance-<utc>` (or `--namespace`). Every create carries an idempotency key derived from the run id, so rerunning a step replays it instead of duplicating it. The runner deletes nothing.
- The store claims (KC-STORE-*) run only when you pass `--sqlite-store`. They read the SQLite key table directly, and KC-STORE-002 backdates one key row by 25 hours. Pass `--sqlite-store` only for a throwaway node's own file.
- The bearer token is read from the environment variable named by `--token-env` (default `KAIROS_API_TOKEN`). It is never written to the receipt or to findings; reproduction commands reference `$KAIROS_API_TOKEN`.
- Read-only runs still send about 30 `POST` requests that write nothing: MCP calls such as `tools/list`, `validate-dag`, an oversized body that gets 413, and refused tool calls. They count against the node's per-IP write limit of 30 per minute. To leave room for other local clients, a read-only run spends at most 20 writes per minute (`--write-budget`). The runner also waits out any 429 it meets, up to `--max-rate-wait` seconds per request.

## Run

```sh
S=agentic/code/frameworks/kairos/skills/kairos-conformance-probe   # or the deployed skill directory

# Connect-gate baseline: read-only
python3 "$S/scripts/kairos_conformance.py" --node http://127.0.0.1:4101

# Full suite on a dogfood/throwaway dev node
python3 "$S/scripts/kairos_conformance.py" --node http://127.0.0.1:4131 --allow-mutation \
  --sqlite-store /path/to/throwaway/kairos.db --kairos-bin /path/to/venv/bin

# PostgreSQL profile with a Privy bearer (admin claims need an admin-role token)
KAIROS_API_TOKEN=... python3 "$S/scripts/kairos_conformance.py" --node https://kairos.example --allow-mutation

# Subsets, listing, re-checking one claim
python3 "$S/scripts/kairos_conformance.py" --node URL --list
python3 "$S/scripts/kairos_conformance.py" --node URL --only 'KC-LEARN-*' --skip KC-LEARN-009 --allow-mutation
```

| Option | Meaning |
|---|---|
| `--node URL` | Node base URL. Required. |
| `--token-env NAME` | Environment variable that holds the bearer (default `KAIROS_API_TOKEN`). |
| `--claims FILE` | Registry to run (default: `claims/kairos-<node version>.claims.json`). |
| `--namespace NS` | Write namespace (default `kairos-conformance-<utc>`). |
| `--out DIR` / `--findings-dir DIR` | Receipt directory and findings directory (defaults above). |
| `--only GLOB` / `--skip GLOB` | Select by claim id or area. Repeatable. |
| `--allow-mutation` | Also run mutating claims. |
| `--sqlite-store PATH` | Enable store claims on a SQLite node you own. |
| `--kairos-bin DIR` | Enable CLI claims (`kairos-observe`). |
| `--write-budget N` | Maximum write-method requests per minute from this runner. Defaults to 20 when read-only and unlimited with `--allow-mutation`. |
| `--max-rate-wait S` / `--timeout S` | Longest wait for 429s on one request, and the per-request timeout. |
| `--list` | Print the claims and exit. |

Exit codes: `0` means every executed claim passed (skips allowed). `1` means at least one claim failed. `2` means nothing failed but at least one claim errored. `3` means a usage error or an unreachable node.

## How claims run

The runner reads `/api/v1/health` and `/api/v1/meta` first, then derives the node's facts:

- the profile: `pg` when `store.backend` is `postgres`, `dev` when auth is off;
- whether admin access is available: through the development waiver, or through a bearer whose `GET /api/v1/auth/me` role is `admin`.

A claim is skipped, with the reason recorded, when:

- its `profile`, `requires_admin`, `requires` (`bearer`, `namespace_policy`, `sqlite_store`, `kairos_bin`) or `when_meta` guards do not hold;
- it mutates and `--allow-mutation` is off.

Fixtures (`fixtures.xtypes` and `fixtures.vectors`) are created only when a selected claim references them, in two retry-safe `execute-batch` calls. A referenced xtype always brings its declared out-edges, so a resolution sees the same graph whichever claims you select. Claims run in id order. Claims marked `run_last` (the rate-limit burst) run at the end.

## Reading the receipt

`receipt.json` records the following:

- `node`: URL, version, `/meta` sha256, profile, auth, store and policy facts, and how admin access was obtained;
- `claims_file`: path, sha256, registry version, and `version_match` against the node;
- `options`, `fixtures` (the ids created) and `requests_sent`;
- `results[]`, one entry per claim in execution order, with:
  - `status`: `pass`, `fail`, `skip` or `error`;
  - `reason` for a skip or error;
  - `steps[]`, each with its phase, the request excerpt (secrets redacted), the response status, the kept headers, a body excerpt and sha256, the timing, `rate_limit_wait_s`, a `reproduce` curl line, and every assertion with its expected and observed values;
  - `finding_id` for a failed claim;
- `summary`: totals, `by_area`, failed and errored claim ids, finding paths and the exit code.

How to act on each status:

- **fail**: the node answered, and its behaviour differs from the cited sentence. This is a Kairos finding, either a behaviour bug or documentation drift (`finding_kind: doc_drift`).
- **error**: the probe could not decide. A setup precondition failed, the transport broke, or the rate-limit wait was exceeded. Treat it as a probe defect until you have proven otherwise. Never file an error as a Kairos issue.
- **skip**: the claim does not apply to this node or run. Read `reason`.
- Claims tagged `known_gap` (for example C1 and C4) are expected to fail on v2.1.1. They still produce findings, and the triager comments on the existing issue instead of filing a new one.

## Failures flow into kairos-feedback

1. Each failed claim writes `.aiwg/kairos/findings/KF-<claim>-<fp12>.json`. It carries the following fields:
   - `command`: the runner rerun line plus curl reproductions;
   - `output`: an excerpt and its sha256;
   - `doc_citation`: the file, the lines and the `tag@commit` ref;
   - `expected` (the claim statement) and `observed` (every failed assertion, with fixture ids replaced by fixture names);
   - `node`: the URL, version, profile and `/meta` sha256;
   - `sources`: the doc sha256 and the registry sha256;
   - `assertion_signatures` and `fingerprint`;
   - `receipt`: the receipt path and its sha256;
   - `status: open`;
   - `body`: a Markdown issue body that includes the fixture graph.
2. The fingerprint is `sha256("kairos_finding/v1|<claim_id>|<surface>|<doc>:<line>|<sorted assertion signatures joined by ;>")`. Signatures use unrendered JSON paths, so the same defect produces the same fingerprint on every run and every node.
3. The `kairos-feedback-triager` runs `kairos-feedback`:
   - `kairos-records.mjs fileable` gates each finding;
   - duplicates are found by fingerprint, then claim id or known gap;
   - the issue is filed on `ChronodeAi/kairos` (MCP or app, then the HTTP API, then the `gh` CLI; never on a mirror);
   - the finding is updated to `filed` or `duplicate`.
4. Rerun the single claim (`--only KC-...`) to confirm a fix. The same fingerprint that no longer appears closes the loop.

## Maintaining the registry

- Build a new registry for each Kairos release. Take claims from `PRODUCT.md` first, then `API.md`, `ARCHITECTURE.md`, `AGENT-SETUP.md`, `README.md` and the release's `CHANGELOG.md` entries. Refresh `docs[].sha256` from the tag, and validate the registry against `schemas/conformance-claim.schema.json`.
- Keep claim ids stable across releases when the sentence survives. Retire an id when its sentence is removed; never reuse it.
- Never edit an assertion to make a claim pass. Change an assertion only to fix a probe defect, with evidence that the probe, not Kairos, was wrong: a request shape outside the documented contract, a precondition the probe failed to establish, or an interfering claim.
- Probe the documented contract, not the implementation. When the code needs an undocumented precondition (for example `expected_version` on PATCH and DELETE), write two claims: one that exercises the documented request, and one that uses the precondition to test the rest of the behaviour.

## v2.1.1 baseline

These results come from a clean throwaway dev node (SQLite, auth off, admin waiver) with `--allow-mutation --sqlite-store --kairos-bin`. Of the 80 claims, 63 passed, 12 failed, 5 were skipped (pg-only) and none errored. A read-only run against a dev node passed 22, failed 5 (the five read-only rows marked R below) and skipped 53. Each failed claim is a Kairos finding. The fingerprints are stable across runs and nodes.

| Claim | Doc | Observed on 2.1.1 | Kind |
|---|---|---|---|
| KC-RES-004 | `PRODUCT.md:28` | A causal edge with `{"locale": "en"}` is admitted under `locale: fr` and under `{}`, so its parameters are ignored | conformance, high |
| KC-RES-013 | `API.md:625` | An empty context also admits adaptive, causal and parameterless contextual edges | conformance |
| KC-RES-017 | `src/server/models/resolution.py:227` | `trace` is `[]` for a resolution that admits six edges (C1) | conformance |
| KC-CAUSAL-004 | `API.md:1094-1099` | `diff` values are `[factual, counterfactual]` pairs, not numeric differences | conformance |
| KC-HTTP-001 (R) | `API.md:186-196` | HSTS is `max-age=63072000; includeSubDomains; preload` | conformance |
| KC-HTTP-004 (R) | `API.md:226-236` | The 404, 422, 400 and 405 bodies are `{"detail": ...}`, not `{"error": {...}}` | conformance |
| KC-HTTP-006 (R) | `API.md:298` | `/metrics` carries `X-RateLimit-*` headers | conformance, low |
| KC-RES-007 | `PRODUCT.md:54` | An edge with weight exactly 0.618 is not admitted, because the threshold is φ⁻¹ = 0.6180339… (C4) | conformance, low |
| KC-XTYPE-006 | `API.md:468-484` | PATCH and DELETE `/xtypes/{id}` and DELETE `/vectors/{id}` answer 428 `missing_expected_version` | doc_drift |
| KC-RES-012 (R) | `API.md:620-622` | The documented example context `{"role": "admin"}` gets 422 `extra_forbidden` | doc_drift, low |
| KC-VEC-003 | `API.md:545` | `vector_type: service_chain` is accepted (201) | doc_drift, low |
| KC-META-007 (R) | `PRODUCT.md:80` | `/api/v1/meta` exists (added in 2.1.0) | doc_drift, low |

## Outputs

- A receipt under `.aiwg/kairos/conformance/<run_id>/`.
- Findings under `.aiwg/kairos/findings/`.
- An exit code that the connect gate records.

## Continue or hold

- **Continue** to `kairos-propose-graph` when the connect-gate baseline shows the following:
  - no errors;
  - every failure has a finding;
  - no failure touches a capability the pilot plan depends on.
- **Hold** the operate phase when a claim that `kairos-operate` depends on fails, and record the decision in the pilot report. Those claims cover observation replay, conflict and receipts (KC-LEARN-004..008) and causal non-mutation (KC-CAUSAL-001).
