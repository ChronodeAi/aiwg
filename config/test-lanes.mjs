// Required offline lane ownership. Live UAT is separately declared by its configs.
export const packagingFiles = [
  'test/integration/relations-prebuilt-packaging.test.ts',
  'test/integration/artifacts/aiwg-tracking.test.ts',
  'test/smoke/cockpit-base-footprint.test.js',
  'test/integration/network-analysis-addon.test.ts',
  'test/integration/cli-package-webmode.test.ts',
  'test/integration/worker-adapter-package.test.ts',
  'test/integration/global-install-native-policy.test.ts',
  'test/integration/tarball-allowlist-packaging.test.ts',
  'test/integration/dataset-contract-packaging.test.ts',
  'test/integration/mission-contract-packaging.test.ts',
  'test/integration/sessions-muse-package.test.ts',
  'test/integration/sessions-coverage-package.test.ts',
  'test/integration/decision-engine-clean-install.test.ts',
  'test/integration/tools-packed-relative-imports.test.ts',
];
export const artifactIndexFiles = [
  'test/unit/artifacts/relations-corpus.test.ts',
  'test/integration/artifacts/dependency-graph.test.ts',
  'test/integration/artifacts/incremental-build.test.ts',
  'test/integration/artifacts/multi-graph.test.ts',
];
export const discoveryFiles = ['test/integration/artifacts/discover-fortemi-corpus.test.ts'];
// Full-corpus provider deployment owns one shared immutable source cache and
// runs serially so multiple child CLIs do not compete inside the default lane.
export const deploymentFiles = [
  'test/integration/use-all-deployment.test.ts',
  'test/integration/hermes-deployment.test.ts',
  'test/integration/guided-setup-walkthrough.test.ts',
];
// Exhaustive provider deployment matrices run before releases, while focused
// CLI contracts and a small provider smoke matrix remain in the default lane.
// These do not overlap the required post-merge deploymentFiles lane above.
export const releaseSlowFiles = [
  'test/integration/provider-file-locations.test.ts',
  'test/integration/kernel-deployment-conformance.test.ts',
  'test/integration/deployment-completeness.test.ts',
  'test/integration/factory-deployment.test.ts',
  'test/integration/opencode-deployment.test.ts',
  'test/integration/cursor-deployment.test.ts',
];
// Offline release-only configs have an explicit manual workflow owner instead
// of requiring execution on every merge in the canonical CI workflow.
export const releaseLaneWorkflows = {
  'config/vitest.release-slow.config.js': '.gitea/workflows/release-slow.yml',
};
// PGlite's WebAssembly JIT teardown can abort V8 in worker threads (#3073,
// runs 81094/90363). Required forks lane; keep coverage and the TMPDIR gate.
// Runtime inventory: docs/contributing/testing-wasm-lane.md.
export const wasmFiles = [
  'test/unit/artifacts/fortemi-shard-export.test.ts',
];
// Shared S0 infrastructure and frozen contracts run in the existing offline
// conformance lane. Mechanism suites retain their source owner's unit lane.
export const orchestrationConformanceFiles = [
  'test/conformance/orchestration-v1/**/*.test.ts',
  'test/conformance/mission-v1/**/*.test.ts',
];
// Workspace package test ownership (#3729). Every `test`/`test:*` script in
// apps/*/package.json must be invoked by a canonical CI job, or be listed in
// optInPackageTests with a non-empty reason. Non-test harness scripts may also
// be listed to document a manual-only classification; listed scripts must exist
// and must NOT be CI-invoked (no redundant entries).
// Cockpit harness classification: the four smoke harnesses run in CI because
// each is deterministic and offline (mock-executor: ephemeral loopback port;
// bridge: in-process servers on ephemeral ports with a fake CLI fixture;
// shell-core: isolated mkdtemp HOME; vscode: stubbed vscode module + fetch).
// The two poc harnesses stay manual-only (see entries below).
export const optInPackageTests = [
  { package: '@aiwg/cockpit', script: 'test', reason: 'Local aggregate chaining CI-owned smoke with manual-only poc harnesses; CI invokes test:web and smoke directly.' },
  { package: '@aiwg/cockpit', script: 'poc', reason: 'Manual-only PoCs: kill-bridge-isolation.mjs needs fixed ports plus SIGKILL timing (flake-prone on shared runners); security-checks.mjs reads/writes the real $HOME runtime file (non-hermetic).' },
];
export const nodeFiles = [
  'tools/ralph-external/*.test.mjs', 'test/unit/ralph/*.test.mjs',
  'tools/experiments/conformal/prototype.test.mjs',
  'tools/eval/test/*.test.mjs',
  'agentic/code/addons/droid-bridge/test/*.test.mjs',
  'test/unit/providers/grok-build-qualification.test.mjs',
  'test/contract/agentic-publication-source.test.mjs',
  'test/contract/setup-manifest-site-dispatch.test.mjs',
  'test/contract/site-manifest-release-dispatch.test.mjs',
  'test/contract/socket-post-publish-workflow.test.mjs',
];
// Heavy D29 suites: multi-seed structure scans, positive controls, repeated
// audits and full-corpus reproductions. They run in their own CI job
// (test:d29-slow) so they never push the shared test:ci step past its cap;
// test/unit/decision/d29-synthetic-v8-smoke.test.mjs keeps fast single-seed
// coverage in the default lane.
// Heavy D17 staged-calibration suite: full 1,800-row preparation, 1,200-row calibrated
// scoring, seal re-derivation and promotion-route replays (about 30 s of one worker).
// It runs in the same slow job; the D17 diagnostic, corpus, artifact and statistics
// files keep fast coverage in the default lane.
export const d17SlowFiles = [
  'test/unit/decision/ensemble-study-staged.test.ts',
  'test/unit/decision/ensemble-staged-lattice.test.ts',
  // D17-MF probe (#2850): full 5,772-row preparation, shortcut audit, bundle planning and calibrated scoring (about 22 s).
  'test/unit/decision/d17-multifact.test.ts',
];
export const d29SlowFiles = [
  'test/unit/decision/d29-synthetic-v8.test.mjs',
  'test/unit/decision/d29-study.test.mjs',
  'test/unit/decision/d29-synthetic-v6.test.mjs',
  'test/unit/decision/d29-synthetic-v7.test.mjs',
  'test/unit/decision/d29-gates-regression.test.mjs',
  'test/unit/decision/d29-v8-review.test.mjs',
];
