import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectScriptLanes, runsOnMain } from '../../../tools/testing/check-script-lanes.mjs';
import { expandScripts } from '../../../tools/testing/workflow-commands.mjs';
import { scriptLaneExemptions } from '../../../config/test-lanes.mjs';

const roots = [];
function fixture(run = 'npm run test:owned', on = { push: { branches: ['main'] } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-script-lanes-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.gitea/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitea/workflows/ci.yml'), JSON.stringify({
    on, jobs: { unit: { steps: [{ run }] } },
  }));
  return root;
}
const exemption = script => ({ script, owner: 'testing-maintainers', kind: 'manual', reason: 'Interactive developer diagnostic.' });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('root gate script lane parity', () => {
  it('passes the checked-in census with a reviewable lane or exception for every gate', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const report = inspectScriptLanes(root, scripts, scriptLaneExemptions);
    expect(report.errors).toEqual([]);
    expect(report.records.length).toBe(Object.keys(scripts).filter(name => /^(lint|test|check):/.test(name)).length);
    expect(report.records.find(row => row.script === 'test:release-slow')).toMatchObject({ workflows: [], exemption: { kind: 'release-only' } });
    expect(report.records.find(row => row.script === 'lint:context-sizes').exemption.reason).toBe('#3740: wire into CI once AGENTS.md fits');
  });

  it('rejects an unlisted unwired script and accepts a reasoned exception', () => {
    const root = fixture();
    const scripts = { 'test:owned': 'vitest run', 'lint:new': 'node lint.mjs' };
    expect(inspectScriptLanes(root, scripts).errors).toEqual(['Script has no main CI lane or exemption: lint:new']);
    expect(inspectScriptLanes(root, scripts, [exemption('lint:new')]).errors).toEqual([]);
  });

  it('rejects a stale exemption for a deleted script', () => {
    expect(inspectScriptLanes(fixture(), { 'test:owned': 'vitest run' }, [exemption('lint:deleted')]).errors)
      .toEqual(['Stale script exemption: lint:deleted']);
  });

  it.each(['owner', 'reason', 'kind'])('rejects invalid exemption %s', field => {
    expect(inspectScriptLanes(fixture(), { 'test:owned': 'vitest run', 'lint:manual': 'lint' },
      [{ ...exemption('lint:manual'), [field]: ' ' }]).errors).toHaveLength(1);
  });

  it('rejects redundant and duplicate exceptions', () => {
    const entry = exemption('test:owned');
    expect(inspectScriptLanes(fixture(), { 'test:owned': 'vitest run' }, [entry, entry]).errors).toEqual([
      'Script exemption is owned by main CI; remove it: test:owned',
      'Duplicate script exemption: test:owned',
      'Script exemption is owned by main CI; remove it: test:owned',
    ]);
  });

  it('records job ownership through nested aliases, cycles and timeout wrappers', () => {
    const root = fixture('node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run outer');
    const scripts = { outer: 'env CI=true npm run inner', inner: 'npm run outer && npm run-script check:gate', 'check:gate': 'node gate.mjs' };
    expect(inspectScriptLanes(root, scripts)).toEqual({ errors: [], records: [{ script: 'check:gate', workflows: ['.gitea/workflows/ci.yml#unit'] }] });
  });

  it('does not treat comments, echo text or workspace scripts as root invocations', () => {
    const run = '# npm run lint:comment\necho "npm run lint:quoted"\necho npm run lint:echo\nnpm --prefix apps/web run lint:workspace\nnpm test';
    expect([...expandScripts(run, { test: 'npm run test:actual', 'test:actual': 'vitest run' }).names]).toEqual(['test', 'test:actual']);
  });

  it.each([
    ['push', true], [['push'], true], [{ push: null }, true],
    [{ push: { branches: ['m*'], paths: ['src/**'] } }, true],
    [{ push: { branches: ['develop'] } }, false],
    [{ push: { tags: ['v*'] } }, false],
    [{ push: { 'branches-ignore': ['main'] } }, false],
    [{ workflow_dispatch: null }, false], [{ schedule: [{ cron: '0 0 * * *' }] }, false],
  ])('classifies main-push triggers %j as %s', (on, expected) => {
    expect(runsOnMain(JSON.stringify({ on }))).toBe(expected);
  });

  it('does not accept a manual or tag-only workflow as routine CI', () => {
    for (const on of [{ workflow_dispatch: null }, { push: { tags: ['v*'] } }]) {
      expect(inspectScriptLanes(fixture(undefined, on), { 'test:owned': 'vitest run' }).errors)
        .toEqual(['Script has no main CI lane or exemption: test:owned']);
    }
  });

  it('requires release-only ownership for every release-slow descendant gate', () => {
    const root = fixture('npm run test:owned');
    const scripts = { 'test:owned': 'vitest run', 'test:release-slow': 'npm run check:release', 'check:release': 'node release-check.mjs' };
    const entries = ['test:release-slow', 'check:release'].map(script => ({ ...exemption(script), kind: 'release-only' }));
    expect(inspectScriptLanes(root, scripts, entries).errors).toEqual([]);
    expect(inspectScriptLanes(root, scripts, entries.map(entry => ({ ...entry, kind: 'manual' }))).errors).toEqual([
      'Release-slow script requires release-only exemption: test:release-slow',
      'Release-slow script requires release-only exemption: check:release',
    ]);
  });
});
