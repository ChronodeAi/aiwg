# CLI cold-start performance gate

The CLI startup gate measures application overhead separately from the Node.js
process startup cost. Each command sample is bracketed by two baseline
invocations of `node -e ''`; the average of those adjacent baselines is
subtracted from that command sample. The gate evaluates the median paired
overhead across seven samples.

This pairing tracks short-lived contention on shared runners better than
measuring every command first and every baseline afterward. Median evaluation
allows isolated scheduler spikes while retaining a hard failure when at least
half the samples exceed the performance objective.

## Budgets

The enforced defaults are:

| Command | Local overhead budget |
| --- | ---: |
| `aiwg --version` | 150 ms |
| `aiwg help` | 750 ms |

An isolated `npm run test:perf` run should keep `aiwg help` below the 500 ms
engineering target. The enforced 750 ms ceiling accounts for parallel-suite
and container contention while still failing sustained regressions. Gitea CI,
plugin validation, and both publication workflows declare one shared-runner
policy explicitly: 300 ms for `--version`, 750 ms for `help`, and seven paired
samples.

The following environment variables are supported:

- `AIWG_PERF_BUDGET_VERSION_MS`: positive integer overhead budget.
- `AIWG_PERF_BUDGET_HELP_MS`: positive integer overhead budget.
- `AIWG_PERF_SAMPLE_COUNT`: odd integer of at least 3; defaults to 7.

Invalid overrides fall back to their documented defaults. CI logs report the
command median, paired baseline median, overhead median, range, sample count,
and budget so variance remains observable. Any sustained regression whose
median overhead meets or exceeds the configured budget fails the gate.

## Deployment process overhead (#3558)

The script runner calls the agent deployer's `main(args, internal)` within the
CLI process. Codex skill and prompt helpers also expose guarded `main` entry
points. Each pass builds fresh options and model configuration, and each staged
helper receives its deployment home explicitly. Captured passes retain the
existing file-backed preview and bounded failure diagnostics. Embedded calls
are serialized, with console and environment restoration in `finally`.

Set `AIWG_DEPLOY_SUBPROCESS=1` to use the subprocess implementation for both
agent passes and Codex helpers. Calls requesting a hard timeout, another working
directory, or environment overrides other than `AIWG_ROOT` retain subprocess
isolation automatically.

Measurements on 2026-10-25 used Node 24.22.1, fresh temporary projects and isolated
homes. A `NODE_OPTIONS=--import=<preload>` module recorded each process's argv
and lifetime on exit. The setup fixture followed the guided walkthrough's plan,
review and apply sequence, including synthetic provider credentials and an
offline Jev endpoint. Counts and apply timings exclude plan/review. Other work
was running on the workstation, so these are loaded measurements, rather than
an idle reproduction of the issue's approximately 62-second baseline.

| Command | Before processes | After processes | Before wall time | After wall time |
| --- | ---: | ---: | ---: | ---: |
| `use sdlc --provider codex` | 160 | 1 | 117.59 s | 92.76 s, 73.14 s |
| `setup --apply --yes --json` | 161 | 2 | 117.67 s | 95.42 s, 72.88 s |

Before the change, each command ran 53 agent deployers, 53 skill helpers and 53
prompt helpers. Afterward only the CLI processes remained. The standalone use
command has one process; guided apply has the setup CLI and its use CLI child.
The first after measurement overlapped this change's integration tests; the
second ran after those tests finished, with other workstation workloads still
active. The latter reduced use wall time by 37.8% and apply wall time by 38.1%.
The complete guided walkthrough passed in 97.04 seconds under load and in
75.48 seconds on a later run. Its per-step timeout stays at 420 seconds until
CI runs on the shared runner show enough margin to restore 180 seconds.

The multi-addon equivalence test compares complete project and home file trees
by path and SHA-256 digest, including every manifest, using a fixed clock for
registry timestamps. It also compares captured preview actions, exercises a
failed pass before successful passes, and checks restoration of console, cwd,
environment, exit status and signal listeners.

Validation commands:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build:cli` | Passed |
| `npm run test:deployment` | 29 passed; zero temporary-directory leaks |
| `npx vitest run --config config/vitest.deployment.config.js test/integration/guided-setup-walkthrough.test.ts` | 1 passed with the restored deadline |
| `npx vitest run --config config/vitest.config.js test/integration/codex-deployment.test.ts test/integration/deployment-in-process.test.ts test/unit/cli/handlers/script-runner.test.ts` | 44 passed |
| `npx vitest run --config config/vitest.config.js test/integration/project-local-deploy.test.ts -t 'PL-CODEX\|DP-CODEX'` | 2 passed; 22 filtered out |
| `npm run lint:test-registration` | Passed; 1,504 source files assigned |
| `npm run lint:test-process-timeouts` | Passed; zero unbounded calls |

Additional targeted validation passed 50 provider/runner unit tests, 173
neighbouring handler/provider/equivalence tests, and 63 provider integration
checks (file locations, deployment verification and Codex listing budget).
