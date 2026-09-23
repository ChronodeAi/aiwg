#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]{4}\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: $0 YYYY.M.PATCH" >&2
  exit 2
fi
for COMMAND in gh jq curl sha256sum; do
  command -v "$COMMAND" >/dev/null || { echo "Missing $COMMAND" >&2; exit 2; }
done

TAG="v${VERSION}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

verify_assets() {
  local DIR="$1"
  for NAME in SHA256SUMS "aiwg-${VERSION}.tgz" install.sh; do
    test -s "$DIR/$NAME" || { echo "Missing $NAME in $DIR" >&2; return 1; }
  done
  (cd "$DIR" && sha256sum -c SHA256SUMS)
}

mkdir -p "$WORK/github" "$WORK/gitea"
gh release view "$TAG" --repo jmagly/aiwg --json isDraft,isPrerelease \
  --jq '(.isDraft == false) and (.isPrerelease == false)' | grep -Fxq true
gh release download "$TAG" --repo jmagly/aiwg --dir "$WORK/github"
verify_assets "$WORK/github"
bash "$WORK/github/install.sh" --dry-run
echo "✓ GitHub release assets, checksums, and installer dry-run: $TAG"

GITEA_RELEASE=$(curl -fsSL "https://git.integrolabs.net/api/v1/repos/roctinam/aiwg/releases/tags/${TAG}")
jq -e --arg tag "$TAG" '.tag_name == $tag' <<< "$GITEA_RELEASE" >/dev/null
while IFS=$'\t' read -r NAME URL; do
  [[ "$NAME" == "$(basename "$NAME")" && -n "$URL" ]] || {
    echo "Invalid Gitea release asset" >&2; exit 1;
  }
  curl -fsSL "$URL" -o "$WORK/gitea/$NAME"
done < <(jq -r '.assets[] | [.name, .browser_download_url] | @tsv' <<< "$GITEA_RELEASE")
verify_assets "$WORK/gitea"
echo "✓ Gitea release assets and checksums: $TAG"
