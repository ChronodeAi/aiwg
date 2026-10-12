#!/bin/sh
# Read per-test scripts through the interpreter; never execute freshly written files.
# Forwards argv (e.g. `--mode rpc ...`, or a warm-up `--version`) to the fixture script; every
# existing fixture script ignores argv, so this is additive for #2999's warm-start regression test.
set -eu
exec /bin/sh "${AIWG_OMP_TEST_SCRIPT:?OMP fixture script is required}" "$@"
