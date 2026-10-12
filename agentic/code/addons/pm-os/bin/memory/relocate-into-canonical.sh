#!/usr/bin/env bash
# relocate-into-canonical.sh
#
# Decide where a Context-namespace document SHOULD live, and (optionally) move it
# there. Shared engine for the canonical save guard (issue #35): used by the
# PreToolUse hook in --compute mode (return the corrected path, no filesystem
# change) and by /tidy in --detect mode (report drift) / --apply mode (safe move).
#
#   relocate-into-canonical.sh --path <file> [--compute|--detect|--apply] \
#       [--root <repo>] --json
#
# Output (JSON, one line):
#   {"status":"<s>","mode":"<m>","from":"<abs>","to":"<abs>","reason":"<r>","branch":"<b>"}
#
# status values:
#   out_of_scope   path is not a Context-namespace .md file, or fails source safety
#   allowed        legitimate non-project Context write / already in a canonical
#                  project folder — no action
#   redirect       (compute) the canonical path differs from the intended path
#   would_relocate (detect) an existing file is misplaced — not moved
#   relocated      (apply) file was moved to canonical
#   noop_identical (apply) destination already held a byte-identical copy; source
#                  was a duplicate and was removed
#   error          a validation failure — fail closed, file left in place
#
# branch values (when a target was chosen): slug_hint | single_active | quarantine
#
# Security posture (see docs/plans/2026-06-13-001-…-plan.md → Security requirements):
# the --path source is semi-untrusted. We reject `..` / control chars, reject
# symlinked sources, assert physical containment under 📂 Context/, never follow a
# symlinked destination dir, never overwrite, and fail closed on any uncertainty.

set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
TOOL_ROOT="$ROOT"
RAW_PATH=""
MODE="compute"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --path) RAW_PATH="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --compute) MODE="compute"; shift ;;
    --detect) MODE="detect"; shift ;;
    --apply) MODE="apply"; shift ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
WORK_DIR="$ROOT/📂 Context/Work"
CONTEXT_DIR="$ROOT/📂 Context"

# ---- JSON emission (untrusted strings → safe) --------------------------------
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  printf '%s' "$s"
}

emit() {
  # emit <status> [from] [to] [reason] [branch]
  printf '{"status":"%s","mode":"%s","from":"%s","to":"%s","reason":"%s","branch":"%s"}\n' \
    "$1" "$MODE" \
    "$(json_escape "${2:-}")" "$(json_escape "${3:-}")" \
    "$(json_escape "${4:-}")" "${5:-}"
}

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---- 0. argument + namespace gate -------------------------------------------
[ -n "$RAW_PATH" ] || { emit "error" "" "" "no --path given"; exit 0; }

# S3: reject traversal and control characters outright (defense in depth).
case "$RAW_PATH" in
  *..*|*$'\n'*|*$'\t'*|*$'\r'*) emit "out_of_scope" "$RAW_PATH" "" "unsafe path"; exit 0 ;;
esac

