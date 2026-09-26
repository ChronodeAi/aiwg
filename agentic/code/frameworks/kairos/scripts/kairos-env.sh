# Source from the project root:  . "$FW/scripts/kairos-env.sh"
#
# Sets KAIROS_URL from the project's declared node (.aiwg/kairos/connection/node.json)
# and defines request helpers. The bearer token is read from KAIROS_API_TOKEN at call
# time and passed to curl through a file descriptor, so it never appears in argv,
# shell history or records. Works in bash and zsh.

_kairos_node_file="${KAIROS_NODE_FILE:-.aiwg/kairos/connection/node.json}"
if [ ! -f "$_kairos_node_file" ]; then
  echo "kairos-env: $_kairos_node_file not found; declare the project's node first (kairos-connect step 1)" >&2
  return 1 2>/dev/null || exit 1
fi
_kairos_declared="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["url"].rstrip("/"))' "$_kairos_node_file")" || {
  echo "kairos-env: $_kairos_node_file has no url" >&2
  return 1 2>/dev/null || exit 1
}
if [ -n "${KAIROS_URL:-}" ] && [ "${KAIROS_URL%/}" != "$_kairos_declared" ]; then
  echo "kairos-env: KAIROS_URL=$KAIROS_URL differs from the declared node $_kairos_declared; refusing (kairos-node-isolation)" >&2
  return 1 2>/dev/null || exit 1
fi
KAIROS_URL="$_kairos_declared"
export KAIROS_URL
unset _kairos_declared

# curl against the declared node; adds the bearer header only when a token is set.
kcurl() {
  if [ -n "${KAIROS_API_TOKEN:-}" ]; then
    curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$KAIROS_API_TOKEN") "$@"
  else
    curl -sS "$@"
  fi
}

# kget <path>                 GET  $KAIROS_URL<path>
kget() { kcurl "$KAIROS_URL$1"; }

# kpost <path> <json>         POST JSON to $KAIROS_URL<path>
kpost() { kcurl -X POST "$KAIROS_URL$1" -H 'Content-Type: application/json' -d "$2"; }

# kmcp <json-rpc>             POST one JSON-RPC message to /mcp (protocol 2025-11-25, no Origin header)
kmcp() { kcurl -X POST "$KAIROS_URL/mcp" -H 'Content-Type: application/json' -H 'MCP-Protocol-Version: 2025-11-25' -d "$1"; }

# ktool <json>                POST to the retry-safe agent tool route
ktool() { kpost /api/v1/agent/tools/execute "$1"; }

# kkey <step...>              durable idempotency key: kfw:<pilot>:<step parts> (1-256 chars)
kkey() {
  _k="kfw:${KAIROS_PILOT_ID:?set KAIROS_PILOT_ID to the pilot id from the pilot plan}"
  for _part in "$@"; do _k="$_k:$_part"; done
  if [ "${#_k}" -gt 256 ]; then
    echo "kkey: key longer than 256 characters; shorten the step parts" >&2
    unset _k _part
    return 1
  fi
  printf '%s\n' "$_k"
  unset _k _part
}

# ksave <dir> <name>          save stdin to <dir>/<name> and print "<sha256>  <path>"
ksave() {
  mkdir -p "$1"
  cat > "$1/$2"
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1/$2"; else sha256sum "$1/$2"; fi
}

# kutc                        UTC timestamp for recorded_at
kutc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
