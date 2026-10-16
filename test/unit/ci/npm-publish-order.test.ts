import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/npm-publish.yml'), 'utf8'));
const steps = workflow.jobs['publish-to-npmjs-org'].steps;
const temporaryRoots: string[] = [];
const publishNames = [
  'Publish to npmjs.org (OIDC + provenance)',
  'Publish Cockpit to npmjs.org (OIDC + provenance)',
  'Publish lightweight CLI to npmjs.org (OIDC + provenance)',
];
const step = (name: string) => steps.find((entry: { name: string }) => entry.name === name);
const index = (name: string) => steps.indexOf(step(name));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aiwg-publish-order-'));
  temporaryRoots.push(directory);
  writeFileSync(join(directory, 'CHANGELOG.md'), '## [2026.10.3]\nVersion notes\n## [2026.10.2]\nOld notes\n');
  writeFileSync(join(directory, 'summary'), '');
  return directory;
}

function runStep(name: string, directory: string, mocks = '', env: Record<string, string> = {}) {
  const script = step(name).run
    .replaceAll('${{ steps.version.outputs.version }}', '2026.10.3')
    .replaceAll('${{ steps.version.outputs.npm_tag }}', 'latest');
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `${mocks}\n${script}`], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      TAG: 'v2026.10.3', VERSION: '2026.10.3',
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      GITHUB_OUTPUT: join(directory, 'output'),
      ...env,
    },
  });
}

