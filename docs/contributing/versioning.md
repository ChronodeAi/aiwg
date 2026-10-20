# Versioning Guide

**Version:** 1.0
**Last Updated:** 2026-07-23
**Target Audience:** All contributors and AI agents

## Overview

AIWG uses **Calendar Versioning (CalVer)** with npm-compatible format. This document explains the versioning scheme and critical rules to avoid npm publishing failures.

## Version Format

```
YYYY.M.PATCH
```

| Component | Description                                   | Example       |
| --------- | --------------------------------------------- | ------------- |
| `YYYY`    | Four-digit year                               | `2026`        |
| `M`       | Month (1-12, **NO leading zeros**)            | `1`, `12`     |
| `PATCH`   | Patch number within month (resets each month) | `0`, `1`, `5` |

### Examples

| Correct     | Incorrect    | Why                              |
| ----------- | ------------ | -------------------------------- |
| `2026.1.0`  | `2026.01.0`  | Leading zero in month            |
| `2026.1.5`  | `2026.01.05` | Leading zeros in month and patch |
| `2026.12.0` | `2026.12.00` | Leading zero in patch            |

## Critical Rule: No Leading Zeros

**npm's semver parser rejects leading zeros.** This is per the [Semantic Versioning spec](https://semver.org/):

> A normal version number MUST take the form X.Y.Z where X, Y, and Z are non-negative integers, and **MUST NOT contain leading zeroes**.

### What Happens With Leading Zeros

```bash
# This FAILS
$ npm -g update aiwg
npm error Invalid Version: 2026.01.4

# This WORKS (same package, different command)
$ npm -g install aiwg
# Installs successfully but update is broken
```

The `npm install` command is more lenient than `npm update`. Users will be able to install but not update, causing confusion and support issues.

## Tag Format

Git tags should match the version with a `v` prefix:

```bash
# Correct
git tag -a v2026.1.5 -m "v2026.1.5 - Feature Name"

# Incorrect
git tag -a v2026.01.5 -m "v2026.01.5 - Feature Name"
```

## Release Workflow

### 1. Update package.json

```json
{
  "version": "2026.1.5"
}
```

**Validation**: Run this to check for leading zeros:

```bash
grep '"version"' package.json | grep -E '\.[0-9]{2}\.' && echo "ERROR: Leading zero detected!" || echo "OK: No leading zeros"
```

### 2. Update CHANGELOG.md

```markdown
## [2026.1.5] - 2026-01-14 – "Release Name"
```

### 3. Create and Push Tag

**Tag signing is mandatory** as of #1299 (A9). CI rejects any release tag whose signature does not verify against a maintainer public key in `.gitea/keys/maintainers.asc` (GPG) or `.gitea/allowed_signers` (SSH). The verify step lives in `.gitea/workflows/npm-publish.yml` and `.gitea/workflows/gitea-release.yml` and is implemented by [`tools/ci/verify-signed-tag.sh`](../../tools/ci/verify-signed-tag.sh).

`tools/release/cut-tag.sh` sources the release-signing key from vault itself
(no manual keyring hydration): it fetches the key + machine passphrase into an
ephemeral `GNUPGHOME`, signs the tag with loopback pinentry, verifies, and
removes the temporary keyring on exit. The operator only supplies the
reader-AppRole credentials.

```bash
# Commit the release prep (personal key — GitHub Verified)
git commit -S -m "docs(release): prepare 2026.X.Y artifacts"

# Follow the private itops release-signing runbook to source the mode-0600
# ci-aiwg bootstrap and export VAULT_ADDR, VAULT_CACERT, and the four
# RELEASE_SIGNING_* route variables. This public repository intentionally omits
# concrete provider paths and fields. Never print or copy bootstrap values into
# a project file.

# Cut the signed tag — fetches the vault key, signs with the release-only key,
# supplies its passphrase through batch loopback pinentry (no dialog), and runs
# the local verify gate. Never call `git tag` by hand.
tools/release/cut-tag.sh 2026.X.Y

# Push to Gitea (triggers gitea-release + npm-publish; the CI verify-signed-tag
# gate validates the signature against .gitea/keys/maintainers.asc)
git push origin main --tags

# Mirror the signed tag to GitHub. Push it yourself so GitHub receives the
# original signed annotated tag object; the workflow never synthesizes or
# peels a tag. github-mirror.yml waits up to five minutes for this push before
# creating the verified GitHub release.
git push github main --tags

unset VAULT_CI_ROLE_ID VAULT_CI_SECRET_ID VAULT_ADDR VAULT_CACERT
unset RELEASE_SIGNING_KEY_VAULT_PATH RELEASE_SIGNING_KEY_VAULT_FIELD
unset RELEASE_SIGNING_PASSPHRASE_VAULT_PATH RELEASE_SIGNING_PASSPHRASE_VAULT_FIELD
```

**Signing-key custody note**: the active release-signing key is
`401584AAA3376B898FB34427839584D0E25E5126` (`AIWG Release Signing`). Its private
material and passphrase live vault-only; the concrete route is governed by the
private itops runbook and intentionally omitted here. The separate
`9292EFCBB0EA41BECEEFDAFA9C1B8CE0E0E09C33` key signed `v2026.7.12` and remains
published for historical verification, but it is not the active release key.
CI only pulls repository contents and verifies tags against committed public
keys — it does not need private-key access for verification.

The encrypted recovery copy governed by the private itops runbook contains the
`ci-aiwg` AppRole bootstrap pair only. It does not contain the release key or
passphrase. Never restore those bootstrap values into project configuration or
commit the recovery-medium path or manifest here.

Vault source of truth:

- SOP: private itops secret-management and release-signing runbooks.
- Release key route: `RELEASE_SIGNING_KEY_VAULT_PATH` and
  `RELEASE_SIGNING_KEY_VAULT_FIELD`.
- Release passphrase route: `RELEASE_SIGNING_PASSPHRASE_VAULT_PATH` and
  `RELEASE_SIGNING_PASSPHRASE_VAULT_FIELD`.
