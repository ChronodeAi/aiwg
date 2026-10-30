# Doctor worker qualification suite performance (#3529)

Local measurements on 2026-10-24, Linux, Node v24.22.1, Vitest 4.1.12. File runs were sequential on the workspace host. All cases use synthetic data and fake CLIs. No CI run was requested or performed.

The median file duration across three measured runs fell from **216.030 s to 75.027 s** (65.3% less time, 2.9× faster). All five optimized runs passed all 51 tests (255 passes, zero failures). The highest individual test duration over those five runs was **4.677 s**. The 30 s default test timeout and 30 s per-spawn exec limit apply; the describe-level 120 s override and its comment are removed.

## What changed

- Public CLI fixtures now use the existing compiled `dist/src` handlers. The entry script imports only the requested handler, and fake probes no longer inherit the `tsx` loader via `NODE_OPTIONS`. Run `npm run build:cli` first, as CI already does.
- One installed package image is shared read-only. The permission mutation and two renderer mutation tests each copy a private image. Installation copying and permission normalization fall from 40 copies to four. Each other scenario retains its private project, HOME, binary and approval store.
- Discovery reconciliation shares two real qualified fixtures in `beforeAll`: the configured account label and the legacy `local-account` label. Every case clones the observations, writes its own cache variant, and deletes the cache in `afterEach`. Shared fixture roots are removed in `afterAll`; individual fixture roots are removed in `afterEach`.
- The namespace qualification unit case also uses a private HOME and sibling config directory, avoiding the operator’s default user configuration.
- Logic-only cases call the existing exported `modelsHandler.execute` and `qualifyProbedWorkers` APIs in-process. Their real catalog/config loaders, recorded-installation checks, executable version probes, driver and diagnostics still run. Environment and output spies are restored in `finally`; no resolver or qualification outcome is mocked.
- Parallel workspace approvals, replacement, capacity, account/binary invalidation, launcher registration, sandbox policy, permission changes and dispatch policy retain their own mutable state. The original behavioral assertions remain, with shared setup assertions moved into `beforeAll`; direct qualification calls assert the recorded/failed status that the CLI maps to its exit code.
- Fresh-process CLI coverage remains for qualification and plan rendering (Codex), qualify/resolve/execute (Muse), refusal (failed sandbox, missing confirmation, invalid renderer), JSON/text output, authorized shell output, and launcher revalidation. The providerless shell-format invocation is retained because it verifies that public output format and authorization behavior.

## Where time went

Counts below are at the `run` / `runNode` / `resolve` helper boundary; nested doctor and fake probe processes are included in elapsed time, not counted again. Each doctor call starts the entry process and the doctor script through the utility handler. The worker-only doctor path returns before general installation/npm checks: there is no npm process per test. `npx` starts the test runner once per file run. Catalog loading, module imports, and fake discovery/sandbox probes were repeated in fresh processes. Catalog reads and probes needed to validate changed inputs remain; redundant catalog query processes and six repeated discovery-family qualifications are gone.

Run 1 operation profile (cumulative elapsed time; parallel approvals overlap, so these totals are not wall-clock time):

| Operation | Before count | Before seconds | After count | After seconds |
|---|---:|---:|---:|---:|
| doctor CLI | 51 | 144.770 | 41 | 58.240 |
| models resolve CLI | 44 | 50.070 | 14 | 7.948 |
| models sources CLI | 8 | 7.291 | 0 | 0.000 |
| Script / execution | 5 | 2.460 | 5 | 1.803 |
| Models handler API | 0 | 0.000 | 32 | 3.445 |
| Qualification API | 0 | 0.000 | 4 | 2.503 |
| fixture | 40 | 11.549 | 34 | 2.348 |
| installation | 0 | 0.000 | 4 | 1.116 |

Helper-level CLI spawns: **108 → 60**. Before, fixture timing includes installation copying. After, installation timing is also recorded separately (and is included in fixture time for private images); do not sum overlapping setup categories.

## File duration and repeatability

File time is the JSON reporter file `endTime - startTime`; individual timings below are assertion durations. Global runner startup/build work is outside the file time.

| Run | Before seconds | Before passes / failures | After seconds | After passes / failures | Slowest after seconds |
|---|---:|---:|---:|---:|---:|
| 1 | 214.154 | 51 / 0 | 75.027 | 51 / 0 | 4.677 |
| 2 | 216.030 | 51 / 0 | 75.064 | 51 / 0 | 4.608 |
| 3 | 218.259 | 51 / 0 | 74.458 | 51 / 0 | 4.577 |
| 4 | — | — | 74.309 | 51 / 0 | 4.567 |
| 5 | — | — | 74.629 | 51 / 0 | 4.633 |

