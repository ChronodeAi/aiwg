---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.sensitive-values
---

# Supplying sensitive values

Use terminal entry when available, then stdin, a private file, a named operating-system store entry, and a named shell variable last. Pass references on the command line; keep the value itself off it. The inventory below distinguishes commands using the shared resolver from compatibility sources that still need migration.

## Standard input methods

For an adopted command, replace `<prefix>` with `api-key` for `mcp profile login`, `token` for `decision setup jev`, or `value` for `auth secret set`.

| Preference | Input | What it exposes |
| --- | --- | --- |
| 1 | No source flag with a terminal, or `--<prefix>-interactive` | AIWG reads an entry without terminal echo. The value lives in AIWG memory and reaches the intended recipient only. Terminal/session recording and software running as your user remain part of the trust boundary. |
| 2 | `--<prefix>-stdin` | A pipe carries the value into AIWG memory. The source process and AIWG can read it; the value does not enter argv or the shell environment. |
| 3 | `--<prefix>-file <path>` | The path is visible on argv; the content remains on disk. On supported POSIX hosts, AIWG requires a regular file owned by the current user with no group/other access, and rejects symlinks and multiple hard links. Use mode `0600` or `0400`. Windows file input fails closed until native ACL validation is available; use stdin or the native store there. |
| 4 | `--<prefix>-store <name>` | Only the entry name appears on argv. The existing native store used by `aiwg auth login` protects the value at rest: macOS Keychain, Windows Credential Manager, or Linux Secret Service. Store availability, unlock state, and your user account govern access. |
| 5 | `--<prefix>-env <NAME>` | Only the variable name appears on argv. The invoking shell and its other children can inherit the value, and process/environment inspection can expose it. AIWG keeps it out of unrelated child environments. |

An explicit source bypasses the terminal question. The shared resolver orders explicitly requested terminal entry, stdin, file, store, then environment. All adopted commands apply this precedence when several sources are selected. With no explicit source, a terminal selects entry. A selected but missing, empty, invalid, or inaccessible source fails; it does not silently fall through to a less preferred source. Without a terminal and without an input source, the command errors and names its source flags. Piped data requires the stdin flag, so a headless command never guesses whether stdin is a credential or other input.

For example, pipe a manager's output directly into either adopted command:

```bash
vault read -field=key secret/openai | aiwg mcp profile login ops --api-key-stdin
op read 'op://Engineering/Jev/api-key' | aiwg decision setup jev --token-stdin --verify
```

Use a private file or an existing named store entry when a pipe is unsuitable:

```bash
aiwg mcp profile login ops --api-key-file "$HOME/.config/aiwg/openai-key"
aiwg decision setup jev --token-store jev-production --verify
aiwg mcp profile login ops --api-key-store openai-production
```

Named raw values use service `aiwg.sensitive-values` and account `<name>` in the existing native store. These entries are separate from the OAuth access/refresh pair created by `aiwg auth login`. Save a value once through the existing auth command, then refer to its name in day-to-day commands. Repeating `set` replaces the entry; `delete` removes it:

```bash
op read 'op://Engineering/OpenAI/api-key' | aiwg auth secret set openai-production --value-stdin
aiwg auth secret delete openai-production
```

Do not type a value into an `export` statement or a command argument: shell history may retain it. Never enable shell tracing around credential-producing commands.

## Child-process boundaries

`NODE_DEBUG=child_process` can print spawn arguments and the complete child environment. A secret-free argv is insufficient if a helper inherits the shell environment. Adopted boundaries use an explicit allowed-variable list: native-store helpers, OAuth browser launch, Codex profile login, MCP nested AIWG calls, Muse version/Grok inspection probes, setup and deployment/config/index helpers, and the update notifier. Generic script-runner, refresh, Ralph/provider session children, daemon workers and package Git clones still need separate recipient-specific review. The MCP login key reaches `codex login --with-api-key` through stdin. Its output is bounded and redacted before AIWG displays it. Jev verification uses an in-process HTTP request. Private-file contents and resolved store values never belong in errors or status output.

A provider or authenticated service may be the intended credential recipient. Its authentication channel is part of that command's contract; the short helper environment must not be confused with permission to forward every shell variable. The inventory's deferred rows do not yet promise the adopted commands' complete source or child-debug protections.

## Sensitive-input inventory: #3079 slice 1

The “existing input” column records the implementation before this slice; the last column records adoption. A row covers all commands sharing the named owner, including aliases. Public keys, signing-key identifiers, credential reference names, and provider-presence checks are not secret values.

