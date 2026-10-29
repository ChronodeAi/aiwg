// Locate regular corpus files by exact REF identity and extension.
import { readdirSync } from 'node:fs';
import { isRefId, refIdFromFilename } from '../../research/identity.js';

export function refFilesForId(directory: string, refId: string, extension = '.md'): string[] {
  if (!isRefId(refId)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile() && refIdFromFilename(file.name, extension) === refId)
    .map(file => file.name).sort();
}
