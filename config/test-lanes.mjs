// Required offline lane ownership. Live UAT is separately declared by its configs.
export const packagingFiles = [
  'test/integration/artifacts/aiwg-tracking.test.ts',
  'test/smoke/cockpit-base-footprint.test.js',
  'test/integration/network-analysis-addon.test.ts',
  'test/integration/cli-package-webmode.test.ts',
  'test/integration/global-install-native-policy.test.ts',
  'test/integration/tarball-allowlist-packaging.test.ts',
  'test/integration/dataset-contract-packaging.test.ts',
  'test/integration/decision-engine-clean-install.test.ts',
];
export const artifactIndexFiles = [
  'test/integration/artifacts/dependency-graph.test.ts',
  'test/integration/artifacts/incremental-build.test.ts',
  'test/integration/artifacts/multi-graph.test.ts',
];
export const discoveryFiles = ['test/integration/artifacts/discover-fortemi-corpus.test.ts'];
export const nodeFiles = [
  'tools/ralph-external/*.test.mjs', 'test/unit/ralph/*.test.mjs',
  'tools/experiments/conformal/prototype.test.mjs',
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
export const d29SlowFiles = [
  'test/unit/decision/d29-synthetic-v8.test.mjs',
  'test/unit/decision/d29-study.test.mjs',
  'test/unit/decision/d29-synthetic-v6.test.mjs',
  'test/unit/decision/d29-synthetic-v7.test.mjs',
  'test/unit/decision/d29-gates-regression.test.mjs',
  'test/unit/decision/d29-v8-review.test.mjs',
];
