// Exercise existing REF discovery through the real acquisition service without downloads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcquisitionService } from '@/research/services/acquisition.js';

describe('Acquisition REF identity scanning', () => {
  let directory: string;
  let service: AcquisitionService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'acquisition-ref-'));
    service = new AcquisitionService({ downloadDir: directory });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('does not truncate four-digit or suffixed PDF identities', async () => {
    await writeFile(join(directory, 'REF-1020a-paper.pdf'), 'fake PDF');
    expect(await service.assignRefId()).toBe('REF-1021');
  });

  it('ignores directories and malformed REF tokens', async () => {
    await mkdir(join(directory, 'REF-999-directory.pdf'));
    await writeFile(join(directory, 'REF-900aa-paper.pdf'), 'fake PDF');
    await writeFile(join(directory, 'REF-020-paper.pdf'), 'fake PDF');
    expect(await service.assignRefId()).toBe('REF-021');
  });

  it('handles padding and suffixes consistently for explicitly supplied IDs', async () => {
    expect(await service.assignRefId(['REF-2', 'REF-02', 'REF-020a', 'REF-999bad']))
      .toBe('REF-021');
  });
});
