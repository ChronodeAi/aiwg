import { writeExecutableSync } from '../../helpers/write-executable.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const gate = join(root, 'tools/ci/wait-for-github-tag.mjs')
const temporaryDirectories = new Set<string>()
type GhMode = 'retry' | 'stdout-404' | 'not-found' | 'unauthorized' | 'server-error' | 'silent-error' | 'lightweight' | 'mismatch' | 'missing'

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
    expect(existsSync(directory)).toBe(false)
  }
  temporaryDirectories.clear()
})

function fakeGh(mode: GhMode) {
  const directory = mkdtempSync(join(tmpdir(), 'aiwg-gh-tag-'))
  temporaryDirectories.add(directory)
  const executable = join(directory, 'gh')
  const counter = join(directory, 'count')
  writeExecutableSync(executable, `#!/bin/sh
count=0
[ ! -f "$COUNT_FILE" ] || count=$(cat "$COUNT_FILE")
count=$((count + 1))
echo "$count" > "$COUNT_FILE"
if [ "$1" != "api" ] || [ "$2" != "$EXPECTED_ENDPOINT" ]; then
  echo "unexpected gh arguments: $*" >&2
  exit 64
fi
case "$MODE" in
  retry) if [ "$count" -lt 3 ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi; echo '{"object":{"type":"tag","sha":"abc123"}}' ;;
  stdout-404) if [ "$count" -lt 2 ]; then echo '{"message":"Not Found","status":"404"}'; exit 1; fi; echo '{"object":{"type":"tag","sha":"abc123"}}' ;;
  not-found) if [ "$count" -lt 2 ]; then echo 'gh: Not Found' >&2; exit 1; fi; echo '{"object":{"type":"tag","sha":"abc123"}}' ;;
  unauthorized) echo "gh: Bad credentials (HTTP 401), token=$GH_TOKEN other=ghp_unconfiguredFakeToken" >&2; exit 1 ;;
  server-error) echo 'gh: Internal Server Error (HTTP 500)' >&2; exit 1 ;;
  silent-error) exit 1 ;;
  lightweight) echo '{"object":{"type":"commit","sha":"def456"}}' ;;
  mismatch) echo '{"object":{"type":"tag","sha":"def456"}}' ;;
  missing) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`)
  return { executable, counter, mode }
}

function runGate(mode: GhMode, attempts = 3) {
  const fixture = fakeGh(mode)
  const result = spawnSync(process.execPath, [gate, '--repo', 'owner/repo', '--tag', 'v1.2.3', '--expected-sha', 'abc123', '--attempts', String(attempts), '--delay-seconds', '0'], { timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_BIN: fixture.executable,
      GH_TOKEN: 'fixture-secret-token',
      COUNT_FILE: fixture.counter,
      MODE: fixture.mode,
      EXPECTED_ENDPOINT: 'repos/owner/repo/git/ref/tags/v1.2.3',
    },
  })
  return { ...result, count: Number(readFileSync(fixture.counter, 'utf8')) }
}

describe('GitHub mirror tag gate', () => {
  it('retries until the annotated tag object exists', () => {
    const result = runGate('retry')
    expect(result.status).toBe(0)
    expect(result.count).toBe(3)
    expect(result.stdout).toContain('Found annotated tag')
  })

  it.each(['stdout-404', 'not-found'] as const)('retries a %s response then succeeds', mode => {
    const result = runGate(mode)
    expect(result.status).toBe(0)
    expect(result.count).toBe(2)
    expect(result.stdout).toContain('Found annotated tag')
  })

  it('fails immediately on HTTP 401 with redacted gh diagnostics', () => {
    const result = runGate('unauthorized')
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('Bad credentials (HTTP 401)')
    expect(result.stderr).toContain('gh api failed while checking tag')
    expect(result.stderr).toContain('token=[REDACTED] other=[REDACTED]')
    expect(result.stderr).not.toContain('fixture-secret-token')
    expect(result.stderr).not.toContain('ghp_unconfiguredFakeToken')
    expect(result.stderr).not.toContain('Timed out')
    expect(result.stdout).not.toContain('waiting')
  })

  it.each(['server-error', 'silent-error'] as const)('fails immediately on %s', mode => {
    const result = runGate(mode)
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('gh api failed while checking tag')
    if (mode === 'server-error') expect(result.stderr).toContain('Internal Server Error (HTTP 500)')
    expect(result.stderr).not.toContain('Timed out')
  })

  it('rejects a lightweight tag immediately', () => {
    const result = runGate('lightweight')
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('lightweight')
  })

  it('rejects a different annotated tag object', () => {
    const result = runGate('mismatch')
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('expected original signed tag object')
  })

  it('fails after the bounded retry budget', () => {
    const result = runGate('missing', 2)
    expect(result.status).toBe(1)
    expect(result.count).toBe(2)
    expect(result.stderr).toContain('Timed out')
  })

  it('orders the tag gate before verified release creation and guards success output', () => {
    const workflow = readFileSync(join(root, '.gitea/workflows/github-mirror.yml'), 'utf8')
    expect(workflow.indexOf('Wait for operator-pushed signed annotated tag')).toBeLessThan(workflow.indexOf('Create GitHub Release'))
    expect(workflow).toContain('git ls-remote origin "refs/tags/$TAG"')
    expect(workflow).toContain('--expected-sha "$EXPECTED_TAG_OBJECT"')
    expect(workflow).not.toContain('--expected-sha "$(git rev-parse')
    expect(workflow).toContain('--verify-tag')
    expect(workflow).toContain('steps.release.outcome')
  })
})
