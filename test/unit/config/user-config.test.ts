/**
 * UserConfig Tests
 *
 * @source @src/config/user-config.ts
 * @implements #545
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  UserConfig,
  resolveConfigDir,
  parseYamlSimple,
  serializeYamlSimple,
  DEFAULT_USER_CONFIG,
  KNOWN_CONFIG_FILES,
} from '../../../src/config/user-config.js';

describe('UserConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aiwg-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('resolveConfigDir', () => {
    it('should return override path when provided', () => {
      const result = resolveConfigDir('/custom/path');
      expect(result).toBe('/custom/path');
    });

    it('should respect AIWG_CONFIG env var', () => {
      const original = process.env.AIWG_CONFIG;
      process.env.AIWG_CONFIG = '/env/override';
      try {
        const result = resolveConfigDir();
        expect(result).toBe('/env/override');
      } finally {
        if (original !== undefined) {
          process.env.AIWG_CONFIG = original;
        } else {
          delete process.env.AIWG_CONFIG;
        }
      }
    });

    it('should prefer override over env var', () => {
      const original = process.env.AIWG_CONFIG;
      process.env.AIWG_CONFIG = '/env/path';
      try {
        const result = resolveConfigDir('/override/path');
        expect(result).toBe('/override/path');
      } finally {
        if (original !== undefined) {
          process.env.AIWG_CONFIG = original;
        } else {
          delete process.env.AIWG_CONFIG;
        }
      }
    });
  });

  describe('getPath', () => {
    it('should return the resolved config directory', () => {
      const config = new UserConfig(tempDir);
      expect(config.getPath()).toBe(tempDir);
    });
  });

  describe('ensureDir', () => {
    it('should create the config directory if it does not exist', async () => {
      const subDir = join(tempDir, 'nested', 'dir');
      const config = new UserConfig(subDir);
      await config.ensureDir();

      const { existsSync } = await import('fs');
      expect(existsSync(subDir)).toBe(true);
    });
  });

  describe('get/set', () => {
    it('reports rejected YAML and refuses writes without changing the file bytes', async () => {
      const configPath = join(tempDir, 'config.yaml');
      const content = Buffer.from('defaults:\n  provider: openai\n__proto__:\n  polluted: yes\n');
      await writeFile(configPath, content);
      const config = new UserConfig(tempDir);
      const error = `Failed to load ${configPath}: Unsafe config key: prototype-related names are not allowed`;

      await expect(config.get('defaults.provider')).rejects.toThrow(error);
      await expect(config.list()).rejects.toThrow(error);
      await expect(config.set('defaults.verbosity', 'verbose')).rejects.toThrow(error);
      await expect(config.reset()).rejects.toThrow(error);
      expect(await readFile(configPath)).toEqual(content);
    });

    it('refuses to save cached values over a file that now fails to parse', async () => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.provider', 'openai');
      const configPath = join(tempDir, 'config.yaml');
      const content = Buffer.from('defaults:\n  provider: openai\n__proto__:\n  polluted: yes\n');
      await writeFile(configPath, content);

      await expect(config.set('defaults.verbosity', 'verbose')).rejects.toThrow(`Failed to load ${configPath}: Unsafe config key`);
      expect(await readFile(configPath)).toEqual(content);
    });

    it('surfaces read errors instead of using defaults', async () => {
      const configPath = join(tempDir, 'config.yaml');
      await mkdir(configPath);
      const config = new UserConfig(tempDir);

      await expect(config.get('defaults.provider')).rejects.toThrow(`Failed to load ${configPath}: EISDIR`);
      await expect(config.set('defaults.provider', 'openai')).rejects.toThrow(`Failed to load ${configPath}: EISDIR`);
      await expect(config.reset()).rejects.toThrow(`Failed to load ${configPath}: EISDIR`);
    });

    it('uses defaults for a missing file and creates it on set', async () => {
      const config = new UserConfig(join(tempDir, 'missing'));
      const configPath = join(config.getPath(), 'config.yaml');
      expect(await config.get('defaults.provider')).toBe('claude');
      await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await config.set('defaults.provider', 'openai');

      expect(await new UserConfig(config.getPath()).get('defaults.provider')).toBe('openai');
      expect(await readFile(configPath, 'utf-8')).toContain('provider: openai');
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects %s in every position of a dotted set path', async (segment) => {
      const config = new UserConfig(tempDir);
      const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
      await config.set('defaults.provider', 'openai');
      const savedBefore = await readFile(join(tempDir, 'config.yaml'), 'utf-8');

      for (const path of [segment, `${segment}.polluted`, `custom.${segment}.polluted`, `defaults.${segment}`]) {
        await expect(config.set(path, 'polluted')).rejects.toThrow('Unsafe config key path: prototype-related segments are not allowed');
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore);
      }

      expect(await readFile(join(tempDir, 'config.yaml'), 'utf-8')).toBe(savedBefore);
      expect(await config.get('custom')).toBeUndefined();
      expect(await config.get('defaults.provider')).toBe('openai');
    });

    it('creates own config nodes instead of traversing inherited objects', async () => {
      const config = new UserConfig(tempDir);
      const listed = await config.list();
      const loaded = listed['config.yaml'] as Record<string, unknown>;
      const inherited = { custom: { value: 'original' } };
      Object.setPrototypeOf(loaded, inherited);

      await config.set('custom.value', 'updated');

      expect(inherited.custom.value).toBe('original');
      expect(Object.hasOwn(loaded, 'custom')).toBe(true);
      expect(await new UserConfig(tempDir).get('custom.value')).toBe('updated');
    });

    it('should return default values for unset keys', async () => {
      const config = new UserConfig(tempDir);
      const value = await config.get('defaults.provider');
      expect(value).toBe('claude');
    });

    it('should return undefined for nonexistent keys', async () => {
      const config = new UserConfig(tempDir);
      const value = await config.get('nonexistent.key');
      expect(value).toBeUndefined();
    });

    it.each(['__proto__', '__proto__.toString', 'constructor', 'constructor.prototype', 'toString', 'defaults.__proto__', 'defaults.constructor', 'defaults.toString'])('does not read inherited config path %s', async key => {
      expect(await new UserConfig(tempDir).get(key)).toBeUndefined();
    });

    it('reads own config values while ignoring inherited values at every depth', async () => {
      Object.defineProperty(Object.prototype, 'wp4ReadInherited', { value: { value: 'inherited' }, configurable: true });
      try {
        const config = new UserConfig(tempDir);
        await config.set('custom.value', 'own');
        expect(await config.get('wp4ReadInherited')).toBeUndefined();
        expect(await config.get('wp4ReadInherited.value')).toBeUndefined();
        expect(await config.get('custom.wp4ReadInherited.value')).toBeUndefined();
        expect(await config.get('custom.value')).toBe('own');
      } finally {
        delete (Object.prototype as Record<string, unknown>).wp4ReadInherited;
      }
    });

    it('should set and get a string value', async () => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.provider', 'openai');
      const value = await config.get('defaults.provider');
      expect(value).toBe('openai');
    });

    it('should set and get a boolean value', async () => {
      const config = new UserConfig(tempDir);
      await config.set('telemetry.enabled', 'true');
      const value = await config.get('telemetry.enabled');
      expect(value).toBe(true);
    });

    it('should persist values to config.yaml', async () => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.verbosity', 'verbose');

      // Read the file directly
      const content = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
      expect(content).toContain('verbose');
    });

    it('should create nested keys that do not exist yet', async () => {
      const config = new UserConfig(tempDir);
      await config.set('custom.nested.key', 'value');
      const value = await config.get('custom.nested.key');
      expect(value).toBe('value');
    });

    it.each([
      'constructor.prototype.wp4Polluted',
      'custom.constructor.prototype.wp4Polluted',
      ...['__proto__', 'constructor', 'prototype'].flatMap(segment => [
        segment,
        `${segment}.wp4Polluted`,
        `custom.${segment}.wp4Polluted`,
        `custom.nested.${segment}`,
      ]),
    ])('rejects unsafe config path %s without changing config or prototypes', async key => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.provider', 'openai');
      const before = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
      const cached = structuredClone((await config.list())['config.yaml']);
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      try {
        await expect(config.set(key, 'true')).rejects.toThrow(/unsafe.*config.*path/i);
        expect((await config.list())['config.yaml']).toEqual(cached);
        expect(await readFile(join(tempDir, 'config.yaml'), 'utf-8')).toBe(before);
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
      } finally {
        delete (Object.prototype as Record<string, unknown>).wp4Polluted;
      }
    });

    it('creates an own config section instead of writing into an inherited object', async () => {
      const inherited = { value: 'original' };
      Object.defineProperty(Object.prototype, 'wp4Inherited', { value: inherited, writable: true, configurable: true });
      try {
        const config = new UserConfig(tempDir);
        await config.set('wp4Inherited.value', 'local');
        expect(inherited.value).toBe('original');
        const saved = (await config.list())['config.yaml'] as Record<string, unknown>;
        expect(Object.hasOwn(saved, 'wp4Inherited')).toBe(true);
        expect(await new UserConfig(tempDir).get('wp4Inherited.value')).toBe('local');
        expect(inherited.value).toBe('original');
      } finally {
        delete (Object.prototype as Record<string, unknown>).wp4Inherited;
      }
    });
  });

  describe('list', () => {
    it('should return config.yaml defaults when no files exist', async () => {
      const config = new UserConfig(tempDir);
      const result = await config.list();
      expect(result['config.yaml']).toBeDefined();
    });

    it('should include models.json when present', async () => {
      // Create a models.json
      await writeFile(join(tempDir, 'models.json'), '{"version": "2"}', 'utf-8');

      const config = new UserConfig(tempDir);
      const result = await config.list();
      expect(result['models.json']).toBeDefined();
      expect((result['models.json'] as Record<string, unknown>).version).toBe('2');
    });
  });

  describe('validate', () => {
    it.each(['__proto__', 'constructor', 'prototype'])('handles rejected YAML key %s safely during loading and validation', async key => {
      await writeFile(join(tempDir, 'config.yaml'), `apiVersion: aiwg.io/v1\nkind: UserConfig\n${key}:\n  wp4Polluted: yes\n`, 'utf-8');
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      try {
        const config = new UserConfig(tempDir);
        await expect(config.get('defaults.provider')).rejects.toThrow('Unsafe config key');
        await expect(config.get('wp4Polluted')).rejects.toThrow('Unsafe config key');
        await expect(config.list()).rejects.toThrow('Unsafe config key');
        expect(await config.validate()).toEqual([
          expect.objectContaining({ file: 'config.yaml', severity: 'error', message: expect.stringContaining('Unsafe config key') }),
        ]);
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
      } finally {
        delete (Object.prototype as Record<string, unknown>).wp4Polluted;
        delete (Object as unknown as Record<string, unknown>).wp4Polluted;
      }
    });

    it('should report info when config directory does not exist', async () => {
      const config = new UserConfig(join(tempDir, 'nonexistent'));
      const issues = await config.validate();
      expect(issues.length).toBe(1);
      expect(issues[0].severity).toBe('info');
    });

    it('should return no issues for valid config', async () => {
      const config = new UserConfig(tempDir);
      // Write a valid config
      await config.set('defaults.provider', 'claude');
      const issues = await config.validate();
      expect(issues.length).toBe(0);
    });

    it('should report error for invalid JSON in models.json', async () => {
      await writeFile(join(tempDir, 'models.json'), 'not json{', 'utf-8');
      const config = new UserConfig(tempDir);
      const issues = await config.validate();
      const jsonIssue = issues.find(i => i.file === 'models.json');
      expect(jsonIssue).toBeDefined();
      expect(jsonIssue!.severity).toBe('error');
    });
  });

  describe('reset', () => {
    it('should reset a specific key to its default', async () => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.provider', 'openai');
      await config.reset('defaults.provider');
      const value = await config.get('defaults.provider');
      expect(value).toBe('claude');
    });

    it('should reset all config to defaults', async () => {
      const config = new UserConfig(tempDir);
      await config.set('defaults.provider', 'openai');
      await config.set('telemetry.enabled', 'true');
      await config.reset();

      // Re-create instance to clear cache
      const freshConfig = new UserConfig(tempDir);
      const provider = await freshConfig.get('defaults.provider');
      expect(provider).toBe('claude');
    });
  });

  describe('KNOWN_CONFIG_FILES', () => {
    it('should include config.yaml, models.json, and ops.yaml', () => {
      const filenames = KNOWN_CONFIG_FILES.map(f => f.filename);
      expect(filenames).toContain('config.yaml');
      expect(filenames).toContain('models.json');
      expect(filenames).toContain('ops.json');
    });
  });

  describe('DEFAULT_USER_CONFIG', () => {
    it('should have correct structure', () => {
      expect(DEFAULT_USER_CONFIG.apiVersion).toBe('aiwg.io/v1');
      expect(DEFAULT_USER_CONFIG.kind).toBe('UserConfig');
      expect(DEFAULT_USER_CONFIG.defaults.provider).toBe('claude');
      expect(DEFAULT_USER_CONFIG.telemetry.enabled).toBe(false);
      expect(DEFAULT_USER_CONFIG.updates.channel).toBe('stable');
    });
  });
});

describe('YAML helpers', () => {
  describe('parseYamlSimple', () => {
    it.each(['__proto__', 'constructor', 'prototype'].flatMap(key => [
      `${key}:\n  wp4Polluted: yes\n`,
      `${key}: yes\n`,
      `defaults:\n  ${key}:\n    wp4Polluted: yes\n`,
      `defaults:\n  ${key}: yes\n`,
    ]))('rejects prototype-related YAML keys at every level: %s', yaml => {
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      try {
        expect(() => parseYamlSimple(yaml)).toThrow('Unsafe config key');
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
      } finally {
        delete (Object.prototype as Record<string, unknown>).wp4Polluted;
        delete (Object as unknown as Record<string, unknown>).wp4Polluted;
      }
    });

    it('should parse top-level key-value pairs', () => {
      const result = parseYamlSimple('name: test\nversion: 1');
      expect(result.name).toBe('test');
      expect(result.version).toBe(1);
    });

    it('should parse nested sections', () => {
      const result = parseYamlSimple('defaults:\n  provider: claude\n  verbosity: normal');
      const defaults = result.defaults as Record<string, unknown>;
      expect(defaults.provider).toBe('claude');
      expect(defaults.verbosity).toBe('normal');
    });

    it('should parse booleans', () => {
      const result = parseYamlSimple('enabled: true\ndisabled: false');
      expect(result.enabled).toBe(true);
      expect(result.disabled).toBe(false);
    });

    it('should skip comments and empty lines', () => {
      const result = parseYamlSimple('# comment\n\nkey: value');
      expect(result.key).toBe('value');
      expect(Object.keys(result)).toHaveLength(1);
    });

    it('should handle quoted strings', () => {
      const result = parseYamlSimple('name: "hello world"');
      expect(result.name).toBe('hello world');
    });
  });

  describe('serializeYamlSimple', () => {
    it('should serialize flat key-value pairs', () => {
      const result = serializeYamlSimple({ name: 'test', version: 1 });
      expect(result).toContain('name: test');
      expect(result).toContain('version: 1');
    });

    it('should serialize nested objects', () => {
      const result = serializeYamlSimple({
        defaults: { provider: 'claude' },
      });
      expect(result).toContain('defaults:');
      expect(result).toContain('  provider: claude');
    });

    it('should serialize booleans correctly', () => {
      const result = serializeYamlSimple({ enabled: true, disabled: false });
      expect(result).toContain('enabled: true');
      expect(result).toContain('disabled: false');
    });

    it('should roundtrip with parseYamlSimple', () => {
      const original = {
        apiVersion: 'aiwg.io/v1',
        kind: 'UserConfig',
        defaults: { provider: 'claude', verbosity: 'normal' },
        telemetry: { enabled: false },
      };
      const yaml = serializeYamlSimple(original);
      const parsed = parseYamlSimple(yaml);
      expect(parsed.apiVersion).toBe('aiwg.io/v1');
      expect(parsed.kind).toBe('UserConfig');
      expect((parsed.defaults as Record<string, unknown>).provider).toBe('claude');
      expect((parsed.telemetry as Record<string, unknown>).enabled).toBe(false);
    });
  });
});