- Reader AppRole: `ci-aiwg`, provided to CI as `VAULT_CI_ROLE_ID` and
  `VAULT_CI_SECRET_ID`.
- Commit signing route: private maintainer vault routing, not stored in this
  repository.

Fork / offline signing: set `AIWG_RELEASE_SIGN_FROM_VAULT=0` to sign with a key
already in the local GPG keyring, and `AIWG_RELEASE_KEY_FINGERPRINT=<fpr>` to
override the key.

#### Signing your release tag — first-time setup

The CI verify gate requires (a) a maintainer signing key, (b) that key's public component committed under `.gitea/keys/` or `.gitea/allowed_signers`, and (c) tags created with `git tag -s`. Pick one of GPG or SSH and follow the matching procedure.

**Option A — GPG signing (preferred for long-lived release keys):**

```bash
# 1. Generate a project-scoped key (NOT your personal key)
gpg --quick-generate-key 'AIWG Release Signing <release@aiwg.io>' ed25519 sign 5y

# 2. Find the key id
gpg --list-secret-keys --keyid-format=long
#   sec   ed25519/ABCD1234EFGH5678 2026-05-12 [SC] [expires: 2031-05-12]
#         <fingerprint>

# 3. Configure git to sign tags by default with this key
git config --global user.signingkey ABCD1234EFGH5678
git config --global tag.gpgSign true

# 4. Publish the public key to the repo
gpg --armor --export ABCD1234EFGH5678 >> .gitea/keys/maintainers.asc
git add .gitea/keys/maintainers.asc
git commit -m "security: add maintainer release signing key (refs #1299)"
git push origin main

# 5. Induct the PRIVATE key into vault, then delete the working export.
#    Follow /home/roctinam/dev/itops/docs/security/secret-management-sop.md
#    and use /home/roctinam/dev/itops/scripts/secret-induct.sh so the key is
#    streamed from a file and never printed.

# 6. Update SECURITY.md "Maintainer Signing Keys" section with the
#    fingerprint, then commit + push.

# 7. Make a test signed tag to verify end-to-end:
git tag -s vYYYY.M.PATCH-rc.0 -m "vYYYY.M.PATCH-rc.0 - signing-setup verification"
git push origin vYYYY.M.PATCH-rc.0
#    Watch the resulting workflow run. The "Verify signed tag" step should
#    print "✓ Tag <name> verified successfully."
```

**Option B — SSH signing (works with YubiKey / hardware-backed keys):**

```bash
# 1. Generate a project-scoped SSH key (NOT your personal key). Use a
#    hardware-backed sk-ed25519 variant if you have a YubiKey or similar.
ssh-keygen -t ed25519 -f ~/.ssh/aiwg-release-signing -C 'aiwg-release-signing'
#    (or: ssh-keygen -t ed25519-sk -f ~/.ssh/aiwg-release-signing-sk)

# 2. Configure git to sign tags with SSH
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/aiwg-release-signing.pub
git config --global tag.gpgSign true

# 3. Publish the public key in OpenSSH allowed-signers format
echo "release@aiwg.io $(cat ~/.ssh/aiwg-release-signing.pub)" >> .gitea/allowed_signers
git add .gitea/allowed_signers
git commit -m "security: add maintainer release signing key (refs #1299)"
git push origin main

# 4. Update SECURITY.md, test-tag, etc. — same as GPG steps 5-6.
```

#### Two-key model — what to use when

Per the convention established in commit `a13dabc5` ("two-key model — personal key signs commits, release key signs tags"), AIWG maintainers use **two keys with two separate purposes**:

| Purpose                   | Key                                                                     | UID                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Commit signing**        | project-dedicated AIWG commit key from the maintainer vault route       | `AIWG Commit Signing <1159087+jmagly@users.noreply.github.com>`                                                           |
| **Tag signing (release)** | project-dedicated AIWG release key from the release signing vault route | `AIWG Release Signing <1159087+jmagly@users.noreply.github.com>` (fingerprint `401584AAA3376B898FB34427839584D0E25E5126`) |

This has one operational gotcha: a typical maintainer git config has `tag.gpgsign=true` AND `user.signingkey=<personal-key>` so commits sign correctly. But `git tag -s` (and even `git tag -a` with `tag.gpgsign=true`) then signs the **tag** with the **personal key** — wrong key for the supply-chain gate.

**Always cut tags via the wrapper:**

```bash
tools/release/cut-tag.sh 2026.X.Y
```

The wrapper forces `-u <release-key-fingerprint>` via `git tag -s -u …` so the right key signs the tag regardless of the global `user.signingkey`. It also verifies CalVer and package lockstep (including `@aiwg/cli`), release documentation, signing-key availability, and the resulting tag before reporting the push command, so common drift bugs fail locally rather than in CI.

If the wrapper says the release key is missing, hydrate a temporary GPG home from
the configured vault route first:

```bash
set +x
umask 077
export GNUPGHOME="${XDG_RUNTIME_DIR:-/dev/shm}/aiwg-gpg-release.$$"
mkdir -p "$GNUPGHOME"
GITHUB_ENV="$(mktemp)" ci/vault-fetch.sh --spec ci/vault-fetch.release-signing.spec
. "$GITHUB_ENV"
gpg --batch --import "$GPG_SIGNING_KEY_FILE"
gpg --list-secret-keys --keyid-format LONG
```

When the command sees `AIWG Release Signing <release@aiwg.io>`, rerun
`cut-tag.sh` in the same shell so it uses that temporary `GNUPGHOME`.

**v2026.5.5 incident** (2026-05-14) — for posterity: an agent ran `git tag -a v2026.5.5 -m "…"` directly, which signed with the personal commit-signing key. The supply-chain gate caught it across **three workflows** (Gitea `npm-publish`, Gitea `gitea-release`, GitHub mirror release) and refused to publish any artifacts. No bad release left the gate. Recovery was `git tag -d` + `git push origin :refs/tags/<tag>` + push to remote, then `tools/release/cut-tag.sh <version>`. The wrapper script was added in the same fix commit so the next release ceremony won't repeat the mistake.

