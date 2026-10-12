#!/usr/bin/env bash
# import-ai-memory.sh
#
# Parse a pasted AI-memory dump (from Claude, ChatGPT, Gemini, etc.) into
# structured entries and emit a JSON preview of where each entry would be
# routed: Context files, user-memory.md, or project events. PREVIEW ONLY —
# this script never writes to Context, user-memory, or events.jsonl. The
# `/import-ai-memory` command takes the JSON and walks the user through
# per-file confirmation before invoking the dedicated write helpers
# (append-user-memory.sh, append-events.sh).
#
# Inputs:
#   --input <path>                Path to the pasted AI response (required).
#   --source <enum>               One of: chatgpt|claude|gemini|grok|copilot|perplexity|local|manual (required).
#   --existing-context-dir <path> Path to the user's 📂 Context/ directory. Used
#                                 for conflict and per-session dedup detection.
#                                 Optional — when omitted, no conflict/dedup
#                                 metadata is computed.
#   --root <path>                 Repo-root override (default: script's repo).
#   --json                        Accepted for parity; output is always JSON.
#
# Outputs (single JSON document on stdout):
#   {
#     "status": "ok" | "validation_failed",
#     "source": "<source enum>",
#     "source_ref": "<relative path>",
#     "imported_at": "<ISO8601 UTC>",
#     "auto_detected_source": "<from 'My AI name is:' line>" | null,
#     "routes": [
#       {
#         "destination": "context_file:COMPANY.md" | ... | "user_memory" | "project_event:<slug>",
#         "category": "<universal prompt category label>",
#         "entries": [
#           {
#             "claim": "...", "evidence": "...", "date": "YYYY-MM-DD|unknown",
#             "content_hash": "sha256:<64hex>",
#             "dedup_with_existing": true|false,
#             "conflict_with_existing": "<sample of existing content>" | null
#           }
#         ]
#       }
#     ],
#     "personal_dropped": [ { "category", "claim", "evidence", "date", "reason" } ],
#     "ambiguous": [ { "kind":"heading"|"entry", ... } ],
#     "dedup_skipped_digests": [ "sha256:...", ... ]
#   }
#
# Exit codes:
#   0  success (even when no routes were produced)
#   1  validation failed (missing input, bad source, secret detected, etc.)
#   2  bad arguments

set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
INPUT=""
SOURCE=""
EXISTING_CTX=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --input) INPUT="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --existing-context-dir) EXISTING_CTX="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"

err() {
  # JSON-escape the message so user-supplied values ($SOURCE, $INPUT path) that
  # contain backslashes or double quotes can't malform the output. Pure bash
  # parameter expansion keeps this dependency-free and runs before json_escape
  # (defined later) becomes reachable. Messages never contain newlines/control
  # chars (filenames, enum values, hardcoded prose), so \ and " suffice.
  local msg="$2"
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  printf '{"status":"%s","message":"%s"}\n' "$1" "$msg"
}

case "$SOURCE" in
  chatgpt|claude|gemini|grok|copilot|perplexity|local|manual) ;;
  "") err "validation_failed" "missing --source (allowed: chatgpt|claude|gemini|grok|copilot|perplexity|local|manual)"; exit 1 ;;
  *) err "validation_failed" "unsupported --source value: $SOURCE (allowed: chatgpt|claude|gemini|grok|copilot|perplexity|local|manual)"; exit 1 ;;
esac

[ -n "$INPUT" ] || { err "validation_failed" "missing --input"; exit 1; }
[ -f "$INPUT" ] || { err "validation_failed" "input file not found: $INPUT"; exit 1; }
[ -r "$INPUT" ] || { err "validation_failed" "input file not readable: $INPUT"; exit 1; }

bytes="$(wc -c < "$INPUT" | tr -d '[:space:]')"
if [ "${bytes:-0}" -gt 131072 ]; then
  err "validation_failed" "input exceeds 128 KiB — paste is too large for safe processing"
  exit 1
fi

content="$(cat "$INPUT")"

