# local-http direct profile (Ollama backend; local text-only HTTP transport)

roctinam/aiwg#2899 (B-OG-09). Status: **unqualified**. Registered under the
registry's generic, pre-reserved worker-adapter slot `workerAdapters.
local-http` (`agentic/code/providers/model-capabilities.v1.json`), the Ollama
backend of `$defs/http`'s `protocol: 'ollama'|'llama-cpp'|'openai-compatible'`.
Evidence captured on titan, ollama client/server **0.33.3**, shared systemd
service bound to `172.17.0.1:11434` (the Docker bridge, not loopback):
`.aiwg/working/s1-scratch/cli-help/ollama-titan.txt` (client/server version,
`GET /api/tags`, `GET /api/ps`, `ollama --help`, `ollama run --help`).

## Transport: curl to the HTTP API, not the `ollama` CLI

The shell client is `curl -q -sS --max-redirs 0 --proto '=http' --noproxy
'*' --connect-timeout 10 --max-time 300 --max-filesize 10485760
--fail-with-body -H "Content-Type: application/json" -X POST
http://<endpoint>/api/generate --data-binary @-`, not `ollama run`.
Evidence for that choice, all inside the capture:

- Captured `ollama run --help` gives `Usage: ollama run MODEL [PROMPT]`:
  the prompt is a positional argv argument, and no piped-stdin prompt form
  is evidenced in the captured help — so the CLI form cannot satisfy this
  profile's "brief via stdin, never argv" invariant.
- Captured `ollama --help` ships `pull` / `push` / `signin` subcommands: a
  broader registry/network surface than this text-only profile allows.

`/api/generate` (not `/api/chat`) matches the registry's pre-seeded
`generatePath` schema field — there is no `chatPath` in `$defs/http` — and
fits a single-prompt, text-only, no-tools role directly. The exact response
field set and the exact `done_reason` value vocabulary (only `"stop"` is
treated as success here) are **not independently observed** — no live call
was made against the real, shared service, which this task forbids — and
are documented as provisional.

Curl hardening (all flags verified in `curl --help all` 8.18.0 except as
noted): `-q` first so no curlrc is read; `--max-redirs 0` so no redirect is
followed (`curl --help all` lists no `--no-location` flag, so the explicit
redirect cap is used instead); `--proto =http` so only HTTP is allowed;
`--noproxy '*'` so proxy environment variables are never consulted;
`--connect-timeout 10` bounding the connect phase; `--max-time 300` bounding
the whole call; `--max-filesize 10485760` bounding the response (matches the
registry invocation `maxOutputBytes` default); `--fail-with-body` so HTTP
errors fail closed with their body preserved. The request body travels on
stdin via `--data-binary @-`, never argv. The OL09 conformance case proves
this end to end: with every proxy variable pointed at a dead endpoint and
a hostile `.curlrc` in `HOME`, the real `curl` argv still delivers the
request to the test-owned fake server.

## Endpoint

`OLLAMA_HOST` must be set to an explicit `host:port` and is validated as
canonical dotted-decimal IPv4 loopback or an RFC1918 private range only
(`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12` — covers the Docker-bridge
default, `192.168.0.0/16`). Each octet must match `^(0|[1-9][0-9]{0,2})$`
and be <= 255: leading-zero forms such as `010.0.0.1` are rejected (libcurl
would parse that as `8.0.0.1`). Hostnames, IPv6, userinfo and any other
address form are refused before the request is built. A stopped or
unreachable endpoint fails the `curl` call before any content is produced;
nothing is started.

A local endpoint restricts the request destination; it does not prove local
inference. That assurance stays **unqualified**: nothing here observes what
the server does with the prompt, which models it has installed, or whether
any server path downloads weights.

## Model selection

One conservative shared pattern, enforced identically by `buildWorkerArgs`
and `buildOllamaGenerateBody`: letters, digits, `._-`, one optional `:tag`,
at most 128 characters. Rejected: `auto`/`default` in any case, any
registry-style selector containing `/`, anything ending in `-cloud`/`:cloud`
(Ollama cloud selectors), and any option-like, whitespace-bearing or
control-character value.

## Invariants

