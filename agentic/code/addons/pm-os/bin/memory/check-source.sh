#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
SOURCE=""
MAX_BYTES=262144

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"

json() {
  printf '{"status":"%s","source_ref":"%s","reason":"%s"}\n' "$1" "${2:-}" "${3:-}"
}

block() {
  json "blocked" "" "$1"
  exit 3
}

[ -n "$SOURCE" ] || block "missing_source"

case "$SOURCE" in
  /*) source_path="$SOURCE" ;;
  *) source_path="$ROOT/$SOURCE" ;;
esac

[ -e "$source_path" ] || block "missing_source"
[ ! -d "$source_path" ] || block "directory_source"

if [ -L "$source_path" ]; then
  link_dir="$(dirname "$source_path")"
  link_base="$(basename "$source_path")"
  link_physical="$(cd -P "$link_dir" && pwd)/$link_base"
  target_dir="$(dirname "$(cd "$link_dir" && pwd -P)/$(readlink "$source_path")")" 2>/dev/null || block "symlink_source"
  target_physical="$(cd -P "$target_dir" 2>/dev/null && pwd)/$(basename "$(readlink "$source_path")")" || block "symlink_source"
  case "$link_physical" in "$ROOT"/*) ;; *) block "symlink_outside_root" ;; esac
  case "$target_physical" in "$ROOT"/*) ;; *) block "symlink_outside_root" ;; esac
fi

source_dir="$(dirname "$source_path")"
source_base="$(basename "$source_path")"
source_physical="$(cd -P "$source_dir" && pwd)/$source_base"

case "$source_physical" in
  "$ROOT"/*) ;;
  *) block "outside_root" ;;
esac

source_ref="${source_physical#$ROOT/}"

case "$source_ref" in
  .git/*|.env|.env.*|*/.env|*/.env.*|*.pem|*private*key*|*secret*|*token*|*cookie*|*session*|"📂 Context/Work/.hook-state/"*|.cursor/commands/*|.claude/skills/*)
    block "denied_path"
    ;;
esac

bytes="$(wc -c < "$source_physical" | tr -d '[:space:]')"
if [ "${bytes:-0}" -gt "$MAX_BYTES" ]; then
  block "source_too_large"
fi

if LC_ALL=C grep -q '[^[:print:][:space:]]' "$source_physical"; then
  block "binary_source"
fi

json "ok" "$source_ref" ""
