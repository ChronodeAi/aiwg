/**
 * The CLI launcher must name loops the way the external loop's multi-loop
 * state manager validates them. Otherwise the loop falls back to single-loop
 * state that `aiwg mc status` never reads, and the mission stays RUNNING.
 *
 * Launches use a fake orchestrator script that exits at once: no provider,
 * no model call.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExternalRalph } from '../../../../src/cli/handlers/ralph-launcher.js';
import { RALPH_LOOP_ID_PATTERN } from '../../../../src/ralph/loop-id.mjs';
// @ts-ignore - ESM import
import { ExternalMultiLoopStateManager } from '../../../../tools/ralph-external/external-multi-loop-state-manager.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-loop-id-'));
  roots.push(root);
  const frameworkRoot = join(root, 'framework');
  mkdirSync(join(frameworkRoot, 'tools', 'ralph-external'), { recursive: true });
  writeFileSync(join(frameworkRoot, 'tools', 'ralph-external', 'index.mjs'), 'process.exit(0);\n');
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  return { frameworkRoot, projectRoot };
}

describe('launchExternalRalph loop ids', () => {
  it.each([
    ['plain words', 'Fix all failing tests', /^ralph-fix-all-failing-tests-/],
    ['punctuation', 'Fix: tests & docs!!! (with @special chars)', /^ralph-fix-tests-docs-with-special-ch-[a-f0-9]{8}$/],
    ['a 30-character cut ending on a hyphen', 'Create a file named hello.txt then stop', /^ralph-create-a-file-named-hello-txt-[a-f0-9]{8}$/],
    ['an empty slug', '!!!', /^ralph-task-[a-f0-9]{8}$/],
  ])('names the loop for %s so the multi-loop state manager accepts it', async (_case, objective, shape) => {
    const { frameworkRoot, projectRoot } = fixture();
    const result = await launchExternalRalph(frameworkRoot, projectRoot, { objective, completionCriteria: 'done' });

    expect(result.loopId).toMatch(RALPH_LOOP_ID_PATTERN);
    expect(result.loopId).toMatch(shape);
    const manager = new ExternalMultiLoopStateManager(projectRoot);
    expect(() => manager.validateLoopId(result.loopId)).not.toThrow();

    // The launcher already created loops/<id>/ for its daemon log; the loop's
    // own registration must still succeed there.
    expect(existsSync(join(projectRoot, '.aiwg', 'ralph-external', 'loops', result.loopId, 'daemon-output.log'))).toBe(true);
    const { loopId } = await manager.createLoop({ loopId: result.loopId, objective, completionCriteria: 'done' });
    expect(loopId).toBe(result.loopId);
    expect(existsSync(join(projectRoot, '.aiwg', 'ralph-external', 'loops', loopId, 'session-state.json'))).toBe(true);
  });
});