| Invariant | Status |
|---|---|
| Explicit model, never inherited | met — `assertOllamaModelName` throws without one; `auto`/`default` refused |
| No cloud model selectors | met syntactically — `/`, `-cloud`/`:cloud` refused; local inference itself stays **unqualified** (see above) |
| Effort is null/not-applicable | met — any explicit effort throws (`capabilities.effort: 'not-applicable'`) |
| Text-only (no tools, no coding role) | met — the `coding` role is refused with a clear error and no tool-calling surface is implemented anywhere in this adapter |
| Non-interactive | met — one-shot HTTP POST, no prompts |
| Brief via stdin, never argv | **blocked in production** — see "Known gap: stdin framing" |
| Brief bounded | met — empty/whitespace briefs refused; brief UTF-8 bytes capped at 262144 (256 KiB, aligned with the shared brief bound in `src/serve/worker-stdin-frame.mjs` / `src/serve/worker-invocation.ts`) |
| Explicit local-only endpoint, no cloud destination | met syntactically — canonical IPv4 loopback/RFC1918 only; local inference stays **unqualified** |
| Curl ambient configuration | met — `-q`, `--max-redirs 0`, `--proto =http`, `--noproxy '*'`, `--connect-timeout`, `--max-filesize` (OL09 proves proxy env + hostile curlrc do not redirect the request) |
| Exit-zero-with-error fails closed | met — `--fail-with-body` + strict JSON parse of `done`/`done_reason`/`error`/`response` |
| Final-output extraction | met — the original envelope bytes are strictly validated (fatal UTF-8, byte bound against `maxOutputBytes`, no duplicate keys, bounded depth, exactly one object) before the `response` text is reparsed through the shared strict claims hook |
| `keep_alive` omitted | met — the body carries only `{model, prompt, stream:false}`; model residency is governed entirely by the server's own defaults |
| Health event grammar | **unavailable** — `observeHealthEvent` returns `null` (final-only; no streaming grammar implemented, `stream:false` is explicit) |
| Never pull weights / no cloud fallback | **unqualified** — the HTTP transport narrows the surface (no CLI pull path), but no evidence shows every server path avoids downloads |
| Model digest binding ("changed model/runtime/template invalidates role") | **unavailable** at argv-render time — see "Known gap: model digest" |

## Known gap: stdin framing — production dispatch is blocked

The frozen `src/serve/worker-stdin-frame.mjs` vocabulary (`stdin: 'closed' |
'brief-text' | 'brief-json'`) has no adapter-pluggable envelope that frames
an arbitrary brief into Ollama's `{model, prompt, stream}` body shape —
`'brief-json'` is hardcoded to OpenHuman's `{message, model_override, cwd}`
shape. The registry declares the closest existing fail-closed value,
`stdin: 'closed'`, with the `stdin` control `unqualified`, pointing at
roctinam/aiwg#2998 and #3002 (provider-supplied stdin frames / generated
artifacts). **This is proven through the real production resolver**, not
just asserted: `test/conformance/orchestration-v1/ollama-direct.test.ts`'s
LH03 case resolves a fully-qualified-except-stdin invocation and asserts
`resolveWorkerInvocation` refuses it with `Required worker control is
unqualified: stdin`. The adapter owns a pure request-body builder,
`buildOllamaGenerateBody({model, brief})`, exercised directly by tests to
prove the rendered `curl` argv is launchable once #2998/#3002 land.

## Known gap: model digest binding

"Changed model/runtime/template invalidates role" is **unavailable** at
`buildWorkerArgs` render time: the frozen `invocation.selected` shape
(shared by every adapter) carries only `{model, effort}`, no digest field.
`GET /api/tags` returns a `digest` per model (read-only, evidenced on
titan in the capture's models section), and the registry's generic
`WorkerModelObservation.provenance[].
digest` mechanism already exists for catalog-level staleness detection, but
wiring "changed digest invalidates role" into dispatch needs a
qualification/health step outside `buildWorkerArgs`, out of scope here.

## Known gap: declared vs. implemented invocation shape

The registry's descriptive `workerHealthAdapters.local-http` placeholder
(pre-seeded ahead of this issue) declares `invocation.kind: 'http'`
(`protocol`, `healthPath`, `modelsPath`, `generatePath`) — a native HTTP
fetch shape with no `executable`/`argv`/`stdin`, and no fetcher exists in
`session-launcher.mjs` to execute it. The bundled registry has **no active**
`workerAdapters.local-http` entry (the LH02 conformance case proves the
bundled file stays undispatchable): only the test-locally promoted copy
used by LH01/LH03 declares `invocation.kind: 'process'`
(`executable: 'curl'`, templated `argv`, `stdin: 'closed'`) — what is
actually implemented and dispatchable through the existing process-spawn
launcher today, modulo the stdin gap above. Nothing in this issue writes an
active entry back to the bundled registry file.

## Manual smoke run (after review, by the conductor)

One tiny prompt to the smallest installed model (`smollm2:135m`), against the
real, shared endpoint. The prompt travels on stdin, never argv; `pipefail`
so a `curl` failure is never masked by `tee`'s exit status:

```bash
set -o pipefail
d=$(mktemp -d)
MODEL=smollm2:135m
printf '{"model":"%s","prompt":"Reply with exactly: ok","stream":false}' "$MODEL" \
  | curl -q -sS --max-redirs 0 --proto '=http' --noproxy '*' --connect-timeout 10 \
    --max-time 300 --max-filesize 10485760 --fail-with-body \
    -H "Content-Type: application/json" -X POST \
    "http://172.17.0.1:11434/api/generate" --data-binary @- \
  | tee "$d/response.json"
```

Read pass/fail: the command must exit `0`, and `$d/response.json` must
parse as one JSON object with `"done":true`, `"done_reason":"stop"`, and a
non-empty `"response"`. Any `"error"` field, any non-zero exit, or a
`done_reason` other than `"stop"` is a fail.
