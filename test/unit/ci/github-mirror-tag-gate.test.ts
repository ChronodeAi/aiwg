import { writeExecutableSync } from '../../helpers/write-executable.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const gate = join(root, 'tools/ci/wait-for-github-tag.mjs')
const temporaryDirectories = new Set<string>()
type GhMode = 'rate-limit' | 'server-retry' | 'conflicting-status' | 'diagnostic' | 'retry' | 'stdout-404' | 'not-found' | 'unauthorized' | 'server-error' | 'silent-error' | 'lightweight' | 'mismatch' | 'missing'

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
  unauthorized) echo "gh: Bad credentials (HTTP 401), token=$GH_TOKEN other=ghp_unconfiguredFakeToken" >&2; echo "Authorization: Basic dXNlcjpiYXNpY0ZpeHR1cmVQYXNz" >&2; exit 1 ;;
  rate-limit|server-retry) if [ "$count" -lt 2 ]; then echo "gh: Temporary failure (HTTP $TRANSIENT_STATUS)" >&2; echo "Retry-After: $RETRY_AFTER" >&2; exit 1; fi; echo '{"object":{"type":"tag","sha":"abc123"}}' ;;
  conflicting-status) echo '{"message":"Not Found","status":"500"}'; exit 1 ;;
  diagnostic) echo "$DIAGNOSTIC" >&2; exit 1 ;;
  server-error) echo 'gh: Internal Server Error (HTTP 500)' >&2; exit 1 ;;
  silent-error) exit 1 ;;
  lightweight) echo '{"object":{"type":"commit","sha":"def456"}}' ;;
  mismatch) echo '{"object":{"type":"tag","sha":"def456"}}' ;;
  missing) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`)
  return { executable, counter, mode }
}

function runGate(mode: GhMode, attempts = 3, environment: Record<string, string> = {}, delaySeconds = 0, recordTimers = false) {
  const fixture = fakeGh(mode)
  const result = spawnSync(process.execPath, [...(recordTimers ? ['--import', 'data:text/javascript,' + encodeURIComponent('const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => { console.log(`timer=${ms}`); return original(fn, 0) }')] : []), gate, '--repo', 'owner/repo', '--tag', 'v1.2.3', '--expected-sha', 'abc123', '--attempts', String(attempts), '--delay-seconds', String(delaySeconds)], { timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_BIN: fixture.executable,
      GH_TOKEN: 'fixture-secret-token',
      TRANSIENT_STATUS: mode === 'rate-limit' ? '429' : '503',
      ...environment,
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
    expect(result.stderr).toContain('Authorization: [REDACTED]')
    expect(result.stderr).not.toContain('dXNlcjpiYXNpY0ZpeHR1cmVQYXNz')
    expect(result.stderr).not.toContain('Timed out')
    expect(result.stdout).not.toContain('waiting')
  })

  it.each(['401', '403', '422'])('fails immediately on non-transient HTTP %s', status => {
    const result = runGate('diagnostic', 3, { DIAGNOSTIC: `gh: Request rejected (HTTP ${status})` })
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('gh api failed while checking tag')
  })

  it.each([401, '403', 422])('prefers structured status %s over Not Found text', status => {
    const result = runGate('diagnostic', 3, { DIAGNOSTIC: JSON.stringify({ message: 'Not Found', status }) })
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('gh api failed while checking tag')
    expect(result.stdout).not.toContain('waiting')
  })

  it('fails immediately on a silent error', () => {
    const result = runGate('silent-error')
    expect(result.status).toBe(1)
    expect(result.count).toBe(1)
    expect(result.stderr).toContain('gh api failed while checking tag')
  })

  it.each(['rate-limit', 'server-retry'] as const)('retries %s then succeeds', mode => {
    const result = runGate(mode, 3, { RETRY_AFTER: '0' })
    expect(result.status).toBe(0)
    expect(result.count).toBe(2)
    expect(result.stdout).toContain('Found annotated tag')
  })

  it.each(['server-error', 'conflicting-status'] as const)('exhausts the transient budget for %s', mode => {
    const result = runGate(mode)
    expect(result.status).toBe(1)
    expect(result.count).toBe(3)
    expect(result.stderr).toContain('transient HTTP 500 retry budget exhausted')
    expect(result.stdout).not.toContain('operator push')
    expect(result.stderr).not.toContain('Timed out')
  })

  it('backs off exponentially within the shared attempt budget and caps each wait', () => {
    const result = runGate('server-error', 5, {}, 10, true)
    expect(result.status).toBe(1)
    expect(result.count).toBe(5)
    expect(result.stdout.match(/timer=\d+/g)).toEqual(['timer=10000', 'timer=20000', 'timer=40000', 'timer=60000'])
  })

  it.each([
    ['2', 2000],
    ['999999', 60000],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 0],
    ['Thu, 01 Jan 2099 00:00:00 GMT', 60000],
    ['invalid', 10000],
  ])('honors capped Retry-After %s', (retryAfter, milliseconds) => {
    const result = runGate('rate-limit', 3, { RETRY_AFTER: String(retryAfter) }, 10, true)
    expect(result.status).toBe(0)
    expect(result.count).toBe(2)
    expect(result.stdout).toContain(`timer=${milliseconds}`)
  })

  it.each(['github_pat_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_'])('redacts %s credentials', prefix => {
    const credential = `${prefix}unconfiguredFixture123`
    const result = runGate('diagnostic', 3, { DIAGNOSTIC: `gh: HTTP 401 credential=${credential}` })
    expect(result.stderr).toContain('credential=[REDACTED]')
    expect(result.stderr).not.toContain(credential)
  })

  it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])('redacts the %s environment value', key => {
    const credential = `fixture-secret-for-${key}`
    const result = runGate('diagnostic', 3, { [key]: credential, DIAGNOSTIC: `gh: HTTP 401 credential=${credential}` })
    expect(result.stderr).toContain('credential=[REDACTED]')
    expect(result.stderr).not.toContain(credential)
  })

  it.each(['Basic', 'Bearer', 'token'])('redacts the whole Authorization value with %s', scheme => {
    const result = runGate('diagnostic', 3, { DIAGNOSTIC: `gh: HTTP 401\naUtHoRiZaTiOn: ${scheme} opaque-fixture-credential extra-value` })
    expect(result.stderr).toContain('aUtHoRiZaTiOn: [REDACTED]')
    expect(result.stderr).not.toContain(scheme)
    expect(result.stderr).not.toContain('opaque-fixture-credential')
    expect(result.stderr).not.toContain('extra-value')
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

  it('fails the main push on GitHub auth errors but tolerates other rejections', () => {
    const workflow = readFileSync(join(root, '.gitea/workflows/github-mirror.yml'), 'utf8')
    const start = workflow.indexOf('- name: Push main to GitHub mirror')
    const end = workflow.indexOf('- name: Resolve release body')
    const block = workflow.slice(start, end)
    const script = block.slice(block.indexOf('run: |') + 'run: |'.length)
      .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')

    const runPush = (pushStderr: string, pushStatus: number) => {
      const directory = mkdtempSync(join(tmpdir(), 'aiwg-mirror-push-'))
      temporaryDirectories.add(directory)
      writeExecutableSync(join(directory, 'git'), `#!/bin/sh\necho "${pushStderr}" >&2\nexit ${pushStatus}\n`)
      return spawnSync('bash', ['-c', script], { timeout: 30_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GH_TOKEN: 'fixture-mirror-token',
          GH_MIRROR_TOKEN_VAULT_PATH: 'kv/ci/mirror',
          GH_MIRROR_TOKEN_VAULT_FIELD: 'token',
        },
      })
    }

    const auth = runPush("fatal: Authentication failed for 'https://github.com/jmagly/aiwg.git/'", 128)
    expect(auth.status).toBe(1)
    expect(auth.stderr).toContain('GitHub rejected the mirror token')
    expect(auth.stdout + auth.stderr).not.toContain('fixture-mirror-token')

    const rejected = runPush('! [rejected] HEAD -> main (non-fast-forward)', 1)
    expect(rejected.status).toBe(0)
    expect(rejected.stdout).toContain('main push declined')

    const ok = runPush('Everything up-to-date', 0)
    expect(ok.status).toBe(0)
    expect(ok.stdout).not.toContain('main push declined')
  })
})