# Reject true binary / control characters but allow UTF-8 multibyte sequences
# (bytes 0x80-0xFF are not [:cntrl:] under LC_ALL=C, so em dashes etc. pass).
if LC_ALL=C tr -d '\t\n\r' < "$INPUT" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  err "validation_failed" "binary or non-printable content rejected"
  exit 1
fi

# Secret / sensitive-content guard (same regex family as append-user-memory.sh).
shopt -s nocasematch
if [[ "$content" =~ sk-[A-Za-z0-9_-]{20,} ]] \
  || [[ "$content" =~ ghp_[A-Za-z0-9_]{20,} ]] \
  || [[ "$content" =~ xox[baprs]-[A-Za-z0-9-]{20,} ]] \
  || [[ "$content" =~ AKIA[0-9A-Z]{16} ]] \
  || [[ "$content" =~ -----BEGIN[[:space:]][A-Z[:space:]]*PRIVATE\ KEY----- ]]; then
  shopt -u nocasematch
  err "validation_failed" "possible secret detected in paste — remove it from the source AI's output and try again"
  exit 1
fi
shopt -u nocasematch

now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      sub(/\r$/, "")
      if (NR > 1) printf "\\n"
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "\\") printf "\\\\"
        else if (c == "\"") printf "\\\""
        else if (c == "\t") printf "\\t"
        else if (c == "\r") printf "\\r"
        else if (c == "\b") printf "\\b"
        else if (c == "\f") printf "\\f"
        else printf "%s", c
      }
    }
  ' <<EOF
$1
EOF
}

# Parse the paste with awk → TSV of `cat_num<TAB>claim<TAB>evidence<TAB>date`.
# Off-schema headings go to AMBIG. `My AI name is: <X>` goes to META.
PARSED="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.parsed.XXXXXX")"
META="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.meta.XXXXXX")"
AMBIG="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.ambig.XXXXXX")"
ROUTE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.pm-os-import.routes.XXXXXX")"
PERSONAL_FILE="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.personal.XXXXXX")"
AMBIG_ENTRY_FILE="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.ambigent.XXXXXX")"

cleanup() {
  rm -f "$PARSED" "$META" "$AMBIG" "$PERSONAL_FILE" "$AMBIG_ENTRY_FILE"
  [ -n "$ROUTE_DIR" ] && [ -d "$ROUTE_DIR" ] && rm -rf "$ROUTE_DIR"
}
trap cleanup EXIT INT TERM

awk -v meta="$META" -v ambig="$AMBIG" '
function flush() {
  if (entry != "") {
    date_field = "unknown"
    if (match(evidence, /Date:[ ]*[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
      d = substr(evidence, RSTART, RLENGTH)
      sub(/Date:[ ]*/, "", d)
      date_field = d
      sub(/[ ]*Date:[ ]*[0-9]{4}-[0-9]{2}-[0-9]{2}\.?[ ]*$/, "", evidence)
    } else if (match(evidence, /Date:[ ]*unknown/)) {
      date_field = "unknown"
      sub(/[ ]*Date:[ ]*unknown\.?[ ]*$/, "", evidence)
    }
    gsub(/\t/, " ", entry)
    gsub(/\t/, " ", evidence)
    printf "%d\t%s\t%s\t%s\n", cat_num, entry, evidence, date_field
    entry = ""; evidence = ""
  }
}
BEGIN { cat_num = 0; entry = ""; evidence = "" }
/^## [1-7]\. / {
  flush()
  cat_num = substr($0, 4, 1) + 0
  next
}
/^## / {
  flush()
  cat_num = 0
  h = substr($0, 4)
  gsub(/\r$/, "", h)
  print h > ambig
  next
}
/^My AI name is:/ {
  flush()
  n = $0
  sub(/^My AI name is:[ ]*/, "", n)
  gsub(/\r$/, "", n)
  lo = tolower(n)
  print "self_id\t" lo > meta
  next
}
/^\* \(No stored entries\.\)/ { flush(); next }
/^\* / {
  flush()
  entry = substr($0, 3)
  gsub(/\r$/, "", entry)
  next
}
/^[ \t]+\* [Ee]vidence:/ {
  e = $0
  sub(/^[ \t]+\* [Ee]vidence:[ ]*/, "", e)
  gsub(/\r$/, "", e)
  evidence = e
  next
}
END { flush() }
' "$INPUT" > "$PARSED"