## Slowest ten tests in each of three runs

### Before, run 1

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 11.397 |
| 2 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 9.354 |
| 3 | blocks a qualified installation when the group asks for unsupported approval or step controls | 9.271 |
| 4 | bounds the approval set without eviction and permits replacement at capacity | 7.937 |
| 5 | blocks changed payload versions behind an unchanged launcher, and failed probes | 7.706 |
| 6 | qualifies installation and exact model roles and renders a launchable plan | 7.372 |
| 7 | restores dispatch after requalifying under a changed accountScope label | 6.690 |
| 8 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 6.621 |
| 9 | doctor and resolve name the same qualified workspace mismatch for another worktree | 6.415 |
| 10 | requires requalification after the configured accountScope label changes | 5.825 |

### Before, run 2

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 10.799 |
| 2 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 9.411 |
| 3 | blocks a qualified installation when the group asks for unsupported approval or step controls | 9.323 |
| 4 | blocks changed payload versions behind an unchanged launcher, and failed probes | 7.831 |
| 5 | bounds the approval set without eviction and permits replacement at capacity | 7.563 |
| 6 | qualifies installation and exact model roles and renders a launchable plan | 7.514 |
| 7 | restores dispatch after requalifying under a changed accountScope label | 6.887 |
| 8 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 6.782 |
| 9 | doctor and resolve name the same qualified workspace mismatch for another worktree | 6.420 |
| 10 | requires requalification after the configured accountScope label changes | 5.918 |

### Before, run 3

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 10.907 |
| 2 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 9.444 |
| 3 | blocks a qualified installation when the group asks for unsupported approval or step controls | 9.363 |
| 4 | blocks changed payload versions behind an unchanged launcher, and failed probes | 7.852 |
| 5 | bounds the approval set without eviction and permits replacement at capacity | 7.595 |
| 6 | qualifies installation and exact model roles and renders a launchable plan | 7.529 |
| 7 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 6.806 |
| 8 | restores dispatch after requalifying under a changed accountScope label | 6.792 |
| 9 | doctor and resolve name the same qualified workspace mismatch for another worktree | 6.494 |
| 10 | qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI | 6.094 |

### After, run 1

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 4.677 |
| 2 | qualifies installation and exact model roles and renders a launchable plan | 3.860 |
| 3 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 3.696 |
| 4 | doctor and resolve name the same qualified workspace mismatch for another worktree | 3.428 |
| 5 | blocks a qualified installation when the group asks for unsupported approval or step controls | 3.414 |
| 6 | restores dispatch after requalifying under a changed accountScope label | 3.264 |
| 7 | previews owned store permission tightening without writes and applies it with --yes | 2.762 |
| 8 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 2.744 |
| 9 | qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI | 2.703 |
| 10 | bounds the approval set without eviction and permits replacement at capacity | 2.449 |

### After, run 2

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 4.608 |
| 2 | qualifies installation and exact model roles and renders a launchable plan | 3.911 |
| 3 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 3.671 |
| 4 | doctor and resolve name the same qualified workspace mismatch for another worktree | 3.441 |
| 5 | blocks a qualified installation when the group asks for unsupported approval or step controls | 3.421 |
| 6 | restores dispatch after requalifying under a changed accountScope label | 3.310 |
| 7 | previews owned store permission tightening without writes and applies it with --yes | 2.771 |
| 8 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 2.732 |
| 9 | qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI | 2.673 |
| 10 | bounds the approval set without eviction and permits replacement at capacity | 2.432 |

### After, run 3

| Rank | Test | Seconds |
|---:|---|---:|
| 1 | retains exact approvals for parallel workspaces and replaces only the requalified workspace | 4.577 |
| 2 | qualifies installation and exact model roles and renders a launchable plan | 3.837 |
| 3 | loads and revalidates an eligible plan through the launcher after builtin Codex registration | 3.676 |
| 4 | doctor and resolve name the same qualified workspace mismatch for another worktree | 3.389 |
| 5 | blocks a qualified installation when the group asks for unsupported approval or step controls | 3.342 |
| 6 | restores dispatch after requalifying under a changed accountScope label | 3.261 |
| 7 | previews owned store permission tightening without writes and applies it with --yes | 2.777 |
| 8 | qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 2.685 |
| 9 | qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI | 2.615 |
| 10 | bounds the approval set without eviction and permits replacement at capacity | 2.460 |

