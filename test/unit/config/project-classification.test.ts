/**
 * A privacy-classification vocabulary already existed per-artifact but never
 * reached project scope, so agents had no structured signal distinguishing a
 * repo that is safe to excerpt from one that must never leave the building.
 *
 * @issue #2535
 */
import { describe, it, expect } from 'vitest';
import {
  resolveProject,
  resolveProjectHandling,
  validateProjectConfig,
} from '../../../src/config/aiwg-config.js';

describe('resolveProject (#2535)', () => {
  it('keeps the historical bare-string form working', () => {
    expect(resolveProject('bizops')).toEqual({ name: 'bizops' });
    expect(resolveProject(undefined)).toBeUndefined();
  });

  it('passes the object form through', () => {
    const project = { name: 'bizops', classification: 'private' as const, pii: true };
    expect(resolveProject(project)).toEqual(project);
  });
});

describe('resolveProjectHandling (#2535)', () => {
  it('closes handling by default for a private repo', () => {
    expect(resolveProjectHandling({ classification: 'private' }))
      .toEqual({ excerptable: false, publishable: false, mirror: false });
  });

  it('stays permissive for public, sanitized, and undeclared repos', () => {
    const open = { excerptable: true, publishable: true, mirror: true };
    expect(resolveProjectHandling({ classification: 'public' })).toEqual(open);
    expect(resolveProjectHandling({ classification: 'sanitized' })).toEqual(open);
    // Declaring nothing must never silently tighten an existing project.
    expect(resolveProjectHandling(undefined)).toEqual(open);
  });

  it('lets an explicit flag override the classification default', () => {
    expect(resolveProjectHandling({ classification: 'private', handling: { excerptable: true } }).excerptable)
      .toBe(true);
    expect(resolveProjectHandling({ classification: 'public', handling: { mirror: false } }).mirror)
      .toBe(false);
  });
});

describe('validateProjectConfig (#2535)', () => {
  it('accepts a bare string and a well-formed object', () => {
    expect(validateProjectConfig('bizops')).toEqual([]);
    expect(validateProjectConfig(undefined)).toEqual([]);
    expect(validateProjectConfig({
      name: 'bizops',
      description: 'Restricted storage',
      classification: 'private',
      pii: true,
      handling: { excerptable: false, publishable: false, mirror: false },
    })).toEqual([]);
  });

  it('rejects an unknown classification', () => {
    expect(validateProjectConfig({ classification: 'secret' }).join()).toContain('classification');
  });

  it('rejects wrong field types', () => {
    expect(validateProjectConfig({ pii: 'yes' }).join()).toContain('pii');
    expect(validateProjectConfig({ name: 7 }).join()).toContain('name');
    expect(validateProjectConfig({ handling: { mirror: 'no' } }).join()).toContain('handling.mirror');
    expect(validateProjectConfig([]).join()).toContain('project');
  });
});