# Absolute intended path.
case "$RAW_PATH" in
  /*) ABS="$RAW_PATH" ;;
  *)  ABS="$ROOT/$RAW_PATH" ;;
esac

base="$(basename "$ABS")"
intended_dir="$(dirname "$ABS")"

# Junk / non-deliverable filter: only ever touch markdown.
case "$base" in
  *.md) ;;
  *) emit "out_of_scope" "$ABS" "" "not a markdown file"; exit 0 ;;
esac

# 📂 Context/ must exist for anything to be in scope.
[ -d "$CONTEXT_DIR" ] || { emit "out_of_scope" "$ABS" "" "no Context dir"; exit 0; }
CONTEXT_PHYS="$(cd -P "$CONTEXT_DIR" && pwd)"
WORK_PHYS=""
[ -d "$WORK_DIR" ] && WORK_PHYS="$(cd -P "$WORK_DIR" && pwd)"

# Split the intended parent into its deepest EXISTING ancestor (resolved
# physically, for containment) and the not-yet-existing lexical tail (for logic).
# The physical ancestor alone would lose intended-but-absent subdirs (e.g. a
# compute-mode write into .inbox/ before it exists).
anc="$intended_dir"
tail=""
while [ ! -d "$anc" ] && [ "$anc" != "/" ] && [ "$anc" != "." ]; do
  tail="$(basename "$anc")${tail:+/$tail}"
  anc="$(dirname "$anc")"
done
[ -d "$anc" ] || { emit "out_of_scope" "$ABS" "" "unresolvable parent"; exit 0; }
anc_phys="$(cd -P "$anc" && pwd)"

# S2: physical containment is the real anchor (a string test alone is not enough,
# e.g. Context/../../foo passes a prefix test). The file must sit under 📂 Context/
# or the non-emoji `Context/` drift twin.
ctx="none"
case "$anc_phys/" in
  "$CONTEXT_PHYS"/*|"$CONTEXT_PHYS/") ctx="emoji" ;;
esac
nonemoji_phys=""
if [ "$ctx" = "none" ] && [ -d "$ROOT/Context" ]; then
  nonemoji_phys="$(cd -P "$ROOT/Context" && pwd)"
  case "$anc_phys/" in "$nonemoji_phys"/*|"$nonemoji_phys/") ctx="twin" ;; esac
fi
[ "$ctx" != "none" ] || { emit "out_of_scope" "$ABS" "" "outside Context"; exit 0; }

# S1: for an existing file (detect/apply), never operate on a symlinked source.
if [ -e "$ABS" ] && [ -L "$ABS" ]; then
  emit "out_of_scope" "$ABS" "" "symlinked source"; exit 0
fi
# detect/apply require the file to exist.
if [ "$MODE" != "compute" ] && [ ! -f "$ABS" ]; then
  emit "out_of_scope" "$ABS" "" "source missing"; exit 0
fi

# ---- 1. classify & allowlist -------------------------------------------------
join_rel() {  # join two path fragments, dropping empties
  if [ -n "$1" ] && [ -n "$2" ]; then printf '%s/%s' "$1" "$2"
  elif [ -n "$1" ]; then printf '%s' "$1"
  else printf '%s' "$2"; fi
}

# rel_work = intended parent relative to the (emoji) Work root.
rel_work=""
under_work=0
if [ "$ctx" = "emoji" ]; then
  if [ -n "$WORK_PHYS" ] && case "$anc_phys/" in "$WORK_PHYS"/*|"$WORK_PHYS/") true ;; *) false ;; esac; then
    under_work=1
    anc_rel="${anc_phys#"$WORK_PHYS"}"; anc_rel="${anc_rel#/}"
    rel_work="$(join_rel "$anc_rel" "$tail")"
  else
    # Inside 📂 Context/ but not under Work — the five context files, STAKEHOLDERS,
    # MY_STYLE, or any other Context content. Never a project artifact; leave it.
    emit "allowed" "$ABS" "" "Context file outside Work"; exit 0
  fi
else
  # Non-emoji `Context/` twin: always misplaced. Compute the Work-relative
  # remainder (strip a leading Work/ if present). A twin file with a recognizable
  # subpath is mirrored into the canonical emoji root at the SAME path (see the
  # twin_mirror branch below); only a truly loose twin file falls to the tree.
  rel_twin="${anc_phys#"$nonemoji_phys"}"; rel_twin="${rel_twin#/}"
  full_twin="$(join_rel "$rel_twin" "$tail")"
  case "$full_twin" in
    Work)   rel_work="" ;;
    Work/*) rel_work="${full_twin#Work/}" ;;
    *)      rel_work="$full_twin" ;;
  esac
fi

if [ "$under_work" -eq 1 ]; then
  first_seg="${rel_work%%/*}"
  case "$first_seg" in
    Coaching|Drills|Reviews|.archive|.inbox|.hook-state)
      emit "allowed" "$ABS" "" "reserved non-project zone"; exit 0 ;;
  esac
  # Already inside a canonical project folder (possibly a not-yet-existing
  # subdirectory of one)? Test each prefix of rel_work, longest first; if any
  # resolves to an existing project, the file lives inside a canonical folder —
  # leave it. This must check prefixes, not just the full path: a write to
  # `mobile-payments/drafts/x.md` (drafts absent) is inside the canonical
  # `mobile-payments` project and must NOT be collapsed to the project root.
  probe="$rel_work"
  while [ -n "$probe" ]; do
    res="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" --project "$probe" --json 2>/dev/null || true)"
    case "$res" in
      *'"status":"ok"'*) emit "allowed" "$ABS" "" "already inside canonical project ($probe)"; exit 0 ;;
    esac
    case "$probe" in
      */*) probe="${probe%/*}" ;;
      *)   probe="" ;;
    esac
  done