## Per-test CLI spawn profile

Run 1, with all 51 test cases listed. Times sum helper-level process elapsed time only. In-process calls are listed separately. Shared setup has its own final row.

| Test | Before spawns | Before process seconds | After spawns | After process seconds | After API calls |
|---|---:|---:|---:|---:|---:|
| preserves null effort for models with no applicable effort control | 0 | 0.000 | 0 | 0.000 | 0 |
| names missing role effort before adapter build and host loading (missing-file) | 2 | 3.921 | 1 | 1.343 | 1 |
| names missing role effort before adapter build and host loading (missing-role) | 2 | 3.864 | 1 | 1.332 | 1 |
| names missing role effort before adapter build and host loading (missing-field) | 2 | 3.329 | 1 | 0.947 | 1 |
| names missing role effort before adapter build and host loading (null-effort) | 2 | 3.875 | 1 | 1.348 | 1 |
| retains exact approvals for parallel workspaces and replaces only the requalified workspace | 7 | 14.713 | 3 | 4.575 | 4 |
| bounds the approval set without eviction and permits replacement at capacity | 3 | 7.572 | 1 | 1.513 | 2 |
| refuses qualification when the model-free Codex sandbox check fails | 1 | 2.919 | 1 | 1.256 | 0 |
| qualifies and resolves explicit 'codex' external sandbox policy (mixed=false) | 2 | 4.233 | 2 | 1.988 | 0 |
| qualifies and resolves explicit 'codex' external sandbox policy (mixed=true) | 2 | 4.396 | 2 | 2.153 | 0 |
| qualifies and resolves explicit 'muse' external sandbox policy (mixed=false) | 2 | 4.121 | 2 | 1.967 | 0 |
| passes only named environment variables to the sandbox no-op | 0 | 0.000 | 0 | 0.000 | 0 |
| qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI | 4 | 5.419 | 4 | 2.649 | 0 |
| reports a blocked namespace probe as launcher-scoped and still qualifies Tier 0 direct dispatch | 2 | 4.489 | 2 | 2.177 | 0 |
| qualifies native-sandbox policy without the failing systemd namespace probe | 2 | 4.259 | 2 | 2.013 | 0 |
| loads and revalidates an eligible plan through the launcher after builtin Codex registration | 5 | 6.319 | 5 | 3.650 | 0 |
| refuses a non-canonical workerAdapters entry claiming a pre-registered builtin id | 2 | 3.594 | 2 | 1.838 | 0 |
| checks the configured tuple without launching a worker (build failure: false) | 0 | 0.000 | 0 | 0.000 | 0 |
| checks the configured tuple without launching a worker (build failure: true) | 0 | 0.000 | 0 | 0.000 | 0 |
| rejects missing role guidance before calling the installed renderer | 0 | 0.000 | 0 | 0.000 | 0 |
| names the failing native-controls check without launching a worker | 0 | 0.000 | 0 | 0.000 | 0 |
| names the failing workspace check without launching a worker | 0 | 0.000 | 0 | 0.000 | 0 |
| checks the configured tuple from recorded installations (load failure: false) | 0 | 0.000 | 0 | 0.000 | 0 |
| checks the configured tuple from recorded installations (load failure: true) | 0 | 0.000 | 0 | 0.000 | 0 |
| blocks changed payload versions behind an unchanged launcher, and failed probes | 5 | 7.407 | 1 | 1.551 | 4 |
| qualifies installation and exact model roles and renders a launchable plan | 4 | 7.084 | 4 | 3.810 | 0 |
| blocks a qualified installation when the group asks for unsupported approval or step controls | 5 | 8.969 | 2 | 2.649 | 3 |
| records role qualification and invalidates it when the binary version changes | 2 | 4.165 | 1 | 1.542 | 1 |
| requires requalification after the configured accountScope label changes | 3 | 5.519 | 1 | 1.559 | 2 |
| restores dispatch after requalifying under a changed accountScope label | 3 | 6.403 | 2 | 3.062 | 1 |
| reports the accountScope limitation in text qualification results | 1 | 3.247 | 1 | 1.539 | 0 |
| reconciles approved observations with same-facts discovery cache | 3 | 5.341 | 0 | 0.000 | 1 |
| reconciles approved observations with banner discovery cache | 3 | 5.331 | 0 | 0.000 | 1 |
| reconciles approved observations with context discovery cache | 3 | 5.192 | 0 | 0.000 | 1 |
| reconciles approved observations with efforts discovery cache | 3 | 5.171 | 0 | 0.000 | 1 |
| reconciles approved observations with older discovery cache | 3 | 5.401 | 0 | 0.000 | 1 |
| reconciles approved observations with retired discovery cache | 3 | 5.223 | 0 | 0.000 | 1 |
| reconciles approved observations with hidden discovery cache | 3 | 5.200 | 0 | 0.000 | 1 |
| reconciles approved observations with conflict discovery cache | 3 | 5.168 | 0 | 0.000 | 1 |
| surfaces the offending installed path and exact permission remedy | 1 | 2.707 | 1 | 1.191 | 0 |
| previews owned store permission tightening without writes and applies it with --yes | 2 | 4.765 | 2 | 2.708 | 0 |
| qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset | 6 | 9.064 | 2 | 2.143 | 4 |
| explains that an existing relative brief must be absolute | 2 | 4.310 | 1 | 1.556 | 1 |
| blocks an operator-approved installed renderer that silently drops the requested sandbox | 2 | 4.085 | 2 | 1.786 | 0 |
| reports a sanitized adapter build failure before recording qualification | 1 | 3.160 | 1 | 1.450 | 0 |
| doctor and resolve name the same qualified workspace mismatch for another worktree | 3 | 6.103 | 3 | 3.379 | 0 |
| requires --yes without a TTY and dry-run previews without creating qualification records | 2 | 4.205 | 2 | 2.257 | 0 |
| records ready installations independently of whether worker policy permits dispatch | 2 | 4.347 | 2 | 1.998 | 0 |
| asks one TTY question listing installation/model/roles and honors no without writes | 0 | 0.000 | 0 | 0.000 | 0 |
| reports the unit probe failure as launcher-scoped without failing qualification | 0 | 0.000 | 0 | 0.000 | 0 |
| reports passing probes and skips them for the policy-selected native sandbox | 0 | 0.000 | 0 | 0.000 | 0 |
| Shared beforeAll setup | 0 | 0 | 2 | 3.063 | 2 |

