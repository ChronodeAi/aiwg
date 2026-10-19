import { expect } from 'vitest';

// Share the real, unchanged corpus only in deployment integration tests.
// Index/query unit tests and use-self-verification assert cold, stale, or
// replaced indexes and must keep their private HOME/XDG framework cache.
const file = (expect.getState().testPath || '').replaceAll('\\', '/');
if (!/\/test\/integration\/(?:[^/]*deployment|project-local-deploy|model-worker-provider-matrix|kernel-deployment-conformance)\.test\.ts$/.test(file)) {
  delete process.env.AIWG_FRAMEWORK_INDEX_CACHE;
  delete process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE;
}
