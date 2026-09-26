---
name: kairos-feedback
namespace: aiwg
platforms: [all]
description: Turn evidence-complete Kairos findings into deduplicated ChronodeAi/kairos issues or comments, never filing without the evidence fields.
triggers:
  - file kairos feedback issue
  - report kairos findings
  - kairos bug report
  - send conformance findings to kairos
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Kairos Feedback

## Inputs

Findings under `.aiwg/kairos/findings/*.json` (schema `kairos_finding/v1`, from `kairos-conformance-probe` or recorded by hand during pilot work), the connection record, and a GitHub identity allowed to open issues on `ChronodeAi/kairos`. Rule: `kairos-feedback-evidence`.

## Workflow

1. Gate each finding. Only an `OK` finding may be filed; anything else stays `open` with its missing fields listed:

   ```sh
   node "$FW/scripts/kairos-records.mjs" fileable .aiwg/kairos/findings/*.json
   ```

   `fileable` fails on a missing command, output, doc citation, expected or observed; identical expected and observed; a fingerprint that does not match the documented recipe; a credential in the record; or a status other than `open`.
2. Pin the target. File only on the canonical repository, never on a fork, mirror, local clone or other tracker:

   ```sh
   gh repo view ChronodeAi/kairos --json nameWithOwner,isFork,isMirror,isArchived,hasIssuesEnabled
   # must be {"nameWithOwner":"ChronodeAi/kairos","isFork":false,"isMirror":false,"isArchived":false,"hasIssuesEnabled":true}
   ```

3. Deduplicate before writing anything. Search by fingerprint first, then by claim id or known gap, then by title terms:

   ```sh
   FP=$(node "$FW/scripts/kairos-records.mjs" fingerprint .aiwg/kairos/findings/KF-C1-resolve-trace-empty.json | cut -d' ' -f1)
   gh issue list --repo ChronodeAi/kairos --state all --search "$FP in:body" --json number,title,url,state
   gh issue list --repo ChronodeAi/kairos --state all --search "resolve trace in:title,body" --json number,title,url,state
   ```

   A match means comment, not file: add the new node version, command and output to the existing issue, then set the finding to `status: "duplicate"` with `issue {repo, number, url, filed_via: "existing"}`. Findings with `known_gap` (C1, C2, C4, C6) are expected to match an existing issue; if none exists, file one and cite the gap id.
4. Render the body (sections of the repository's bug-report form: Description, Steps to Reproduce, Environment, Relevant Logs; the fingerprint is the last visible line and an HTML comment):

   ```sh
   node "$FW/scripts/kairos-records.mjs" issue-body .aiwg/kairos/findings/KF-C1-resolve-trace-empty.json > /tmp/kf-body.md
   ```

   Title `<surface>: <discrepancy>`. Labels `bug` and `triage`; `documentation` for `doc_drift`. The body names the node origin only when it is loopback and never includes a token.
5. File through the first available route, in this order:
   1. **MCP or app**: a GitHub MCP server or GitHub app tool in the session (for example `search_issues`, `create_issue`, `add_issue_comment` with owner `ChronodeAi`, repo `kairos`).
   2. **HTTP API**: `GH_TOKEN` in the environment, sent through a file descriptor:

      ```sh
      python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "body": open(sys.argv[2]).read(), "labels": ["bug","triage"]}))' "rest: POST /api/v1/resolve returns an empty trace" /tmp/kf-body.md > /tmp/kf-issue.json
      curl -fsS -X POST https://api.github.com/repos/ChronodeAi/kairos/issues \
        -H @<(printf 'Authorization: Bearer %s\n' "$GH_TOKEN") -H 'Accept: application/vnd.github+json' \
        --data @/tmp/kf-issue.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["number"], d["html_url"])'
      ```

   3. **gh CLI**: `gh issue create --repo ChronodeAi/kairos --title "<title>" --body-file /tmp/kf-body.md --label bug --label triage`.

   Stop at the first route that works; never file the same finding through two routes. Comments use the same order (`add_issue_comment`, `POST /repos/ChronodeAi/kairos/issues/<n>/comments`, `gh issue comment <n> --repo ChronodeAi/kairos --body-file ...`).
6. Record the result on the finding as a new version: `status: "filed"`, `issue {repo: "ChronodeAi/kairos", number, url, filed_via, filed_at}`. Re-validate.
7. List what was filed, commented and held in the pilot report.

## Outputs

Filed or commented issues on `ChronodeAi/kairos`, findings updated to `filed` or `duplicate`, and held findings with their missing evidence.

## Continue or hold

Never auto-file a finding that fails `fileable`. Never bundle unrelated findings into one issue. If no route can reach the tracker, keep the rendered bodies under `.aiwg/kairos/findings/pending/` and report that filing is blocked; do not post to another repository instead.
