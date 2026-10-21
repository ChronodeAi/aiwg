/**
 * Ralph loop identifiers: `ralph-{slug}-{8 lowercase hex characters}`.
 *
 * One implementation for both sides of the TS/MJS boundary: the CLI launcher
 * (src/cli/handlers/ralph-launcher.ts) names the loop, and the external loop's
 * multi-loop state manager (tools/ralph-external/external-multi-loop-state-manager.mjs)
 * refuses any id that does not match {@link RALPH_LOOP_ID_PATTERN}. A launcher
 * id the state manager rejected left the loop in single-loop mode, where its
 * state never reached `loops/<id>/session-state.json`.
 */

import { randomUUID } from 'node:crypto';

export const RALPH_LOOP_ID_PATTERN = /^ralph-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/;

/**
 * Lowercase alphanumeric runs of the objective joined by single hyphens, cut to
 * 30 characters without a trailing hyphen, or `task` when nothing remains,
 * followed by the first 8 hex characters of a random UUID.
 * @param {string} objective
 * @returns {string}
 */
export function generateRalphLoopId(objective) {
  const slug = String(objective ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '') || 'task';
  return `ralph-${slug}-${randomUUID().slice(0, 8)}`;
}
