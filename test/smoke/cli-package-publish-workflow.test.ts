import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('@aiwg/cli release workflow wiring', () => {
  it('publishes the assembled package to npmjs with provenance and verifies it', () => {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows/npm-publish.yml'), 'utf8');

    expect(workflow).toContain('npm run package:cli');
    expect(workflow).toContain('npm publish ./dist/packages/cli --provenance --access public');
    expect(workflow).toContain('verify_attestations @aiwg/cli');
    expect(workflow).toContain('for attempt in $(seq 1 90)');
    expect(workflow).toContain('--json --prefer-online');
    expect(workflow).toContain("| jq -r '.dist.attestations // empty' || true");
    expect(workflow).toContain('after 15 minutes');
    expect(workflow).toContain('npm view "@aiwg/cli@${NPM_TAG}" version');
    expect(workflow).toContain('GIT_CONFIG_KEY_0: safe.directory');
    expect(workflow).toContain('GIT_CONFIG_VALUE_0: ${{ github.workspace }}');
    expect(workflow).toContain('Verify workflow identity is tag-bound');
    expect(workflow).toContain(
      "gh workflow run npm-publish.yml --ref '$TAG' -f tag_to_publish='$TAG'",
    );
    expect(workflow).toContain('NPM_TAG=latest');
    expect(workflow).toContain('npm publication accepts stable versions only');
    expect(workflow).toContain("github.event_name == 'push' && !contains(github.ref_name, '-')");
    expect(workflow).not.toContain('secrets.NPM_DIST_TAG_TOKEN');
    expect(workflow).not.toMatch(/^\s+npm dist-tag (?:add|rm) /m);
    expect(workflow).not.toContain('NPM_TAG=prerelease');
    expect(workflow).not.toContain('NPM_TAG=nightly');
  });

  it('publishes and promotes the assembled package in the Gitea registry', () => {
    const workflow = readFileSync(path.join(ROOT, '.gitea/workflows/npm-publish.yml'), 'utf8');
    const workflowHeader = workflow.slice(0, workflow.indexOf('\njobs:'));

    expect(workflow.match(/npm run package:cli/g)).toHaveLength(1);
    expect(workflowHeader).not.toContain('GT_NPM_TOKEN_VAULT_FIELD');
    expect(workflow.match(/GT_NPM_TOKEN_VAULT_FIELD: \$\{\{ vars\.GT_NPM_TOKEN_VAULT_FIELD \}\}/g)).toHaveLength(1);
    expect(workflow).toContain('npm publish ./dist/packages/cli --registry=');
    expect(workflow).toContain('npm dist-tag add "@aiwg/cli@${VERSION}" latest');
    expect(workflow).toContain('Retire next on Gitea');
    expect(workflow).toContain('npm dist-tag rm "$PACKAGE" next');
    expect(workflow).toContain('# Stable publishes deliberately omit `--tag`');
    expect(workflow).toContain("'^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(workflow).not.toContain('build-and-publish-prerelease');
    expect(workflow).not.toContain('--tag next');
    expect(workflow).not.toContain('--tag prerelease');
    expect(workflow).not.toContain('NPM_TAG=');
    expect(workflow).toContain('npm view "aiwg@${VERSION}" dist.tarball --registry=');
    expect(workflow).toContain('npm view "@aiwg/cli@${VERSION}" dist.tarball --registry=');
    expect(workflow).toContain('npm view "@aiwg/cockpit@${VERSION}" dist.tarball --registry=');
    expect(workflow).toContain('tag_to_publish:');
    expect(workflow).toContain(
      'AIWG_VERIFY_TAG_REF: refs/tags/${{ steps.release_tag.outputs.release_tag }}',
    );
    expect(workflow).toContain('version: ${{ steps.version.outputs.version }}');
    expect(workflow).toContain('VERSION="${{ needs.build-and-publish.outputs.version }}"');
    expect(
      workflow.match(/cannot publish over the previously published versions/g),
    ).toHaveLength(3);
    expect(workflow).toMatch(
      /verify-install:[\s\S]*?defaults:\s*\n\s*run:\s*\n\s*shell: bash/,
    );
    expect(workflow).toContain('npm install --prefix "$ROOT_INSTALL" --no-audit --no-fund "$ROOT_TARBALL"');
    expect(workflow).toContain('"$CLI_INSTALL/node_modules/.bin/aiwg" help');
    expect(workflow).toContain('"$COCKPIT_INSTALL/node_modules/.bin/aiwg-cockpit"');
    expect(workflow).not.toContain(
      'npm install -g aiwg@${VERSION} --registry=${{ env.GITEA_NPM_REGISTRY }}',
    );
  });

  it('documents a dependency-safe Gitea mirror install in generated releases', () => {
    const workflow = readFileSync(path.join(ROOT, '.gitea/workflows/gitea-release.yml'), 'utf8');
    const workflowHeader = workflow.slice(0, workflow.indexOf('\njobs:'));

    expect(workflow).toContain('tag_to_publish:');
    expect(workflow).toContain(
      'AIWG_VERIFY_TAG_REF: refs/tags/${{ steps.release_tag.outputs.release_tag }}',
    );
    expect(workflow).toContain(
      'git checkout --detach "refs/tags/${{ steps.release_tag.outputs.release_tag }}"',
    );
    expect(workflow.indexOf('Checkout release tag')).toBeLessThan(
      workflow.indexOf('Verify source-bound storage benchmark claims'),
    );
    expect(workflowHeader).not.toContain('GT_RELEASE_TOKEN_VAULT_FIELD');
    expect(workflow).toContain(
      'api/packages/roctinam/npm/aiwg/-/%s/aiwg-%s.tgz',
    );
    expect(workflow).toContain(
      'Gitea bundled npm is a package store, not an npmjs proxy.',
    );
    expect(workflow).not.toContain(
      'npm install -g aiwg@%s --registry=https://git.integrolabs.net/api/packages/roctinam/npm/',
    );
  });

  it('keeps Gitea release asset recovery idempotent when duplicate names are accepted', () => {
    const workflow = readFileSync(path.join(ROOT, '.gitea/workflows/upload-release-sigs.yml'), 'utf8');

    expect(workflow).toContain('delete_existing_assets "$name"');
    expect(workflow).toContain("select(.name == $n) | .id");
    expect(workflow).toContain('expected exactly one $f on Gitea release after upload');
  });
});
