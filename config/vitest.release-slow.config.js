import deployment from './vitest.deployment.config.js';
import { releaseSlowFiles } from './test-lanes.mjs';

// Reuse serial forks, reviewed source caches and the owned TMPDIR/leak gate.
export default {
  ...deployment,
  test: { ...deployment.test, include: releaseSlowFiles },
};