AUTO_SOURCE=""
if [ -s "$META" ]; then
  raw="$(awk -F'\t' '/^self_id\t/ { print $2; exit }' "$META")"
  case "$raw" in
    *chatgpt*|*"chat gpt"*) AUTO_SOURCE="chatgpt" ;;
    *claude*) AUTO_SOURCE="claude" ;;
    *gemini*) AUTO_SOURCE="gemini" ;;
    *grok*) AUTO_SOURCE="grok" ;;
    *copilot*) AUTO_SOURCE="copilot" ;;
    *perplexity*) AUTO_SOURCE="perplexity" ;;
  esac
fi

# A Context file counts as "filled" if at least one line is not blank,
# not a heading (`#`-prefixed), not a bracketed placeholder (`[...]`), and
# not a frontmatter delimiter.
is_filled() {
  local f="$1"
  [ -f "$f" ] || return 1
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ { next }
    /^---[[:space:]]*$/ { next }
    { found=1; exit }
    END { exit !found }
  ' "$f"
}

existing_sample() {
  local f="$1"
  [ -f "$f" ] || return 0
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ { next }
    /^---[[:space:]]*$/ { next }
    { print substr($0, 1, 200); exit }
  ' "$f"
}

# Map (category, claim) → routing tag. Returns one of:
#   drop | ambiguous | COMPANY | PRODUCTS | TEAM | GOALS | CONSTRAINTS
#   | STAKEHOLDERS | MY_STYLE | user_memory | project_event
classify() {
  local cat="$1"
  local claim_lower
  claim_lower="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  case "$cat" in
    1)
      # Demographics: drop by default; profession/role tokens → ambiguous so
      # the user can opt into adding job title to TEAM / MY_STYLE manually.
      case "$claim_lower" in
        *" pm"*|*"product manager"*|*"engineer"*|*"designer"*|*"director"*|*" vp"*|*"ceo"*|*"head of"*|*" lead"*|*"principal"*|*"founder"*)
          echo "ambiguous" ;;
        *) echo "drop" ;;
      esac
      ;;
    2) echo "drop" ;;
    3)
      case "$claim_lower" in
        *"partner"*|*"spouse"*|*"wife"*|*"husband"*|*"married"*|*"boyfriend"*|*"girlfriend"*|*" son "*|*" daughter"*|*" child"*|*" kid"*|*"family"*|*"mother"*|*"father"*|*"sister"*|*"brother"*|*"parent"*|*"friend"*|*"dog"*|*" cat "*|*" pet"*)
          echo "drop" ;;
        *"reports to"*|*"manager"*|*"colleague"*|*" vp "*|*"vp of "*|*"vp,"*|*"ceo"*|*"cto"*|*"cfo"*|*"coo"*|*"chief"*|*"head of"*|*"director"*|*"engineer"*|*"designer"*|*"product manager"*|*"stakeholder"*|*"customer"*|*"lead "*|*"principal"*|*"senior "*|*" staff"*)
          echo "STAKEHOLDERS" ;;
        *) echo "ambiguous" ;;
      esac
      ;;
    4)
      case "$claim_lower" in
        *"constraint"*|*"cannot ship"*|*"can't ship"*|*"blocks"*|*" legal"*|*"budget"*|*"regulatory"*|*"deadline"*|*"compliance"*)
          echo "CONSTRAINTS" ;;
        *"goal"*|*"okr"*|*" q1 "*|*" q2 "*|*" q3 "*|*" q4 "*|*"target"*|*"grow "*|*"growth"*|*" by 1"*|*" by 2"*|*" by 3"*|*" by 4"*|*" by 5"*|*" by 6"*|*" by 7"*|*" by 8"*|*" by 9"*)
          echo "GOALS" ;;
        *"team"*|*"engineers"*|*"designers"*|*"pms"*|*"head count"*|*"headcount"*|*"pod"*|*"squad"*)
          echo "TEAM" ;;
        *"works at"*|*"company"*|*"industry"*|*"fintech"*|*"saas"*|*"startup"*|*"enterprise"*|*"b2b"*|*"b2c"*)
          echo "COMPANY" ;;
        *"product"*|*"owns the "*|*"manages "*|*"feature"*|*"platform"*)
          echo "PRODUCTS" ;;
        *) echo "ambiguous" ;;
      esac
      ;;
    5) echo "project_event" ;;
    6) echo "user_memory" ;;
    7) echo "MY_STYLE" ;;
    *) echo "ambiguous" ;;
  esac
}