const ghMock = `
gh() {
  printf '%s\\n' "$*" >> calls
  if [ "$2" = view ]; then return "\${EXISTS:-1}"; fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --notes-file ]; then cp "$2" notes; break; fi
    shift
  done
}
`;
const registryMocks = `
timeout() {
  printf '%s\\n' "$*" >> calls
  if [ "\${TIMED_OUT:-0}" = 1 ]; then return 124; fi
  shift
  "$@"
}
npm() { printf '%s' "\${ATTESTATIONS:-}"; return "\${NPM_STATUS:-0}"; }
jq() { cat; }
sleep() { :; }
`;

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('GitHub release before publish, advisory registry checks last', () => {
  it('preserves blocking security gates and orders publication, local assets, then registry checks', () => {
    const release = index('Create or update GitHub release');
    expect(index('Verify workflow identity is tag-bound')).toBeLessThan(release);
    expect(index('Verify signed tag (#1299 / A9 gate)')).toBe(release - 2);
    expect(step('Install GitHub CLI (node:24 image does not ship it)')).toBe(steps[release - 1]);
    expect(release).toBeLessThan(index('Install dependencies'));
    expect(release).toBeLessThan(index('Build TypeScript'));
    const gates = [
      'Verify workflow identity is tag-bound', 'Verify signed tag (#1299 / A9 gate)',
      'Run tests', 'Verify packaged SQLite feature installation (#182)',
      'Verify .aiwg/ excluded from package', 'Audit dep-graph signatures (#1288 / A12)',
      'Audit tarball top-level entries (#1288 / A11)', 'Check package contents',
      'Check Cockpit package contents', 'Check lightweight CLI package contents',
    ];
    for (const name of gates) {
      expect(index(name)).toBeGreaterThan(-1);
      expect(index(name)).toBeLessThan(index(publishNames[0]));
      expect(step(name)['continue-on-error']).toBeUndefined();
    }
    const ordered = [
      'Pack local release tarball', ...publishNames,
      'Generate tarball + cosign sign + manifest', 'Generate CycloneDX SBOM',
      'Sign SBOM with cosign (keyless)', 'Prepare installer and checksum manifest',
      'Upload signed release assets to GitHub release', 'Verification summary',
      'Verify provenance attestation landed', 'Verify stable dist-tag policy',
      'Report advisory npm registry checks',
    ];
    for (let i = 1; i < ordered.length; i++) expect(index(ordered[i - 1])).toBeLessThan(index(ordered[i]));
    expect(step(publishNames[0]).run).toContain('npm publish "aiwg-${VERSION}.tgz"');
    expect(step('Generate tarball + cosign sign + manifest').run).not.toMatch(/^\s*npm (view|pack)/m);
    // The SBOM covers the built tree and its installed dependency graph, not the slim tarball.
    expect(step('Generate CycloneDX SBOM').run).toContain('syft scan dir:. --output cyclonedx-json="$SBOM"');
    expect(step('Upload signed release assets to GitHub release').run).not.toContain('gh release create');
    expect(step('Upload signed release assets to GitHub release').run).toContain('--clobber');
    expect(workflow.jobs['socket-post-publish'].needs).toBe('publish-to-npmjs-org');
  });

  it.each(['1', '0'])('creates or updates a public stable release with announcement notes (view status %s)', (exists) => {
    const directory = fixture();
    mkdirSync(join(directory, 'docs/releases'), { recursive: true });
    writeFileSync(join(directory, 'docs/releases/v2026.10.3-announcement.md'), 'Announcement notes');
    const result = runStep('Create or update GitHub release', directory, ghMock, { EXISTS: exists });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(directory, 'calls'), 'utf8');
    expect(calls).toContain(`release ${exists === '0' ? 'edit' : 'create'} v2026.10.3`);
    if (exists === '0') {
      // Re-runs, including recovery for an older tag, must not move the latest marker.
      expect(calls).not.toContain('--latest');
      expect(calls).toContain('--draft=false --prerelease=false');
    } else {
      expect(calls).toContain('--verify-tag --latest=true --prerelease=false');
    }
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toBe('Announcement notes');
  });

  it('retains CHANGELOG and minimal fallback notes and never marks prereleases latest', () => {
    const directory = fixture();
    expect(runStep('Create or update GitHub release', directory, ghMock).status).toBe(0);
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toBe('## [2026.10.3]\nVersion notes\n');
    expect(runStep('Create or update GitHub release', directory, ghMock, { TAG: 'v2026.10.4-rc.1' }).status).toBe(0);
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toContain('# AIWG v2026.10.4-rc.1');
    expect(readFileSync(join(directory, 'calls'), 'utf8')).toContain('--latest=false --prerelease=true');
  });

  it.each(['missing', 'error', 'timeout', 'visible'])('bounds provenance lookups for all three packages when %s', (state) => {
    const directory = fixture();
    const result = runStep('Verify provenance attestation landed', directory, registryMocks, {
      ATTESTATIONS: state === 'visible' ? 'attestation' : '',
      NPM_STATUS: state === 'error' ? '1' : '0',
      TIMED_OUT: state === 'timeout' ? '1' : '0',
    });
    expect(result.status).toBe(state === 'visible' ? 0 : 1);
    const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(state === 'visible' ? 3 : 9);
    for (const name of ['aiwg', '@aiwg/cli', '@aiwg/cockpit']) {
      expect(calls.some(call => call.includes(`10s npm view ${name}@2026.10.3`))).toBe(true);
    }
    expect(step('Verify provenance attestation landed')['continue-on-error']).toBe(true);
    expect(step('Verify provenance attestation landed')['timeout-minutes']).toBe(3);
  });

  it('makes dist-tag failures and timeouts advisory and reports actionable warnings for both checks', () => {
    const directory = fixture();
    const policy = step('Verify stable dist-tag policy');
    expect(policy['continue-on-error']).toBe(true);
    expect(policy['timeout-minutes']).toBe(2);
    expect(policy.run).toContain('timeout 75s bash tools/release/verify-npm-dist-tags.sh "$VERSION"');
    expect(runStep(policy.name, directory, registryMocks, { TIMED_OUT: '1' }).status).toBe(124);
    const report = step('Report advisory npm registry checks');
    expect(report.if).toContain("steps.npm_provenance.outcome == 'failure'");
    expect(report.if).toContain("steps.npm_dist_tags.outcome == 'failure'");
    const result = runStep(report.name, directory, '', { PROVENANCE_OUTCOME: 'failure', DIST_TAGS_OUTCOME: 'failure' });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/::warning::/g)).toHaveLength(2);
    const summary = readFileSync(join(directory, 'summary'), 'utf8');
    expect(summary).toContain('dist.attestations');
    expect(summary).toContain('latest = 2026.10.3 and absence of next');
    expect(summary.match(/gh workflow run npm-publish.yml --repo jmagly\/aiwg --ref v2026.10.3 -f tag_to_publish=v2026.10.3/g)).toHaveLength(2);
  });

  it.each(publishNames)('keeps real errors blocking and already-published reruns successful: %s', (name) => {
    const directory = fixture();
    const mocks = 'npm() { if [ "$1" = --version ]; then echo 11; return; fi; echo "$PUBLISH_ERROR"; return 1; }';
    expect(step(name)['continue-on-error']).toBeUndefined();
    expect(runStep(name, directory, mocks, { PUBLISH_ERROR: 'E403 forbidden' }).status).toBe(1);
    expect(runStep(name, directory, mocks, { PUBLISH_ERROR: 'EPUBLISHCONFLICT cannot publish over' }).status).toBe(0);
  });
});