#### Rotation and revocation

Rotate maintainer signing keys on a known cadence (suggested: every 2 years) and
immediately on any suspected compromise of the maintainer's workstation or
vault secret path. To rotate:

1. Generate the new key per the setup procedure above.
2. Add its public component to the same `.gitea/keys/maintainers.asc` or `.gitea/allowed_signers` file (do not remove the old key yet — it's still trusted for past releases).
3. Induct the new private key into the relevant vault path and update its KV metadata.
4. After at least one release with the new key has been verified end-to-end, remove the old key from the public-key file in a documented commit and update SECURITY.md.

#### Historical tags

Release tags created before #1299 landed (`v2026.5.2` and earlier) are **not retroactively signed**. The CI gate fires only on tag pushes (`on: push: tags: [v*]`), so old releases keep their existing un-signed annotations. The gate is forward-going only.

### 4. Verify Published Version

After CI/CD completes:

```bash
npm view aiwg version
npm view @aiwg/cockpit version
npm view @aiwg/cli version
# All three should show: 2026.1.5
```

The GitHub trusted-publishing workflow publishes `aiwg`, `@aiwg/cockpit`, and
`@aiwg/cli` at the same CalVer. It verifies each requested dist-tag and each
package's provenance attestation before completing.

For stable releases, OIDC sets `latest` during publication. The workflow does
not create, advance, or maintain an npm `next` dist-tag. `next` is retired from
the public registry: removing it requires a one-time authenticated npm account
session because trusted publishing authorizes publication, not dist-tag edits.
The post-release gate checks that `latest` matches the release and `next` is
absent for all three packages.

### 5. Mirror signed release assets to the Gitea release

Once `.github/workflows/npm-publish.yml` finishes on the GitHub mirror, the GitHub release for the new tag carries the release evidence mirrored by this step:

- `aiwg-X.Y.Z.tgz` (the published tarball)
- `aiwg-X.Y.Z.tgz.sigstore` (cosign keyless signature bundle)
- `release-manifest.json` (audit manifest — SHA-256, version, tag, commit, workflow run URL)
- `release-manifest.json.sigstore` (cosign keyless signature bundle for the manifest)
- `aiwg-X.Y.Z.cdx.json` and `.sigstore` (CycloneDX SBOM and signature bundle)
- `install.sh` and `SHA256SUMS` (installer plus the release-asset checksum manifest)

The Gitea-side release does NOT auto-mirror these — to avoid expanding the Gitea write-token surface that Wave 4 reduced (#1283, #1286), the mirror is a single explicit operator command after the GitHub workflow lands the assets. Run:

```bash
gh workflow run upload-release-sigs.yml \
  --repo roctinam/aiwg \
  -f tag=vYYYY.M.PATCH
```

…or trigger it from the Gitea Actions UI (Actions → "Mirror signed release assets to Gitea release" → Run workflow → enter the tag).

The workflow downloads these assets from the public GitHub mirror and uploads them to the Gitea release with a vault-provided Gitea release token. Re-runs are idempotent — duplicate-name uploads are detected (HTTP 409) and the existing asset is deleted then re-uploaded.

Verify both releases have the four sig assets attached:

| Release | URL                                                                    |
| ------- | ---------------------------------------------------------------------- |
| GitHub  | <https://github.com/jmagly/aiwg/releases/tag/vYYYY.M.PATCH>            |
| Gitea   | <https://git.integrolabs.net/roctinam/aiwg/releases/tag/vYYYY.M.PATCH> |

Consumer verification commands (cosign-based, registry-independent) are documented in [`docs/releases/verifying.md`](../releases/verifying.md). See [`#1287`](https://git.integrolabs.net/roctinam/aiwg/issues/1287) and [the A8 ADR](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/adr-tarball-cosign-signing.md) for the full rationale.

#### Attested web publication ordering

After the Gitea release assets are present and independently rechecked, the
same workflow dispatches the private web-release publisher with an
`aiwg.web-release-handoff/v1` contract. The handoff is bound to exact
`setup.aiwg.yaml` and `agentic.yaml` bytes from the verified signed tag and
requires:

- an adjacent AIWG attestation descriptor for each published YAML, flow bundle,
  and selected prebuilt index;
- descriptor path, SHA-256, exact byte length, and media type in the signed web
  release manifest;
- compatibility with signed `aiwg.resource-manifest/v1` and v2 consumers;
- monotonic sequence and expiry for stable-channel metadata; and
- a site callback only after the signed release and sidecars are published.

`notify-site.yml` is therefore recovery/callback-only; tag pushes no longer race
the attestation publisher. Its descriptor payload helps aiwg.io locate the
expected objects, but the site must verify the signed web manifest and exact
digests. CDN ETags, Last-Modified, Content-Type, and Content-Length never replace
that verification.

The repository-owned [`agentic.yaml`](../../agentic.yaml) is the authoritative
agent handoff source. It is deliberately distinct from `setup.aiwg.yaml`: the
first manifest requires local verification and binds the handoff, while the
second contains the installation plan. Release CI reads both exact files from
the verified signed tag and never aliases, copies, or synthesizes either one.
Disabling attestation emission for rollback likewise leaves prior sidecars,
signed manifests, and trusted sequence state intact.

## Release Gates

In addition to the four steps above, the following CI workflows act as **release gates** — a failure on any of these blocks the release.

| Gate                                           | Workflow                                                                                                                  | Trigger                               | What it proves                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration tests                       | `.gitea/workflows/ci.yml`                                                                                                 | push to main, tag, PR                 | Code changes did not regress the suite                                                                                                                                                              |
| Executor-contract conformance (fixture mode)   | `.gitea/workflows/ci.yml` (`test:conformance` step)                                                                       | every CI run                          | Static fixture replay still matches the contract schema                                                                                                                                             |
| **A2A conformance against agentic-sandbox v2** | `.gitea/workflows/conformance.yml`                                                                                        | version tags, manual, opt-in PR label | AIWG's A2A client interoperates with a live sandbox v2 instance — proves end-to-end interop, not just contract shape (#1258). Skips automatically while upstream sandbox v2 is pre-release.         |
| Build verification                             | `.gitea/workflows/ci.yml` (`build` job)                                                                                   | every CI run                          | `npm run build` produces deployable artifacts                                                                                                                                                       |
| **Dependency source policy**                   | `.gitea/workflows/ci.yml` (`Lint dependency sources` step)                                                                | every CI run                          | No `git+`, `github:`, tarball, `file:`, or `link:` dep sources outside the allowlist (#1300 / A20)                                                                                                  |
| **Signed-tag verify**                          | `.gitea/workflows/npm-publish.yml` + `gitea-release.yml` + `.github/workflows/npm-publish.yml` (`Verify signed tag` step) | tag push                              | Release tag is cryptographically signed by a maintainer key published in `.gitea/keys/` or `.gitea/allowed_signers` (#1299 / A9)                                                                    |
| **Cosign tarball signature**                   | `.github/workflows/npm-publish.yml` (`Generate tarball + cosign sign + manifest` step)                                    | tag push                              | Published tarball + release manifest are signed via Sigstore keyless OIDC, attached to the GitHub release, mirrored to the Gitea release by `.gitea/workflows/upload-release-sigs.yml` (#1287 / A8) |

### A2A Conformance Gate Details

The `A2A Conformance` workflow provisions a reference agentic-sandbox instance via Docker Compose, builds the `roctinam/agentic-sandbox-conformance` Go harness, and runs the suite end-to-end. The separate `npm run uat:serve-live` lane exercises AIWG's own versioned client; set `AIWG_A2A_LIVE_DISPATCH=1 AIWG_A2A_LIVE_REQUIRE_BOTH=1` for a release qualification that requires live 0.3 and 1.0 interfaces. Mock and fixture results are recorded separately and do not substitute for this live lane. Failure blocks the release.

- **What to do on green**: proceed with tagging.
- **What to do on red**: open the run, download the `conformance-reports-*` artifact (`report.md` + `report.junit.xml`), and diagnose. Common categories of failure are listed in the harness's own `report.md`. Do **not** force a stable tag past a red conformance run without explicit issue documentation and a follow-up tracking issue — that's how interop regressions ship.
- **Workflow inputs**: the manual-dispatch form accepts `sandbox_ref` and `conformance_ref` for pinned-ref retries (e.g., to verify a fix against a specific sandbox commit before the release engineer is back online).

## npm publication channel

The npm release pipeline accepts only stable CalVer tags matching
`vYYYY.M.PATCH`. It publishes `aiwg`, `@aiwg/cli`, and `@aiwg/cockpit` at the
same version. GitHub Actions trusted publishing sets `latest` on npmjs.org;
Gitea Actions sets `latest` on its package mirror and removes its old `next`
alias. The public npm `next` alias requires a one-time authenticated removal.
The release plan remains incomplete until `latest` matches and `next` is absent
on npmjs.org. The pipeline does not publish nightly, alpha, beta, or RC versions.

```bash
# One-time public registry cleanup from an authenticated npm account session.
for package in aiwg @aiwg/cli @aiwg/cockpit; do
  npm dist-tag rm "$package" next --registry=https://registry.npmjs.org
done
# After CI publishes the new version:
VERSION="$(node -p "require('./package.json').version")"
bash tools/release/verify-npm-dist-tags.sh "$VERSION"
```

Use source checkouts and ordinary test/CI branches for work that needs to be
validated before release. AIWG update channels are separate from npm dist-tags.

## Version Progression Examples

### Within a Month

```
2026.1.0  → First release in January 2026
2026.1.1  → Bug fix
2026.1.2  → Another fix
2026.1.3  → Feature addition
```

### Month Transitions

```
2026.1.5  → Last release in January
2026.2.0  → First release in February (PATCH resets)
2026.2.1  → Next release in February
```

### Year Transitions

```
2026.12.3 → December release
2027.1.0  → January of next year
```

## Automated Validation

### Pre-commit Hook (Optional)

Add to `.git/hooks/pre-commit`:

```bash
#!/bin/bash
VERSION=$(grep '"version"' package.json | head -1)
if echo "$VERSION" | grep -qE '\.[0-9]{2}\.'; then
  echo "ERROR: package.json version has leading zeros!"
  echo "Found: $VERSION"
  echo "Fix: Remove leading zeros (e.g., 2026.01.5 → 2026.1.5)"
  exit 1
fi
```

### CI Validation

The npm publish workflow will fail if the version has leading zeros, but it's better to catch this before pushing.

## Common Mistakes

### Mistake 1: Copy-Paste from Dates

```bash
# Today is January 5, 2026
# WRONG: Using date format
2026.01.05

# RIGHT: Using CalVer format
2026.1.5
```

### Mistake 2: Assuming Two-Digit Month

```bash
# WRONG: Padding single-digit months
2026.01.0, 2026.02.0, ..., 2026.09.0

# RIGHT: No padding
2026.1.0, 2026.2.0, ..., 2026.9.0
```

### Mistake 3: Incrementing Without Checking Format

When bumping versions, always verify the format:

```bash
# Before: 2026.1.4
# Bumping patch...

# WRONG (if you typed it manually)
"version": "2026.01.5"

# RIGHT
"version": "2026.1.5"
```

## Release-age policy (Wave 7 — A15, #1290)

AIWG enforces a **release-age gate** on the dep graph: a newly published
version of any dependency must have been on the public registry for at
least 7 days before it can enter the lockfile. This is configured in the
repo-root `.npmrc` via `min-release-age=7`.

The gate exists to neutralize the "brand-new-malicious-publish-window"
attack — the same supply-chain technique used in the Mini Shai-Hulud
incidents that motivated the rest of Wave 7. If a package is compromised
at publish time, the gate bounds the window during which AIWG can be
exposed to the malicious version: a contributor running `npm install <new-dep>`
or `npm update` against a freshly published malicious version will see
npm refuse to resolve it until the gate window has elapsed and someone
(npm, the maintainer, the security community) has had time to notice
and yank.

### Requirements

- **npm 11.5+** is required for the `min-release-age` config to be
  honored. Earlier versions silently ignore the config (no error — but
  no gate either).
- Node 24 is required for CI and contributor machines. Use its bundled npm
  11.x, and ensure npm is at least 11.5 before lockfile-affecting operations.

```bash
# One-time on a contributor machine (or pin in your shell rc)
npm install -g npm@^11.5

# In CI (publish workflows specifically) — defense in depth
# Run before any `npm ci` or `npm install` step:
npm install -g npm@latest
```

### Default vs high-sensitivity profile

| Profile                                               | Window   | When to use                                                                                                                    |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Default** (`min-release-age=7`)                     | 7 days   | All contributor workflows + standard CI                                                                                        |
| **High-sensitivity** (`min-release-age=10` or higher) | 10+ days | Publish workflows touching release artifacts; major version bumps; manual lockfile regeneration on a security-sensitive branch |

The high-sensitivity profile is opt-in via the
`AIWG_MIN_RELEASE_AGE_HIGH` environment variable, recognized by AIWG
internal tooling and the publish workflows:

```bash
# Contributor regenerating the lockfile with the high-sensitivity profile
AIWG_MIN_RELEASE_AGE_HIGH=10 npm install --userconfig $PWD/.npmrc \
  --min-release-age "${AIWG_MIN_RELEASE_AGE_HIGH:-7}"

# Or just override the config on the CLI for a single command
npm install --min-release-age=10
```

When CI workflows enter "publish" phase, the gate is invoked with the
high-sensitivity value to add belt-and-suspenders coverage during the
most security-sensitive moments.

### What happens if the gate fires

`npm install` (or `npm update`) errors with `No matching version found`
when the only resolutions for a dep request are inside the gate window.
This is the desired behavior — it prevents the new version from entering
the lockfile silently.

To proceed:

1. **Preferred**: wait. The gate window is short. A version published
   today will be installable in 7 days.
2. **If the dep is truly urgent**: bypass the gate **deliberately** with
   `npm install --min-release-age=0 <pkg>`. This is a manual,
   commit-message-justified override. The override must be documented
   in the lockfile commit, and the security team should be tagged.
3. **If a malicious version is suspected**: yank from npm if it's
   AIWG-owned, file an incident issue, contact npm security, and update
   the dep-source allowlist to pin the previous known-good version.

### Interaction with other gates

- **A11 tarball audit** (`tools/lint/tarball-audit.mjs`) — independent
  control. Runs at publish time, checks the AIWG tarball's top-level
  contents. Not affected by the release-age gate.
- **A12 audit signatures** (`tools/lint/audit-signatures.mjs`) — runs
  `npm audit signatures` against published deps. Independent of the
  gate, but the gate prevents new unsigned attestations from entering
  the tree faster than they can be verified.
- **A20 dep-source policy** — scans the lockfile for forbidden source
  patterns (git+, file:, etc.). Independent of the gate; both run.

### Why not pnpm

A21 (#1301) spike evaluated migrating to pnpm so the gate could ship in
`pnpm-workspace.yaml minimumReleaseAge` shape, which is slightly cleaner.
The spike outcome was to stay on npm — see
`.aiwg/architecture/adr-pnpm-workspace-migration.md` for the full
reasoning. Short version: the migration cost in Wave 7 scope outweighs
the benefit; the threat-model effect of either shape is equivalent.

## Package ownership & npm registries

AIWG ships **three** npm packages with **different ownership models** — this split
is intentional; don't try to "unify" them.

| Package         | Scope / owner                                      | Public install                 | Notes                                                                                        |
| --------------- | -------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `aiwg`          | **unscoped**, owned by the user account `roctinam` | `npm install -g aiwg`          | Full CLI plus the default local corpus; retained for compatibility.                          |
| `@aiwg/cli`     | **scoped**, under the `@aiwg` org                  | `npm install -g @aiwg/cli`     | Lightweight CLI/API runtime without the corpus; its version is exactly lockstep with `aiwg`. |
| `@aiwg/cockpit` | **scoped**, under the `@aiwg` org                  | `npm install -g @aiwg/cockpit` | Opt-in Cockpit package.                                                                      |

### Two-stage release candidates (#3201)

**Staged implementation:** signed RC validation, exact-artifact verification, and
fail-closed stable workflow integration are available. Both stable workflows use
`tools/release/release-promotion.mjs` as their sole package publisher and no longer
rebuild, retest, or repack in the shipping stage. The checked-in production policy
remains disabled and its workflow, actor, model, and approval trust values remain
unconfigured. This source change does not authorize a release or close #3201.

The intended sequence is a routine RC build and bounded release validation,
followed by promotion against the current UTC calendar quarter's full validation
and real release-comparison record (#3298). The quarterly record may test an
earlier commit only when that commit is an authenticated ancestor of the exact RC
commit. The candidate-specific approval must name both commits and explicitly say
that the candidate was not directly behavior-compared. Fix or explicitly accept
each measured regression before that quarterly record is approved.
The merged [release-comparison harness](release-comparison.md) records package,
fixture, corpus, and deployed-tree identities, but no comparison has been run for
this candidate. Production promotion must verify those reports and bind their
tested tarball or fixture digests plus every regression disposition to the
quarterly attestation, and separately bind the exact RC manifest and validation
profile before stable publication can switch to promotion. A successful RC build
alone is insufficient authorization to ship. No current-quarter record is
checked in or implied by this implementation.

RC tags label validation attempts rather than package prerelease versions. For
example, commit C contains version `2026.10.4` consistently in package manifests,
lockfiles, marketplace, and bundled plugins. Signed `v2026.10.4-rc.1` validates
that commit without changing any package version. A subsequent stable
`v2026.10.4` must point to the **same commit C** and use the **same packed bytes**.
Do not bump from `2026.10.4-rc.1` to `2026.10.4` between stages. Fixes require a
new main commit and a new signed RC attempt.

After normal version, changelog, announcement, and signing prerequisites, the
existing tag helper accepts the RC suffix:

```bash
# These are release-operator actions; do not run during offline implementation review.
tools/release/cut-tag.sh 2026.10.4-rc.1
# Push the verified RC tag to the GitHub mirror only when RC execution is authorized.
```

`.github/workflows/release-candidate.yml` verifies the signed annotated tag and
main ancestry, checks stable-version identity, and installs locked dependencies
and the mandatory SQLite backend. RC tag pushes select the versioned
`routine-release-v1` profile; a manual dispatch may explicitly select the same
routine profile or the quarterly profile. Routine validation covers type/build, release/security contracts, schema and
supply-chain checks, package/install verification, SQLite and installed-feature
checks, and a small real provider-write/self-verification lane. A dispatch
selecting `quarterly-full-v1` executes the exact 43
lanes enumerated in `tools/release/release-candidate.mjs`, including default/leak/
UAT, full provider deployment, conformance/coverage, SQLite/performance, serve,
artifact-index, D29/D17, package, and tarball gates. The profile and exact lane
inventory are retained in version-2 validation evidence. Legacy version-1
full-lane artifacts remain replayable but cannot be relabeled as either profile.
Failed, skipped, extra, or missing required lanes do not produce valid evidence
for the named profile.

After validation, RC packs **all three** surfaces (`aiwg`, `@aiwg/cli`,
`@aiwg/cockpit`) once into the retained bundle and smoke-installs those exact
tarballs in temporary prefixes with isolated homes. It checks installed package
identities, CLI version/help, and the Cockpit bridge's installed import. It audits
the actual pack file lists for `.aiwg` exclusion and the root top-level allowlist.
It generates the built-tree CycloneDX SBOM using the existing pinned Syft binary
and retains the exact installer. This is an install/import smoke, not a claim of
live Cockpit service or provider behavior validation.

The immutable GitHub Actions artifact is named
`release-candidate-<commit>-<run-id>-<attempt>`, retained for 90 days. It contains
three tarballs, the built-tree SBOM, installer, per-lane validation evidence,
installed-smoke evidence, and `rc-manifest.json`. The manifest binds stable
package version, RC tag object, peeled commit, repository/workflow/run/attempt,
runner, and SHA256 of every retained payload. Verification rejects extra files,
directories, and symlinks: the retained bundle must contain exactly the manifest
and its expected regular-file payloads. Failed-run diagnostics have a separate
artifact name and cannot satisfy promotion verification. Expired or missing
candidate artifacts fail closed; retaining the evidence needed for later recovery
is an operator responsibility.

`verifyRcBundle` validates a downloaded bundle against **authenticated GitHub API**
run/job/artifact/workflow metadata: same repository and head repository, workflow
API ID matching the run, successful completed run and the complete critical step
inventory, matching runner, commit and signed RC tag object. Routine validation
accepts a push or a signed-tag dispatch; quarterly validation requires a
signed-tag dispatch, and legacy validation requires a push. It also verifies the
artifact run/attempt, exact versioned profile/lane inventory, exact smoke identity, and all
retained digests. The verifier also requires a separate `workflow-source/v1`
receipt with `repository`, `path`, candidate `commit`, and SHA256 of the decoded
workflow source fetched for that commit. It compares that digest to the
authoritative workflow file in the checked-out verifier source. The production
transport constructs that receipt from the authenticated source API; it never
comes from the candidate bundle or manifest.

Production wiring must independently fetch and verify the signed RC tag with
`tools/ci/verify-signed-tag.sh`, validate its peeled commit against the stable
signed tag, fetch the workflow metadata and exact-commit source, and
obtain/download the artifact through trusted APIs before invoking the verifier.
Candidate-provided JSON is not a substitute for trusted API metadata.
`tools/release/release-promotion.mjs` is the production orchestration entry point,
but its checked-in policy is disabled until the external identities below are
reviewed and populated.

The helper's `verify` command is an **offline diagnostic** accepting captured
metadata files, including `--workflow` API metadata and the separate
`--workflow-source` receipt. The command cannot authenticate those files and
therefore does not qualify them for publication. Its promotion plan lists the
original tarball paths/digests and proposed
`npm publish <tarball> --ignore-scripts --provenance` arguments; it never publishes
and exits nonzero with `ready_for_publication: false`. The production orchestrator
adds the real comparison/approval gate and an opaque in-process publication
decision. Its publisher accepts only that decision, copies exactly the three
retained tarballs into a private read-only staging directory, and rechecks the
complete inventory before and after every registry action. It treats a registry
conflict as idempotent only after the registry's SHA-1 and SHA-512 SRI metadata
match the retained bytes; a mismatch aborts partial recovery. Final stable workflow
wiring must retain the current
signed-tag, OIDC/provenance, tarball/manifest/SBOM signing, installer/checksum,
GitHub release assets, all three npm surfaces, and same-tag partial-publish
recovery while removing rebuild/retest/repack from the shipping stage. Both
stable workflows now invoke that gate and fail closed on plain tag pushes. The
The #3298 harness supplies the comparison evidence format; it does not supply
candidate evidence, regression approval, or permission to publish.

Offline stub tests prove validation and identity logic only. No real signed RC
run, package installation from a release candidate, model comparison, publication,
or end-to-end promotion was performed by this change.

#### Production evidence and comparison approval contract

`tools/release/release-evidence.mjs` provides a library-only trust boundary.
`acquireGithubProductionReleaseEvidence` constructs the read-only GitHub API
transport from an explicitly supplied token and approval issue. It fetches the
exact-attempt jobs, paginated issue comments, candidate metadata, and workflow
source at the signed commit. Artifact redirects are restricted to trusted HTTPS
hosts and never receive the API token. The helper checks the GitHub artifact
SHA256 against the downloaded bytes before extracting them into a fresh private
directory with the standard ZIP library of the root-owned `/usr/bin/python3`.
The interpreter and its parent directories must not be group- or world-writable;
it runs with isolated startup and a minimal environment without credentials.
Extraction rejects traversal,
duplicates, links, non-regular entries, oversized archives and excessive expansion;
the verifier then checks the exact bundle inventory and retained file digests.
The existing diagnostic seam remains deliberately untrusted when an independent
bundle directory is supplied.

This is a reviewed implementation boundary, not a remote authentication
attestation. Production configuration must select the trusted repository, issue,
workflow and run identities, provide suitably scoped credentials, and retain the
existing model-execution and publisher holds. The GitHub Actions token identity and
artifact redirect host policy need live qualification before production use.

Both the RC and stable tags are independently checked with the repository's
maintainer keyring through `tools/ci/verify-signed-tag.sh`. They must be annotated,
match the unchanged stable package version, peel to the same commit, and match the
verifier's checked-out `HEAD`. The resulting in-process receipt cannot be replaced
by serialized candidate data.

The comparison gate consumes the unchanged #3298 report format. Trusted policy,
separate from the reports, fixes all three providers, the subject and distinct
judge snapshots, seed, `n=5`, baseline version, deployed bundle set, and allowed
GitHub issuer IDs. Verification recomputes the canonical scenario plan and report
aggregates, requires every expected provider/scenario/repetition exactly once,
rejects invalid or incomplete subject/judge results, and binds the candidate
tarball, corpus, package tree, deployed context, installation lock, report, and
adapter digests. `fixture:`/`tree:` candidates and the shipped offline adapters —
including copied adapters with the same digest — are rejected.

Per-release compatibility approval content uses
`aiwg-release-comparison-approval/v1`. Quarterly policy uses
`aiwg-release-comparison-approval/v2`, which binds the exact candidate (including
its RC validation profile), the current-quarter attestation and full-validation
digest, tested/candidate ancestry, and report identities. Its basis is
`quarterly-cross-provider-comparison` and
`candidate_behavior_directly_compared` must be false. Candidate and report
digests plus workflow/run/artifact and signed-tag identities must match exactly.
Every measured regression needs one disposition for its provider, scenario,
repetition, report digest, and precise regression signals. Issuer identity comes
only from the authenticated GitHub API envelope and must match a trusted policy
ID; an `issuer` claim inside approval content is rejected.

The quarterly comparison artifact contains exactly
`quarterly-attestation.json`, `validation.json`, and one JSON report for each of
Claude, Codex, and Hermes. The validation record must use profile
`quarterly-full-v1`, bind the tested commit, and prove all 43 lanes exactly once.
The attestation binds every file digest, tested package identity, workflow/run/
attempt, canonical repository-relative subject/judge source paths and digests
(plus Codex runtime/parser), and the exact UTC-quarter interval. Producer runner
absolute paths remain unchanged inside the report JSON but grant no trust: the
publisher resolves only the attested canonical paths in its own checkout, rejects
escapes and symlinks, and requires those current source bytes to match. Source or
corpus drift therefore requires a new quarterly run. Its validation start/completion must
fall within the authenticated successful run; GitHub's authenticated HTTP `Date`
must be after run completion and still in that quarter. The run's `updated_at` is
a conservative authenticated upper bound rather than a timestamp copied into the
artifact, because artifact creation precedes final workflow completion. The
authenticated compare API must prove that the tested commit is the candidate or
its ancestor and that the documented final comparison commit is the exact
candidate. Artifact retention expiry is independent of quarter validity; missing
or expired evidence fails closed. Retain the quarterly artifact for at least 120
days so a record produced near the quarter boundary remains available throughout
the longest calendar quarter. A trusted producer must assemble this exact
five-file artifact from the authenticated quarterly-full validation and the three
authorized comparisons. This source increment neither schedules model work nor
claims that such an artifact currently exists.

The canonical Hermes comparison adapter path is reserved as
`tools/rules/release-compare-hermes.mjs`, but that adapter does not exist in this
increment. Quarterly activation reports this as an unmet requirement before any
credential, network acquisition, or publication step. Claude/Codex source
bindings and offline fixtures cannot substitute for the missing Hermes production
adapter or three-provider qualification.

`config/release-promotion-policy.json` is the sole versioned authorization source.
It is currently `enabled: false` and intentionally omits the workflow IDs, GitHub
API actor IDs, frozen baseline/seed/models, and runtime identity trust
decision. Candidate files and CLI flags cannot select another policy. Enabling it
requires review of all those values and a specific transport level
(`github-authenticated-user-api`) and a reviewed credential kind. The dedicated
`AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN` must support GitHub's authenticated-user API;
the built-in Actions `GITHUB_TOKEN` remains limited to release assets and OIDC.
Because the provider backends do not expose a
cryptographic model attestation, the only currently implementable runtime level is
`requested-cli-model`; policy must explicitly set
`allow_unattested_backend: true` for all three providers to accept that limitation.
The resulting decision records `backend_attestation_available: false` and never
describes requested model identity as backend-authenticated.

The evidence and comparison helpers continue to report
`production_identity_authenticated: false`. The promotion orchestrator may produce
a ready opaque decision only when the enabled versioned policy explicitly accepts
the documented lower trust level, the GitHub API actor is on the policy allowlist,
and every signed-tag, run/attempt/job, extraction, comparison and approval check
passes in the same process. The checked-in policy selects
`utc-calendar-quarter` cadence but remains disabled; the legacy `per-release`
mode is retained only as an explicit compatibility mode. Today the policy and
missing current-quarter three-provider production
evidence keep `ready_for_publication: false`. No verifier invokes a model or creates
a tag. Real policy activation and full production evidence remain required.

### Publication surfaces

- **npmjs.org (public) — GitHub Actions only.** `.github/workflows/npm-publish.yml`
  publishes all three retained RC tarballs via **OIDC trusted publishing + provenance**
  on an evidence-bearing, tag-bound dispatch. Stable tag pushes fail closed.
  No npm token is involved (OIDC). GitHub Actions is the authority for npmjs.org
  supply-chain distribution and verification.
- **Gitea npm registry (mirror) — Gitea Actions only.** `.gitea/workflows/npm-publish.yml`
  publishes the same retained files after exact npmjs identities are visible.
  Uses the `NPM_TOKEN` secret — a **Gitea API token (`gta_…`)** with `package:write`
  (despite the name, it is NOT an npmjs.org token).
- **Releases:** Gitea release = `.gitea/workflows/gitea-release.yml`; GitHub release
  = `.github/workflows/npm-publish.yml` (the mirror workflow can also create it).

The GitHub publish job creates or updates a normal GitHub release after the exact
retained-RC gate and npmjs publication. It uses
`docs/releases/v<version>-announcement.md`, falling back to the version's
CHANGELOG section and then minimal notes. Only stable versions are marked latest.
The authenticated RC manifest proves the required tests, dependency-signature
checks, package audits, installed smokes, and deployment lane passed in the retained
run. The stable job signs the retained root tarball and retained CycloneDX SBOM and
uploads all three tarballs, signatures, release manifest, `SHA256SUMS`, and installer.
None of that asset work depends on npm registry visibility.

npm visibility/provenance and stable dist-tag verification run **last and are
advisory**: short, bounded checks emit warnings and job-summary recovery commands
if npm is still validating a package or its metadata is incorrect. These checks
do not fail the job or prevent the subsequent Socket audit. Actual publish
failures still fail the job; already-published versions count as success on reruns.

For a partial publish or advisory verification failure, re-check the packages'
`dist.attestations`, `latest` version, and absence of the retired `next` alias,
then rerun the GitHub job on the same tag with the same evidence:

```bash
gh workflow run npm-publish.yml --repo jmagly/aiwg --ref <stable-tag> \
  -f tag_to_publish=<stable-tag> -f rc_tag=<rc-tag> \
  -f rc_run_id=<run> -f rc_artifact_id=<artifact> \
  -f comparison_run_id=<run> -f comparison_artifact_id=<artifact> \
  -f approval_issue=<issue> -f approval_sha256=<sha256>
```

Gitea's bundled npm registry stores AIWG packages but does not proxy packages
from npmjs.org. A process-wide `--registry=<gitea>` install therefore sends
third-party dependencies to Gitea and fails when they are not mirrored there.
For a clean mirror install, resolve or copy the package's `dist.tarball` URL
from Gitea and install that URL with npm's default registry:

```bash
VERSION=2026.7.18
npm install --global \
  "https://git.integrolabs.net/api/packages/roctinam/npm/aiwg/-/${VERSION}/aiwg-${VERSION}.tgz"
```

This downloads AIWG from Gitea while resolving its public dependencies from
npmjs.org. The Gitea release workflow emits the version-specific form of this
command, and the publish workflow clean-installs all three mirrored tarballs.

### OIDC trusted publishers are per-package

Each package needs its **own** OIDC trusted publisher configured on npmjs.org,
pointed at `jmagly/aiwg`'s `.github/workflows/npm-publish.yml`. Configure the
same publisher tuple separately for `aiwg`, `@aiwg/cli`, and `@aiwg/cockpit`.
The historical `@aiwg/cli@0.0.0-bootstrap.0` reservation is not an AIWG
release. Released packages use the shared AIWG CalVer, and the deprecated
`bootstrap` dist-tag is intentionally absent.

### Published package README standard

Every npm package must ship a full, dedicated README rather than a short
registry stub. The source files are:

| Package | README source |
|---|---|
| `aiwg` | `README.md` |
| `@aiwg/cli` | `packages/cli/README.md` |
| `@aiwg/cockpit` | `apps/cockpit/README.md` |

Each README must stand alone on npm and include package-specific installation,
quick start, architecture or operating model, troubleshooting, documentation
links, and an honest statement of package scope. Relative links or images that
depend on unpublished repository files should use stable public URLs instead.
`test/smoke/published-package-readmes.test.ts` enforces dedicated identity,
minimum depth, and required package-level sections; packed-install integration
tests verify that the dedicated CLI README is copied byte-for-byte into
`@aiwg/cli`.

### Gotchas (learned the hard way — #1648)

- **Publish a sub-package with the folder spec, never `--prefix`.** Cockpit is
  published from `./apps/cockpit`; the generated CLI staging package is
  published from `./dist/packages/cli`. Use `npm publish ./apps/cockpit …` or
  `npm publish ./dist/packages/cli …` as appropriate. `npm --prefix
apps/cockpit publish` does **not** target the subdir — it republishes the root
  `aiwg` package, hits `409`, and the error handler swallows it as success, so the
  sub-package silently never publishes. Note the leading `./` — `npm publish
apps/cockpit` (no `./`) is read as a git spec and fails.
- **A brand-new scoped package may need a one-time manual bootstrap.** npm trusted
  publishing historically requires the package to exist before its per-package
  trusted publisher can be configured. Bootstrap once with
  `npm publish ./apps/<pkg> --access public --registry=https://registry.npmjs.org/ --otp=<code>`
  (no `--provenance` locally — that only works from CI OIDC), then OIDC takes over
  for subsequent releases.

## References

- [Semantic Versioning 2.0.0](https://semver.org/)
- [Calendar Versioning](https://calver.org/)
- [npm semver](https://docs.npmjs.com/cli/v6/using-npm/semver)
- [npm config: min-release-age](https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age)
- @CLAUDE.md - Release Documentation Requirements
- @docs/contributing/ci-cd-secrets.md - CI/CD configuration
- @docs/contributing/dependency-sources.md - Dependency source policy (A20)
- @.npmrc - Repo-root npm config (release-age gate lives here)
- @.aiwg/architecture/adr-pnpm-workspace-migration.md - Why npm not pnpm
- Issue #1290 — A15 release-age gate
- Issue #1278 — Wave 7 (Mini Shai-Hulud supply-chain hardening) epic
- Issue #1648 — cockpit publish targeting bug (`--prefix` vs folder spec)
- @.github/workflows/npm-publish.yml - npmjs.org publish (OIDC + provenance)
- @.gitea/workflows/npm-publish.yml - Gitea npm registry mirror