## Reproduction

Build once, then use the same Vitest configuration for each sequential run:

```sh
npm run build:cli
mkdir -p test-results/perf-3529
for trial in 1 2 3 4 5; do
  QUALIFICATION_PROFILE="$PWD/test-results/perf-3529/spawns-$trial.json" \
    npx vitest run --config config/vitest.config.js \
    test/unit/cli/doctor-worker-qualification.test.ts \
    --reporter=json --outputFile="test-results/perf-3529/run-$trial.json"
done
```

`QUALIFICATION_PROFILE` is optional. It records fixture/installation preparation, every helper-level spawn and every in-process models or qualification call as `{ test, kind, ms }`. The before measurements used the same timing wrapper with the original fixture and describe timeout. Raw local JSON and command logs are in `test-results/perf-3529/` (ignored output).

## Validation

| Command | Result |
|---|---|
| `npm run typecheck` | Pass, no diagnostics |
| `npm run build:cli` | Pass, including version check and build resources |
| Full file, three baseline runs | 153 passed, 0 failed |
| Full file, five final runs | 255 passed, 0 failed |
| Touched file and eight neighbors, command below | 285 passed, 0 failed, 9 files |
| `npm run lint:test-process-timeouts` | Pass, 0 unbounded calls |
| `npm run lint:test-registration` | Pass, 1,488 source files assigned |

```sh
npx vitest run --config config/vitest.config.js --maxWorkers=4 \
  test/unit/cli/doctor-worker-qualification.test.ts \
  test/unit/cli/doctor.test.ts \
  test/unit/cli/doctor-channel.test.ts \
  test/unit/cli/doctor-worker-dispatch-offer.test.ts \
  test/unit/cli/doctor-command-probes.test.mjs \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/models/worker-installation-store.test.ts \
  test/unit/models/worker-direct-readiness.test.ts \
  test/unit/models/worker-version-probe.test.ts
```

## Acceptance and limits

- Profiling, shared read-only setup, in-process resolver checks, preserved CLI behavior families, and default timeout restoration: met.
- Three before/after timing samples with slowest-ten listings, five passing optimized file runs, typecheck, CLI build, neighboring tests and both requested lint gates: met (results above).
- About 10 s per test on the shared CI runner: local timings provide headroom, but shared-runner timing remains unverified. There are no CI or tracker writes in this task.
