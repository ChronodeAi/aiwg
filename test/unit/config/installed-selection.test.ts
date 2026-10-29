// `aiwg update` redeploys through `use`, but must not change the explicitly installed selection (#3767).
import { describe, expect, it } from 'vitest';
import { preserveInstalledSelection, withInstalledSelection } from '../../../src/config/installed-selection.js';

const entry = (version: string) => ({ version, source: 'bundled', installedAt: '2026-10-29T00:00:00.000Z', deployedTo: {} });
const config = (installed: Record<string, ReturnType<typeof entry>> | undefined) =>
  ({ version: '1', providers: ['claude'], ...(installed ? { installed } : {}) }) as any;

describe('preserveInstalledSelection', () => {
  it('leaves writes untouched outside an update selection', () => {
    const written = config({ all: entry('2026.10.15'), sdlc: entry('2026.10.15') });
    expect(preserveInstalledSelection('/p', written)).toBe(written);
  });

  it('leaves writes to another project untouched', async () => {
    const written = config({ all: entry('2026.10.15'), sdlc: entry('2026.10.15') });
    await withInstalledSelection('/project-a', { all: entry('2026.10.14') } as any, async () => {
      expect(preserveInstalledSelection('/project-b', written)).toBe(written);
    });
  });

  it('drops frameworks that a redeploy tries to add, keeping refreshed metadata for installed ones', async () => {
    await withInstalledSelection('/p', { all: entry('2026.10.14') } as any, async () => {
      const guarded = preserveInstalledSelection('/p', config({ all: entry('2026.10.15'), sdlc: entry('2026.10.15') }));
      expect(Object.keys(guarded.installed)).toEqual(['all']);
      expect(guarded.installed.all.version).toBe('2026.10.15');
    });
  });

  it('keeps the original entry when the write omits an installed framework', async () => {
    await withInstalledSelection('/p', { all: entry('2026.10.14'), research: entry('2026.10.14') } as any, async () => {
      const guarded = preserveInstalledSelection('/p', config({ all: entry('2026.10.15') }));
      expect(Object.keys(guarded.installed).sort()).toEqual(['all', 'research']);
      expect(guarded.installed.research.version).toBe('2026.10.14');
    });
  });

  it('never adds an installed block to a legacy project that had none', async () => {
    await withInstalledSelection('/p', undefined, async () => {
      const guarded = preserveInstalledSelection('/p', config({ sdlc: entry('2026.10.15') }));
      expect(guarded).not.toHaveProperty('installed');
    });
  });

  it('isolates the caller selection from later mutation', async () => {
    const original = { all: entry('2026.10.14') } as any;
    await withInstalledSelection('/p', original, async () => {
      original.extra = entry('x');
      const guarded = preserveInstalledSelection('/p', config({ all: entry('2026.10.15'), extra: entry('x') }));
      expect(Object.keys(guarded.installed)).toEqual(['all']);
    });
  });
});
