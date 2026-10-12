#!/usr/bin/env bash
# Offline aggregate gate for the PM OS AIWG/Codex adapter surface.

set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"

exec python3 "$ROOT/_internal/tests/test-codex-parity.py" --root "$ROOT" "$@"
