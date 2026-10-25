/**
 * Context-file writes for deployment providers (#3037).
 *
 * The journaled writer lives in compiled TypeScript. In source-resolution
 * mode (AIWG_RESOLVE_IMPL_FROM=src without a TS loader) it cannot load, and
 * read-only consumers of provider modules (for example the remotes topology
 * block) must still import cleanly. Writes then fail closed with the original
 * load error, so nothing ever writes context files without the safety layer.
 */
import { importImpl } from '../../_resolve-impl.mjs';

// Mirrors CONTEXT_STAGE_ENV in src/smiths/context-pipeline/context-file-safety.ts.
export const CONTEXT_STAGE_ENV = 'AIWG_CONTEXT_STAGE_LOG';

let loadError = null;
let writer = null;
try {
  writer = await importImpl(import.meta.url, 'smiths/context-pipeline/context-file-safety.js');
} catch (error) {
  loadError = error;
}

export function writeContextFileSync(file, content, encoding) {
  if (!writer) {
    throw new Error(`Context-file safety layer is unavailable; refusing to write ${file}`, { cause: loadError });
  }
  return writer.writeContextFileSync(file, content, encoding);
}