| Command / option or configured surface | Sensitive value and existing input | Source owner | Slice status / remaining work |
| --- | --- | --- | --- |
| `aiwg mcp profile login <name>`; `--api-key-stdin`, `--api-key-file`, `--api-key-env` | API key from explicit stdin, owner-only regular private file, or named environment variable; no-source TTY path delegates OAuth to Codex. | `src/mcp/cli.mjs`, `src/mcp/adapters/codex-runtime.ts` | Adopted: shared resolver adds `--api-key-store`, masked terminal entry and shared source precedence. |
| `aiwg decision setup jev`; `--token-stdin` | API key from explicit stdin, then `JEV_API_KEY` / `AIWG_DECISION_JEV_API_KEY`; no terminal prompt; persists private `jev.json`. | `src/cli/handlers/decision.ts`, `src/decision/ask.ts` | Adopted: shared resolver adds `--token-file`, `--token-store`, `--token-env`; environment selection is explicit (`--token-env JEV_API_KEY`); existing runtime environment lookup is unchanged. |
| `aiwg init`, `aiwg setup project`, `aiwg setup --apply`; `--credential <provider>=env:NAME\|file:PATH\|store:NAME\|stdin`, `--token-stdin` | Provider/Jev API input: references saved in plans, bytes resolved only at apply from named environment, file, stdin or masked prompt; Jev is handed to setup on stdin. | `src/discovery/plan-apply.ts`, `src/cli/handlers/setup.ts`, `src/cli/handlers/guided-setup.ts` | Adopted: existing plan references and apply IO use shared resolution; `store:NAME` extends the same schema. `stdin` can prompt at a terminal or read explicit piped input at apply. |
| `aiwg auth login`, `auth status`, `auth logout`; `--device`, `--store file --allow-file-store` | Login obtains OAuth access/refresh tokens over HTTPS and saves them in the native store; status/logout read that entry. Explicit file fallback stores private JSON. No raw token CLI argument. | `src/auth/client.ts`, `src/auth/credential-store.ts`, `src/cli/handlers/auth.ts` | Existing OAuth owner retained; native helper child environment hardened. Named raw-value set/delete uses the same auth command family. |
| `aiwg auth secret set <name>`; `--value-interactive`, `--value-stdin`, `--value-file`, `--value-store`, `--value-env`; `auth secret delete <name>` | Named raw values saved in the existing native store, separate from the OAuth entry. | `src/cli/handlers/auth.ts`, `src/auth/sensitive-input.ts`, `src/auth/credential-store.ts` | Adopted: same five sources and headless refusal; save/delete never prints the value. |
| `aiwg discover`, `show`, `resource-versions`, `use`, and artifact web-resource resolution | Protected release bearer: `AIWG_RESOURCE_TOKEN_FILE`, then `AIWG_RESOURCE_TOKEN`, then the auth store access token. File checks regular/non-symlink and private mode. | `src/auth/config.ts`, `src/auth/resource-credentials.ts`, `src/artifacts/cli.ts` | Deferred: implicit/optional release lookup must preserve public/offline behavior while adding source arguments. |
| `aiwg decision ask` and enabled live decision consumers | Jev key from `JEV_API_KEY` / `AIWG_DECISION_JEV_API_KEY`, otherwise `~/.config/aiwg/credentials/jev.json`; private file and directory modes checked. | `src/decision/jev-credentials.ts`, `src/decision/ask.ts` | Deferred: setup input is adopted; runtime lookup still uses the established credential record. |
| `aiwg mcp add`, `mcp update`; `--env`, `--headers`, `--args`, registry import/config; `--header-env`, `--env-from` | Literal environment/header/argument values can contain secrets; named environment references avoid literals in registry. Credential policy restricts persisted/rendered values. `mcp inject`, `mcp install`, `session --mcp` and profile launch consume that registry. | `src/mcp/cli.mjs`, `src/mcp/credentials.mjs`, `src/mcp/registry.mjs` | Deferred: multi-value registry migration; legacy literal flags expose values on argv. Prefer references and the existing credential policy. |
| `aiwg install <github:…\|gitea:…>` and `marketplace` Git adapter fetches | `GITHUB_TOKEN`, then `~/.aiwg/credentials/github`; `GITEA_TOKEN`, then `~/.config/gitea/token` / `~/.aiwg/credentials/gitea`; otherwise SSH agent. Token is embedded in HTTPS clone URL. | `src/packages/adapters/github.ts`, `src/packages/adapters/gitea.ts`, `src/packages/adapters/git.ts` | Deferred, security priority: remove token-bearing clone argv and use the shared resolver before claiming this family safe under child debug logging. |
| `aiwg marketplace publish`; `--key <pem>` | Ed25519 private PEM read directly from the named file. `--public-key`, `--key-id`, and setup `--signing-key` are public material/identifiers. | `src/cli/handlers/marketplace.ts`, `src/marketplace/exchange.ts` | Deferred, security priority: private-file validation and multiline signing-material support need adoption. |
| `aiwg effect` signed writes, `effect keys init\|rotate`; configured host key provider | Signing keys generated internally and loaded from native secret store, or explicitly selected private file. Test-only environment fixture is restricted to test context. | `src/cli/handlers/effect.ts`, `src/effects/` | Existing key lifecycle retained; native helper child environment hardened. No externally supplied raw-key option to migrate. |
| `aiwg cost-report`; `--key <key_ref>`, `--fleet`, `--config` | OpenRouter API key from `AIWG_OPENROUTER_KEY_<KEY_REF>` first, otherwise owner-only regular file in private `~/.config/aiwg/keys/`; fleet YAML contains references only. | `src/cost/fleet-report.ts`, `src/cli/handlers/cost-report.ts` | Deferred: named reference owner must gain shared source lookup, preserving per-key fleet isolation. |
| `aiwg issue import --live`, `issue export --live` | Tracker bearer from `AIWG_GITEA_TOKEN` / `GITEA_TOKEN`, or `AIWG_GITHUB_TOKEN` / `GITHUB_TOKEN`; passed to in-process HTTP client. | `src/issues/live.ts`, `src/issues/cli.ts` | Deferred: add standard source selection to the established live-client owner. |
| `aiwg local-executor serve` | Optional `AIWG_EXECUTOR_TOKEN`; otherwise registration obtains and persists an executor bearer token for restarts. | `src/cli/handlers/local-executor.ts`, `tools/ralph-external/executor-shim.mjs` | Deferred: optional preexisting token and generated-token lifecycle require separate handling. |
| Daemon startup, web UI, inbound webhooks and messaging adapters | Web token from config or `AIWG_WEB_TOKEN`; webhook `secret_env` names a shell variable (default `AIWG_WEBHOOK_SECRET`); Telegram/Discord/Slack tokens and Slack webhook URL from adapter config or `AIWG_TELEGRAM_TOKEN`, `AIWG_DISCORD_TOKEN`, `AIWG_SLACK_BOT_TOKEN`, `AIWG_SLACK_WEBHOOK_URL`. | `tools/daemon/daemon-main.mjs`, `tools/daemon/config.mjs`, `tools/messaging/adapters/` | Deferred: daemon config has multiple independent secret recipients; migrate references through its existing loader. `daemon-init` scaffolds references only. |
| `aiwg storage test\|migrate\|import-corpus` and every operation using configured remote storage | Logseq `LOGSEQ_API_TOKEN`; Fortemi MCP registry header/env references or legacy literal headers; PostgreSQL configured `connectionStringEnv` (default `AIWG_POSTGRES_URL`); PostgREST configured `authorizationEnv`. | `src/storage/backends/logseq.ts`, `fortemi.ts`, `postgres.ts`, `postgrest.ts` | Deferred: backend-specific multi-credential/configuration lookup must adopt resolver without changing storage routing. |
| `aiwg uhp harnesses\|models\|run` and authenticated UHP API consumers; `--profile` | Named profile's `credential.source: env` and `credential.name` resolved at request time. Inline profile credentials rejected. Discovery is unauthenticated. | `src/uhp/config.ts`, `src/uhp/client.ts` | Deferred: extend the existing credential locator owner. |
| `aiwg agentcard verify`; `--bearer <token>` | Optional bearer supplied literally on argv, forwarded as an HTTP bearer for the card endpoint. | `src/cli/handlers/agentcard.ts`, `src/a2a/agent-card.ts` | Deferred, security priority: replace literal bearer input with shared source flags while retaining optional unauthenticated card access. |
| `aiwg diagnose`; `--include-secrets`, `--stdout` | Reads environment and local configuration/log files for a support bundle. Default sanitizes sensitive environment/config fields; `--include-secrets` intentionally disables sanitization and `--stdout` prints the bundle. | `src/cli/handlers/diagnose.ts` | Deferred diagnostic exposure surface: a resolver does not protect secret bytes already present in collected files/environment; preserve explicit opt-in and review output before sharing. |
| `aiwg mcp serve --toolsets sandbox` | Management bearer read from `AIWG_SANDBOX_MANAGEMENT_TOKEN_FILE`; regular/private mode checked. | `src/mcp/tools/agentic-sandbox.mjs` | Deferred: shared file checks and store reference lookup. |
| `aiwg session`, worker dispatch, Ralph and mission provider execution | Provider-owned login files and provider-specific named API variables are intentionally consumed by the provider; for example Grok Build `XAI_API_KEY` / `GROK_CODE_XAI_API_KEY`. AIWG also inspects provider settings containing inline-credential indicators. | `src/providers/`, provider adapters and worker-dispatch environment policy | Deferred: retain intended-recipient exceptions and migrate each provider boundary with its existing allowlist. Do not forward credentials to unrelated helpers. |

Developer-only `tools/` qualification, smoke, benchmark and release scripts are outside the public command surface. They also read synthetic/live opt-in environment credentials (`AIWG_JEV_LOAD_API_KEY` with `--credential-env`, `AIWG_DECISION_JEV_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `AIWG_FORTEMI_LIVE_TOKEN`, `SOCKET_API_TOKEN`, `AIWG_FORGE_TOKEN`, `AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN`, `GITHUB_TOKEN`) or an OpenBao helper. Their live paths are deferred; tests for this slice use synthetic values, isolated temporary files and injected stores only.

`aiwg dataset` remote adapters accept opaque credential locators, reject secret-bearing URLs/configuration, and require an external authorized resolver; they do not currently resolve CLI secret bytes themselves. HTTP credentials received by `aiwg serve` over authenticated API requests are protocol input, not command-line input. Those contracts remain with their existing owners.