cat_name() {
  case "$1" in
    1) echo "1. Demographics" ;;
    2) echo "2. Interests & Preferences" ;;
    3) echo "3. Relationships" ;;
    4) echo "4. Work Context" ;;
    5) echo "5. Dated Events, Projects & Plans" ;;
    6) echo "6. Instructions" ;;
    7) echo "7. Style & Communication Preferences" ;;
    *) echo "" ;;
  esac
}

destination_string() {
  case "$1" in
    COMPANY|PRODUCTS|TEAM|GOALS|CONSTRAINTS|STAKEHOLDERS|MY_STYLE) echo "context_file:$1.md" ;;
    user_memory) echo "user_memory" ;;
    project_event) echo "project_event:work" ;;
    *) echo "$1" ;;
  esac
}

destination_file_path() {
  case "$1" in
    COMPANY|PRODUCTS|TEAM|GOALS|CONSTRAINTS|STAKEHOLDERS|MY_STYLE)
      if [ -n "$EXISTING_CTX" ]; then
        printf '%s/%s.md' "$EXISTING_CTX" "$1"
      fi
      ;;
    user_memory)
      printf '%s/📂 Context/Work/.hook-state/user-memory.md' "$ROOT"
      ;;
    *) : ;;
  esac
}

while IFS=$'\t' read -r cat claim evidence date_field; do
  [ -n "${cat:-}" ] || continue
  [ -n "${claim:-}" ] || continue
  tag="$(classify "$cat" "$claim")"
  cat_label="$(cat_name "$cat")"
  hash_basis="$claim|$evidence|$date_field"
  digest="sha256:$(printf '%s' "$hash_basis" | shasum -a 256 | awk '{print $1}')"

  if [ "$tag" = "drop" ]; then
    printf '%s\t%s\t%s\t%s\n' "$cat_label" "$claim" "$evidence" "$date_field" >> "$PERSONAL_FILE"
    continue
  fi
  if [ "$tag" = "ambiguous" ]; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$cat_label" "$claim" "$evidence" "$date_field" "$digest" >> "$AMBIG_ENTRY_FILE"
    continue
  fi

  dedup="false"
  conflict=""
  dest_file="$(destination_file_path "$tag")"
  if [ -n "$dest_file" ] && [ -f "$dest_file" ]; then
    if grep -qF -- "$claim" "$dest_file" 2>/dev/null; then
      dedup="true"
    elif is_filled "$dest_file"; then
      conflict="$(existing_sample "$dest_file")"
    fi
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cat_label" "$claim" "$evidence" "$date_field" "$digest" "$dedup" "$conflict" >> "$ROUTE_DIR/$tag"
done < "$PARSED"

emit_entry_obj() {
  local claim="$1" evidence="$2" date_field="$3" digest="$4" dedup="$5" conflict="$6"
  printf '{"claim":"%s","evidence":"%s","date":"%s","content_hash":"%s","dedup_with_existing":%s,"conflict_with_existing":' \
    "$(json_escape "$claim")" \
    "$(json_escape "$evidence")" \
    "$(json_escape "$date_field")" \
    "$digest" \
    "$dedup"
  if [ -n "$conflict" ] && [ "$dedup" != "true" ]; then
    printf '"%s"' "$(json_escape "$conflict")"
  else
    printf 'null'
  fi
  printf '}'
}