fi

# ---- 2. decision tree → choose a target dir ----------------------------------
target_dir=""
branch=""
reason=""

# Non-emoji twin with a recognizable subpath → mirror it into the canonical emoji
# root at the SAME relative path. This covers reserved zones (Coaching/Drills/
# Reviews), project folders, and subdirs uniformly, so a twin file is never
# misrouted into a project or quarantine by the tree below.
if [ "$ctx" = "twin" ] && [ -n "$rel_work" ]; then
  target_dir="$WORK_PHYS/$rel_work"; branch="twin_mirror"
  reason="mirror non-emoji Context/ twin into canonical 📂 Context/Work/"
fi

# (a) slug hint: longest dir-chain (case-insensitive) matching an existing project.
if [ -z "$target_dir" ] && [ -n "$WORK_PHYS" ] && [ -n "$rel_work" ]; then
  existing="$( ( cd "$WORK_DIR" 2>/dev/null && find . -type d ! -name '.' 2>/dev/null ) \
                | sed 's#^\./##' \
                | grep -vE '^(\.archive|\.inbox|\.hook-state|\.git|Coaching|Drills|Reviews)(/|$)' || true )"
  if [ -n "$existing" ]; then
    IFS='/' read -r -a segs <<< "$rel_work"
    i=${#segs[@]}
    while [ "$i" -ge 1 ]; do
      cand="$(IFS=/; printf '%s' "${segs[*]:0:i}")"
      cand_lc="$(lc "$cand")"
      match=""
      while IFS= read -r e; do
        [ -n "$e" ] || continue
        if [ "$(lc "$e")" = "$cand_lc" ]; then match="$e"; break; fi
      done <<< "$existing"
      if [ -n "$match" ]; then
        # Preserve any subdirectory segments after the matched prefix, so a
        # case-drifted `Mobile-Payments/drafts/x.md` folds to
        # `mobile-payments/drafts/x.md`, not `mobile-payments/x.md`.
        rest="$(IFS=/; printf '%s' "${segs[*]:i}")"
        if [ -n "$rest" ]; then target_dir="$WORK_PHYS/$match/$rest"
        else target_dir="$WORK_PHYS/$match"; fi
        branch="slug_hint"
        reason="path segment '$cand' matches project '$match'"
        break
      fi
      i=$((i - 1))
    done
  fi
fi

# (b) exactly one active project.
if [ -z "$target_dir" ]; then
  la="$(bash "$TOOL_ROOT/bin/memory/list-active-projects.sh" --root "$ROOT" --json 2>/dev/null || true)"
  # Count per-entry oks only (each entry ends `"status":"ok"}`); the overall
  # status field is `"status":"ok",` and must not be counted. list-active-projects
  # emits single-line JSON, so we count occurrences with grep -o | wc -l (not
  # grep -c, which counts lines). Trailing `|| true` keeps a zero-match grep (no
  # active project) from tripping `set -e`/pipefail.
  ok_n="$(printf '%s' "$la" | grep -o '"status":"ok"}' | wc -l | tr -d ' ' || true)"
  if [ "$ok_n" = "1" ]; then
    single_path="$(printf '%s' "$la" \
      | grep -o '{"slug":"[^"]*","project_path":"[^"]*","status":"ok"}' \
      | head -1 | sed 's/.*"project_path":"\([^"]*\)".*/\1/')"
    if [ -n "$single_path" ]; then
      target_dir="$single_path"; branch="single_active"
      reason="one active project"
    fi
  fi
fi

# (c) quarantine.
if [ -z "$target_dir" ]; then
  target_dir="${WORK_PHYS:-$WORK_DIR}/.inbox"; branch="quarantine"
  reason="ambiguous — no slug hint and not exactly one active project"
fi

target_path="$target_dir/$base"

# No-op: the file already sits exactly where it should (existing leaf only).
if [ -z "$tail" ] && [ "$target_dir" = "$anc_phys" ]; then
  emit "allowed" "$ABS" "" "already at canonical target"; exit 0
fi

# ---- 3. act per mode ---------------------------------------------------------
case "$MODE" in
  compute)  emit "redirect"       "$ABS" "$target_path" "$reason" "$branch"; exit 0 ;;
  detect)   emit "would_relocate" "$ABS" "$target_path" "$reason" "$branch"; exit 0 ;;
  apply)    : ;;
