import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = parse(readFileSync(resolve('.gitea/workflows/omp-conformance.yml'), 'utf8'));
const job = workflow.jobs['linux-x64-native'];
const fetchStep = job.steps.find((step: { name?: string }) => step.name === 'Fetch pinned OMP binary');
const verifyStep = job.steps.find((step: { name?: string }) => step.name?.startsWith('Verify immutable digest'));
const payload = 'fake reviewed OMP binary\n';
const directories: string[] = [];

function fixture(failures = 0, exitCode = 6, response = payload) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-download-'));
  directories.push(dir);
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash
set -eu
echo "$*" >> "$TEST_DIR/requests"
count=$(wc -l < "$TEST_DIR/requests")
while (( $# )); do
  if [[ "$1" == --output ]]; then output="$2"; shift; fi
  shift
done
if (( count <= FAILURES )); then
  echo partial >> "$output"
  echo 'simulated DNS/HTTP fetch failure' >&2
  exit "$FETCH_EXIT_CODE"
fi
printf '%s' "$RESPONSE" > "$output"
`, { mode: 0o700 });
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\necho "$1" >> "$TEST_DIR/delays"\n', { mode: 0o700 });
  const env = {
    ...process.env,
    ...job.env,
    OMP_BINARY: join(dir, 'omp'),
    OMP_SHA256: createHash('sha256').update(payload).digest('hex'),
    PATH: `${dir}:${process.env.PATH}`,
    TEST_DIR: dir,
    FAILURES: String(failures),
    FETCH_EXIT_CODE: String(exitCode),
    RESPONSE: response,
  };
  const run = (script: string) => spawnSync('bash', ['-c', script], {
    cwd: resolve('.'), env, encoding: 'utf8', timeout: 10_000,
  });
  const lines = (name: string) => {
    try { return readFileSync(join(dir, name), 'utf8').trim().split('\n'); }
    catch { return []; }
  };
  return { dir, env, run, lines };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pinned OMP binary acquisition', () => {
  it('downloads and verifies on the first attempt without sleeping', () => {
    const f = fixture();
    expect(f.run(fetchStep.run).status).toBe(0);
    expect(f.run(verifyStep.run).status).toBe(0);
    expect(readFileSync(f.env.OMP_BINARY, 'utf8')).toBe(payload);
    expect(f.lines('requests')).toHaveLength(1);
    expect(f.lines('requests')[0]).toContain('--connect-timeout 15 --max-time 120');
    expect(f.lines('delays')).toEqual([]);
  });

  it.each([6, 22])('retries curl exit %i with backoff and discards partial responses', exitCode => {
    const f = fixture(2, exitCode);
    expect(f.run(fetchStep.run).status).toBe(0);
    expect(f.run(verifyStep.run).status).toBe(0);
    expect(f.lines('requests')).toHaveLength(3);
    expect(f.lines('delays')).toEqual(['2', '4']);
    expect(readFileSync(f.env.OMP_BINARY, 'utf8')).toBe(payload);
    expect(readdirSync(f.dir).some(name => name.includes('.part.'))).toBe(false);
  });

  it('bounds failed downloads, preserves the destination and reports a fetch failure', () => {
    const f = fixture(10);
    writeFileSync(f.env.OMP_BINARY, 'existing destination');
    const result = f.run(fetchStep.run);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::Failed to fetch pinned OMP binary after 4 attempts; conformance checks did not run.');
    expect(f.lines('requests')).toHaveLength(4);
    expect(f.lines('delays')).toEqual(['2', '4', '8']);
    expect(readFileSync(f.env.OMP_BINARY, 'utf8')).toBe('existing destination');
    expect(readdirSync(f.dir).some(name => name.includes('.part.'))).toBe(false);
  });

  it('skips fetching on an exact cache hit while still verifying the binary', () => {
    const f = fixture(10);
    writeFileSync(f.env.OMP_BINARY, payload);
    expect(fetchStep.if).toBe("steps.omp-cache.outputs.cache-hit != 'true'");
    expect(verifyStep.if).toBeUndefined();
    // Execute the remaining acquisition step on the cache-hit path.
    expect(f.run(verifyStep.run).status).toBe(0);
    expect(f.lines('requests')).toEqual([]);
  });

  it.each(['cached', 'downloaded'])('rejects a corrupt %s binary before conformance', source => {
    const f = fixture(0, 6, 'corrupt binary');
    if (source === 'cached') writeFileSync(f.env.OMP_BINARY, 'corrupt binary');
    else expect(f.run(fetchStep.run).status).toBe(0);
    const result = f.run(verifyStep.run);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('FAILED');
  });

  it('uses only an exact version/digest cache key and preserves the reviewed pin and triggers', () => {
    const manifest = JSON.parse(readFileSync('test/fixtures/providers/omp-conformance/manifest.json', 'utf8'));
    const cache = job.steps.find((step: { id?: string }) => step.id === 'omp-cache');
    expect(job.env.OMP_VERSION).toBe(manifest.release.tag);
    expect(job.env.OMP_SHA256).toBe(manifest.release.platforms['linux-x64'].sha256);
    expect(cache.with.path).toBe(job.env.OMP_BINARY);
    expect(cache.with.key).toBe('omp-linux-x64-${{ env.OMP_VERSION }}-${{ env.OMP_SHA256 }}');
    expect(cache.with['restore-keys']).toBeUndefined();
    expect(workflow.on.push.branches).toEqual(['main', 'develop']);
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push.paths).toContain('tools/providers/omp-download.sh');
    expect(job.steps.indexOf(verifyStep)).toBeLessThan(job.steps.findIndex((step: { name?: string }) => step.name?.startsWith('Native parser')));
  });
});
