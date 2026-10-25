import base from './vitest.config.js';
import { wasmFiles } from './test-lanes.mjs';

// Required offline lane for WebAssembly users (#3073). A separate process
// avoids the suspected V8 JIT allocation bookkeeping race on thread teardown
// (jit_page_->allocations_.erase(addr) == 1). Inherit reporters and setup;
// run through run-default-lane.mjs to retain the owned TMPDIR/leak gate.
export default {
  ...base,
  test: {
    ...base.test,
    include: wasmFiles,
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    isolate: true,
  },
};
