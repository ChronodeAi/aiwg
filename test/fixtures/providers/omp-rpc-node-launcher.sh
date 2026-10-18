#!/bin/sh
# Preserve the child PID while forwarding OMP arguments to a static Node fixture.
set -eu
exec "${AIWG_OMP_TEST_NODE:?Node executable is required}" "${AIWG_OMP_TEST_FIXTURE:?OMP fixture is required}" "$@"