esac

# --- apply: safe move ---------------------------------------------------------
# S5: never write into a symlinked destination dir; assert physical containment.
if [ -L "$target_dir" ]; then
  emit "error" "$ABS" "$target_dir" "destination dir is a symlink"; exit 0
fi
( umask 077; mkdir -p "$target_dir" ) 2>/dev/null \
  || { emit "error" "$ABS" "$target_dir" "cannot create destination"; exit 0; }
dest_phys="$(cd -P "$target_dir" && pwd)"
if [ -n "$WORK_PHYS" ]; then
  case "$dest_phys/" in
    "$WORK_PHYS"/*) ;;
    *) emit "error" "$ABS" "$dest_phys" "destination escapes Work"; exit 0 ;;
  esac
fi

# Serialize the check-then-move critical section against other --apply
# invocations so the never-overwrite guarantee holds under races (a bare
# [ -e ] check followed by mv has a TOCTOU window). Uses the same atomic
# mkdir-lock pattern as append-events.sh; bounded wait then fail closed.
lock_base="${WORK_PHYS:-$WORK_DIR}"
mkdir -p "$lock_base/.hook-state" 2>/dev/null || true
LOCK="$lock_base/.hook-state/.relocate.lock"
lock_max="${RELOCATE_LOCK_TRIES:-50}"
lock_tries=0
until mkdir "$LOCK" 2>/dev/null; do
  lock_tries=$((lock_tries + 1))
  if [ "$lock_tries" -ge "$lock_max" ]; then
    emit "error" "$ABS" "$target_dir" "could not acquire relocation lock"; exit 0
  fi
  sleep 0.1
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

dst="$dest_phys/$base"
if [ -e "$dst" ]; then
  if [ -L "$dst" ]; then
    emit "error" "$ABS" "$dst" "destination file is a symlink"; exit 0
  fi
  # S8: byte-identical → the source is a duplicate of an already-canonical file.
  if cmp -s -- "$ABS" "$dst"; then
    rm -- "$ABS"
    emit "noop_identical" "$ABS" "$dst" "duplicate of existing canonical file" "$branch"; exit 0
  fi
  # Collision, different content → suffix, never overwrite (S10: bounded).
  stem="${base%.md}"; n=2
  while :; do
    cand="$dest_phys/${stem}-${n}.md"
    [ -e "$cand" ] || break
    n=$((n + 1))
    if [ "$n" -gt 1000 ]; then
      emit "error" "$ABS" "$dest_phys" "collision suffix exhausted"; exit 0
    fi
  done
  dst="$cand"
fi

mv -- "$ABS" "$dst" 2>/dev/null \
  || { emit "error" "$ABS" "$dst" "move failed"; exit 0; }
emit "relocated" "$ABS" "$dst" "$reason" "$branch"
exit 0