emit_route_obj() {
  local tag="$1"
  local file="$ROUTE_DIR/$tag"
  [ -f "$file" ] || return 0
  local dest cat_label
  dest="$(destination_string "$tag")"
  cat_label="$(awk -F'\t' 'NR==1 { print $1; exit }' "$file")"
  printf '{"destination":"%s","category":"%s","entries":[' "$dest" "$(json_escape "$cat_label")"
  local first=1
  while IFS=$'\t' read -r cl cm ev dt dg dd cf; do
    if [ "$first" = "1" ]; then first=0; else printf ','; fi
    emit_entry_obj "$cm" "$ev" "$dt" "$dg" "$dd" "$cf"
  done < "$file"
  printf ']}'
}

IMPORTED_AT="$(now_utc)"
src_ref="$INPUT"
case "$INPUT" in
  "$ROOT"/*) src_ref="${INPUT#$ROOT/}" ;;
esac

printf '{'
printf '"status":"ok",'
printf '"source":"%s",' "$SOURCE"
printf '"source_ref":"%s",' "$(json_escape "$src_ref")"
printf '"imported_at":"%s",' "$IMPORTED_AT"
if [ -n "$AUTO_SOURCE" ]; then
  printf '"auto_detected_source":"%s",' "$AUTO_SOURCE"
else
  printf '"auto_detected_source":null,'
fi

printf '"routes":['
route_first=1
for tag in COMPANY PRODUCTS TEAM GOALS CONSTRAINTS STAKEHOLDERS MY_STYLE user_memory project_event; do
  [ -f "$ROUTE_DIR/$tag" ] || continue
  if [ "$route_first" = "1" ]; then route_first=0; else printf ','; fi
  emit_route_obj "$tag"
done
printf '],'

printf '"personal_dropped":['
pd_first=1
if [ -s "$PERSONAL_FILE" ]; then
  while IFS=$'\t' read -r cat_label claim evidence date_field; do
    if [ "$pd_first" = "1" ]; then pd_first=0; else printf ','; fi
    printf '{"category":"%s","claim":"%s","evidence":"%s","date":"%s","reason":"personal-only category"}' \
      "$(json_escape "$cat_label")" \
      "$(json_escape "$claim")" \
      "$(json_escape "$evidence")" \
      "$(json_escape "$date_field")"
  done < "$PERSONAL_FILE"
fi
printf '],'

printf '"ambiguous":['
ab_first=1
if [ -s "$AMBIG" ]; then
  while IFS= read -r heading; do
    [ -n "$heading" ] || continue
    if [ "$ab_first" = "1" ]; then ab_first=0; else printf ','; fi
    printf '{"kind":"heading","raw":"%s","reason":"unrecognised section heading"}' "$(json_escape "$heading")"
  done < "$AMBIG"
fi
if [ -s "$AMBIG_ENTRY_FILE" ]; then
  while IFS=$'\t' read -r cat_label claim evidence date_field digest; do
    if [ "$ab_first" = "1" ]; then ab_first=0; else printf ','; fi
    printf '{"kind":"entry","category":"%s","claim":"%s","evidence":"%s","date":"%s","content_hash":"%s","reason":"category routing requires user choice"}' \
      "$(json_escape "$cat_label")" \
      "$(json_escape "$claim")" \
      "$(json_escape "$evidence")" \
      "$(json_escape "$date_field")" \
      "$digest"
  done < "$AMBIG_ENTRY_FILE"
fi
printf '],'

printf '"dedup_skipped_digests":['
ds_first=1
for tag in COMPANY PRODUCTS TEAM GOALS CONSTRAINTS STAKEHOLDERS MY_STYLE user_memory project_event; do
  [ -f "$ROUTE_DIR/$tag" ] || continue
  while IFS=$'\t' read -r cl cm ev dt dg dd cf; do
    if [ "$dd" = "true" ]; then
      if [ "$ds_first" = "1" ]; then ds_first=0; else printf ','; fi
      printf '"%s"' "$dg"
    fi
  done < "$ROUTE_DIR/$tag"
done
printf ']'
printf '}\n'
