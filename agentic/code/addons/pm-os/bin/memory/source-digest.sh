#!/usr/bin/env bash
set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
SOURCE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"

check_output="$(bash "$TOOL_ROOT/bin/memory/check-source.sh" --root "$ROOT" --source "$SOURCE" --json)"
case "$check_output" in
  *'"status":"ok"'*) ;;
  *) printf '%s\n' "$check_output"; exit 3 ;;
esac

case "$SOURCE" in
  /*) source_path="$SOURCE" ;;
  *) source_path="$ROOT/$SOURCE" ;;
esac

source_dir="$(dirname "$source_path")"
source_base="$(basename "$source_path")"
source_physical="$(cd -P "$source_dir" && pwd)/$source_base"
source_ref="${source_physical#$ROOT/}"
digest="sha256:$(shasum -a 256 "$source_physical" | awk '{print $1}')"

printf '{"status":"ok","source_ref":"%s","digest":"%s"}\n' "$source_ref" "$digest"
