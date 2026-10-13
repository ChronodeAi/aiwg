#!/usr/bin/env node
/**
 * Deliberately-hangs fixture for the UAT hang-guard's own test (#3062
 * review item 14).
 *
 * Reproduces the exact pathology the review describes: this process
 * ignores SIGTERM, then blocks forever inside a *synchronous* child-process
 * call to a grandchild that also ignores SIGTERM — so this process's own
 * SIGTERM handler can never run while blocked (the handler is JS; the
 * blocking call is a native, uninterruptible wait), and signaling only the
 * direct child does nothing because the grandchild is the one actually
 * sleeping. The only thing that reaches both is SIGKILL sent to the whole
 * process group.
 */
import { spawnSync } from 'node:child_process';

process.on('SIGTERM', () => {
  // Ignored on purpose. If this ever logs, something unblocked us without
  // actually killing the process (which would be the bug this test fixture
  // exists to catch).
});

// Blocks synchronously on a grandchild that also ignores SIGTERM and never
// exits on its own. `timeout` here is a ceiling only, satisfying the
// repo's own sync-child-process gate for test/ code — it is never the
// active bound: Node's native timeout sends SIGTERM once (the grandchild
// ignores it, same as this process does) and then keeps blocking, so only
// an external SIGKILL to the whole process group — what the test under
// test is actually supervising for — can reach this before that timeout
// would ever fire.
spawnSync(
  process.execPath,
  ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
  { stdio: 'ignore', timeout: 60_000 },
);
