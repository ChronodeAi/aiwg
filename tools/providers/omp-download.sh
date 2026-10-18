#!/usr/bin/env bash
# Fetch only; the caller must verify the pinned digest before executing or caching.
set -euo pipefail

url="${1:?Usage: omp-download.sh URL OUTPUT}"
output="${2:?Usage: omp-download.sh URL OUTPUT}"
partial=$(mktemp "${output}.part.XXXXXX")
trap 'rm -f "$partial"' EXIT

for attempt in 1 2 3 4; do
  echo "Fetching pinned OMP binary (attempt ${attempt}/4)" >&2
  if curl --fail --location --silent --show-error \
    --connect-timeout 15 --max-time 120 --output "$partial" "$url"; then
    mv "$partial" "$output"
    exit 0
  fi
  # Discard incomplete responses before another attempt.
  : > "$partial"
  if (( attempt < 4 )); then
    delay=$((2 ** attempt))
    echo "Pinned OMP binary fetch failed; retrying in ${delay}s" >&2
    sleep "$delay"
  fi
done

echo '::error::Failed to fetch pinned OMP binary after 4 attempts; conformance checks did not run.' >&2
exit 1
