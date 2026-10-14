/**
 * Tests for TestCodeGenerator
 *
 * @module test/unit/testing/generators/test-code-generator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { TestCodeGenerator, CodeGeneratorOptions } from '../../../../src/testing/generators/test-code-generator.js';
import { TestSuite, TestCase } from '../../../../src/testing/generators/test-case-generator.js';

describe('TestCodeGenerator', () => {
  let generator: TestCodeGenerator;

  const createMockTestCase = (overrides?: Partial<TestCase>): TestCase => ({
    id: 'TC-001-001',
    name: 'Test Case Name',
    description: 'Test case description',
    priority: 'high',
    type: 'positive',
    level: 'unit',
    preconditions: ['User is logged in'],
    steps: [
      { number: 1, action: 'User enters data', expectedResult: 'Data is accepted' },
      { number: 2, action: 'Verify result', expectedResult: 'Result is displayed' }
    ],
    postconditions: ['Data is saved'],
    testData: [
      { name: 'email', type: 'email', constraints: ['valid format'], examples: ['test@example.com'] }
    ],
    traceability: {
      useCaseId: 'UC-001',
      scenarioId: 'UC-001-MSS',
      nfrs: ['NFR-PERF-001']
    },
    tags: ['UC-001', 'unit'],
    estimatedDuration: 1000,
    ...overrides
  });

  const createMockTestSuite = (testCases: TestCase[]): TestSuite => ({
    id: 'TS-UC-001',
    name: 'Test Suite: User Login',
    description: 'Auto-generated test suite',
    useCaseId: 'UC-001',
    testCases,
    coverage: {
      mainScenario: true,
      extensionsCovered: 0,
      exceptionsCovered: 0,
      total: testCases.length
    },
    generatedAt: new Date().toISOString()
  });

  beforeEach(() => {
    generator = new TestCodeGenerator({
      framework: 'vitest',
      language: 'typescript'
    });
  });

  describe('generate', () => {
    it('should generate code from test suite', () => {
      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);

      expect(result.success).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('should track generation statistics', () => {
      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);

      expect(result.stats.totalTests).toBe(1);
      expect(result.stats.unitTests).toBe(1);
    });

    it('should separate tests by level', () => {
      const unitTest = createMockTestCase({ level: 'unit' });
      const integrationTest = createMockTestCase({ level: 'integration' });
      const e2eTest = createMockTestCase({ level: 'e2e' });
      const suite = createMockTestSuite([unitTest, integrationTest, e2eTest]);

      const result = generator.generate(suite);

      expect(result.stats.unitTests).toBe(1);
      expect(result.stats.integrationTests).toBe(1);
      expect(result.stats.e2eTests).toBe(1);
      expect(result.files.length).toBe(3);
    });
  });

  describe('File Generation', () => {
    it('should generate test files for each level', () => {
      // Test all three levels in one test
      const levels: Array<'unit' | 'integration' | 'e2e'> = ['unit', 'integration', 'e2e'];
      const filenameSuffixes = ['.unit.test.ts', '.integration.test.ts', '.e2e.test.ts'];

      for (let i = 0; i < levels.length; i++) {
        const testCase = createMockTestCase({ level: levels[i] });
        const suite = createMockTestSuite([testCase]);
        const result = generator.generate(suite);

        const file = result.files.find(f => f.testLevel === levels[i]);
        expect(file).toBeDefined();
        expect(file?.filename).toContain(filenameSuffixes[i]);
      }
    });

    it('should not generate file for level with no tests', () => {
      const testCase = createMockTestCase({ level: 'unit' });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);

      const integrationFile = result.files.find(f => f.testLevel === 'integration');
      const e2eFile = result.files.find(f => f.testLevel === 'e2e');

      expect(integrationFile).toBeUndefined();
      expect(e2eFile).toBeUndefined();
    });
  });

  describe('Vitest Output', () => {
    beforeEach(() => {
      generator = new TestCodeGenerator({
        framework: 'vitest',
        language: 'typescript'
      });
    });

    it('should include vitest imports and structure', () => {
      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      // Check all vitest patterns
      expect(content).toContain("import { describe, it, expect");
      expect(content).toContain("from 'vitest'");
      expect(content).toContain('describe(');
      expect(content).toContain('it(');
    });

    it('should include vi.fn() for mocks', () => {
      generator = new TestCodeGenerator({
        framework: 'vitest',
        language: 'typescript',
        generateMocks: true
      });

      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain('vi.fn()');
    });
  });

  describe('Jest Output', () => {
    it('should include jest imports', () => {
      generator = new TestCodeGenerator({
        framework: 'jest',
        language: 'typescript'
      });

      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain("from '@jest/globals'");
    });
  });

  describe('Playwright Output', () => {
    beforeEach(() => {
      generator = new TestCodeGenerator({
        framework: 'playwright',
        language: 'typescript'
      });
    });

    it('should include playwright imports and structure for E2E', () => {
      const testCase = createMockTestCase({ level: 'e2e' });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      // Check all playwright patterns
      expect(content).toContain("from '@playwright/test'");
      expect(content).toContain('test.describe(');
      expect(content).toContain('{ page }');
    });

    it('should generate page actions', () => {
      const testCase = createMockTestCase({
        level: 'e2e',
        steps: [
          { number: 1, action: 'Click submit button', expectedResult: 'Form submitted' },
          { number: 2, action: 'Enter username', expectedResult: 'Username accepted', testData: 'testuser' }
        ]
      });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain('await page.click');
      expect(content).toContain('await page.fill');
    });
  });

  describe('JavaScript Output', () => {
    it('should generate .js file extension', () => {
      generator = new TestCodeGenerator({
        framework: 'vitest',
        language: 'javascript'
      });

      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);

      expect(result.files[0].filename).toContain('.test.js');
    });
  });

  describe('Test Structure', () => {
    it('should include Arrange-Act-Assert comments', () => {
      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain('// Arrange');
      expect(content).toContain('// Act');
      expect(content).toContain('// Assert');
    });

    it('should include test case metadata and conditions in comments', () => {
      generator = new TestCodeGenerator({
        framework: 'vitest',
        language: 'typescript',
        includeComments: true
      });

      const testCase = createMockTestCase({
        id: 'TC-001-005',
        priority: 'critical',
        preconditions: ['User is authenticated', 'System is online'],
        postconditions: ['Data is persisted', 'User is notified']
      });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      // Check all metadata and conditions
      expect(content).toContain('TC-001-005');
      expect(content).toContain('critical');
      expect(content).toContain('User is authenticated');
      expect(content).toContain('System is online');
      expect(content).toContain('Data is persisted');
      expect(content).toContain('User is notified');
    });

    it('should include test data setup', () => {
      const testCase = createMockTestCase({
        testData: [
          { name: 'username', type: 'string', constraints: [], examples: ['testuser'] }
        ]
      });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain('testData');
      expect(content).toContain('username');
    });
  });

  describe('Setup and Teardown', () => {
    it('should include beforeEach and afterEach when enabled', () => {
      const configs = [
        { includeSetup: true, includeTeardown: false, expected: 'beforeEach' },
        { includeSetup: false, includeTeardown: true, expected: 'afterEach' }
      ];

      for (const config of configs) {
        generator = new TestCodeGenerator({
          framework: 'vitest',
          language: 'typescript',
          ...config
        });

        const testCase = createMockTestCase();
        const suite = createMockTestSuite([testCase]);
        const result = generator.generate(suite);
        const content = result.files[0].content;

        expect(content).toContain(config.expected);
      }
    });

    it('should not include setup when disabled', () => {
      generator = new TestCodeGenerator({
        framework: 'vitest',
        language: 'typescript',
        includeSetup: false,
        includeTeardown: false
      });

      const testCase = createMockTestCase();
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      // Note: imports still include beforeEach/afterEach, but no actual blocks
      expect(content).not.toMatch(/^\s+beforeEach\s*\(/m);
      expect(content).not.toMatch(/^\s+afterEach\s*\(/m);
    });
  });

  describe('Comment Options', () => {
    it('should include or exclude file header comments based on option', () => {
      const configs = [
        { includeComments: true, shouldContain: true },
        { includeComments: false, shouldContain: false }
      ];

      for (const config of configs) {
        generator = new TestCodeGenerator({
          framework: 'vitest',
          language: 'typescript',
          includeComments: config.includeComments
        });

        const testCase = createMockTestCase();
        const suite = createMockTestSuite([testCase]);
        const result = generator.generate(suite);
        const content = result.files[0].content;

        if (config.shouldContain) {
          expect(content).toContain('/**');
          expect(content).toContain('@module');
        } else {
          expect(content).not.toContain('/**');
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty test suite', () => {
      const suite = createMockTestSuite([]);

      const result = generator.generate(suite);

      expect(result.success).toBe(true);
      expect(result.files.length).toBe(0);
    });

    it('should escape quotes in test names', () => {
      const testCase = createMockTestCase({
        name: "Test with 'single' and \"double\" quotes"
      });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain(JSON.stringify(testCase.name));
    });

    it.each(['unit', 'integration', 'e2e'] as const)(
      'preserves hostile names as data in %s test registration', (level) => {
        const name = `quotes '" and backslashes \\"; */ injected = true; //\n\r\t雪`;
        const testCase = createMockTestCase({ level, name, steps: [], testData: [] });
        const suite = { ...createMockTestSuite([testCase]), name };
        const result = new TestCodeGenerator({
          framework: level === 'e2e' ? 'playwright' : 'vitest',
          language: 'javascript', includeComments: true,
          includeSetup: false, includeTeardown: false,
        }).generate(suite);
        expect(result.success).toBe(true);
        const registered: string[] = [];
        const describe = (title: string, body: () => void) => { registered.push(title); body(); };
        const register = (title: string) => { registered.push(title); };
        const context = { describe, it: register, test: Object.assign(register, { describe }), injected: false };
        // Parse and execute registrations without running unfinished test bodies.
        runInNewContext(result.files[0].content.replace(/^import .*$/gm, ''), context);
        const label = level === 'e2e' ? 'E2E' : level[0].toUpperCase() + level.slice(1);
        expect(registered).toEqual([`${name} - ${label} Tests`, name]);
        expect(context.injected).toBe(false);
      },
    );

    it.each(['unit', 'integration', 'e2e'] as const)(
      'imports generated %s code with hostile comment metadata safely', async (level) => {
        const block = '*/globalThis.injected=true;/*';
        const line = '\n globalThis.injected=true; //\r\u2028 globalThis.injected=true; //\u2029';
        const testCase = createMockTestCase({
          level, id: block, description: block,
          type: block as TestCase['type'], priority: block as TestCase['priority'],
          preconditions: [line], postconditions: [line],
          steps: [
            { number: 1, action: `Enter data${line}`, expectedResult: line },
            { number: 2, action: 'Verify result', expectedResult: line },
            { number: 3, action: `Custom action${line}`, expectedResult: line },
          ],
          testData: [{ name: 'safe', type: line, constraints: [line], examples: ['safe'] }],
        });
        const suite = { ...createMockTestSuite([testCase]), useCaseId: block, generatedAt: block };
        const result = new TestCodeGenerator({
          framework: level === 'e2e' ? 'playwright' : 'vitest',
          language: 'javascript', includeComments: true,
          includeSetup: false, includeTeardown: false,
        }).generate(suite);
        expect(result.success).toBe(true);
        // Replace framework imports with local stubs, then import the generated module.
        const stubs = `
          const globalThis = { injected: false };
          const bodies = [];
          const describe = (_name, body) => body();
          const it = (_name, body) => bodies.push(body);
          const test = Object.assign(it, { describe });
          const expect = () => ({ toBe() {}, toBeVisible() {}, toHaveURL() {} });
          export { globalThis as state, bodies };
        `;
        const code = stubs + result.files[0].content.replace(/^import .*$/gm, '');
        const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        expect(module.state.injected).toBe(false);
        for (const body of module.bodies) {
          await body({ page: { fill() {}, locator() {} } });
        }
        expect(module.state.injected).toBe(false);
      },
    );

    it.each(['unit', 'integration', 'e2e'] as const)(
      'executes %s test bodies with hostile string values safely', async (level) => {
        const value = "x'); globalThis.injected=true; //\\\n雪";
        const testCase = createMockTestCase({
          level, preconditions: [], postconditions: [],
          steps: [{ number: 1, action: 'Enter data', expectedResult: '', testData: value }],
          testData: [{ name: 'value', type: 'string', constraints: [], examples: [value] }],
        });
        const result = new TestCodeGenerator({
          framework: level === 'e2e' ? 'playwright' : 'vitest',
          language: 'javascript', includeComments: false,
          includeSetup: false, includeTeardown: false,
        }).generate(createMockTestSuite([testCase]));
        const bodies: Array<(context: unknown) => Promise<void>> = [];
        const register = (_name: string, body: (context: unknown) => Promise<void>) => bodies.push(body);
        const describe = (_name: string, body: () => void) => body();
        const context = {
          describe, it: register, test: Object.assign(register, { describe }), injected: false,
          expect: (actual: unknown) => ({
            toBe: (expected: unknown) => expect(actual).toBe(expected),
            toHaveURL: () => {},
          }),
        };
        let code = result.files[0].content.replace(/^import .*$/gm, '');
        // Observe the actual example value inside the generated unit/integration body.
        code = code.replace('const testData = {', 'const testData = globalThis.captured = {');
        runInNewContext(code, context);
        const values: string[] = [];
        for (const body of bodies) {
          await body({ page: { fill: (_selector: string, data: string) => values.push(data) } });
        }
        if (level === 'e2e') {
          expect(values).toEqual([value]);
        } else {
          expect((context as typeof context & { captured: unknown }).captured).toEqual({ value });
        }
        expect(context.injected).toBe(false);
      },
    );

    it.each(['0123', '00', '08', '9007199254740993', '0', '123'])(
      'imports numeric example %j as a valid ESM literal', async (example) => {
        const testCase = createMockTestCase({
          steps: [],
          testData: [{ name: 'value', type: 'number', constraints: [], examples: [example] }],
        });
        const result = new TestCodeGenerator({
          framework: 'vitest', language: 'javascript', includeSetup: false, includeTeardown: false,
        }).generate(createMockTestSuite([testCase]));
        expect(result.success).toBe(true);
        const stubs = `
          const bodies = [];
          const describe = (_name, body) => body();
          const it = (_name, body) => bodies.push(body);
          const expect = () => ({ toBe() {} });
          let captured;
          export { bodies, captured };
        `;
        const code = stubs + result.files[0].content.replace(/^import .*$/gm, '')
          .replace('const testData = {', 'const testData = captured = {');
        const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        for (const body of module.bodies) await body();
        const expected = String(Number(example)) === example ? Number(example) : example;
        expect(module.captured).toEqual({ value: expected });
      },
    );

    it.each([undefined, null, 1n, () => {}, Symbol('invalid'), {}].map((value, index) => ({ value, index })))(
      'rejects non-string names and test data before generating files: $index', ({ value }) => {
        const mutations: Array<[string, (suite: TestSuite) => void]> = [
          ['suite.name', suite => { suite.name = value as string; }],
          ['testCases[1].name', suite => { suite.testCases[1].name = value as string; }],
          ['testCases[1].testData[0].name', suite => { suite.testCases[1].testData[0].name = value as string; }],
          ['testCases[1].testData[0].examples[0]', suite => { suite.testCases[1].testData[0].examples[0] = value as string; }],
        ];
        if (value !== undefined) {
          mutations.push(['testCases[1].steps[0].testData', suite => {
            suite.testCases[1].steps[0].testData = value as string;
          }]);
        }
        for (const [field, mutate] of mutations) {
          const suite = createMockTestSuite([createMockTestCase(), createMockTestCase({ level: 'e2e' })]);
          mutate(suite);
          const result = generator.generate(suite);
          expect(result.success).toBe(false);
          expect(result.files).toEqual([]);
          expect(result.errors).toEqual([`Code generation failed: ${field} must be a string`]);
        }
      },
    );

    it.each(['testData', 'examples'] as const)('rejects missing %s arrays clearly', (field) => {
      const testCase = createMockTestCase();
      if (field === 'testData') testCase.testData = undefined as unknown as TestCase['testData'];
      else testCase.testData[0].examples = undefined as unknown as string[];
      const result = generator.generate(createMockTestSuite([testCase]));
      expect(result.success).toBe(false);
      expect(result.files).toEqual([]);
      const path = field === 'testData' ? 'testCases[0].testData' : 'testCases[0].testData[0].examples';
      expect(result.errors).toEqual([`Code generation failed: ${path} must be an array`]);
    });

    it('should handle test case with no steps', () => {
      const testCase = createMockTestCase({ steps: [] });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);

      expect(result.success).toBe(true);
    });

    it('should handle test case with no test data', () => {
      const testCase = createMockTestCase({ testData: [] });
      const suite = createMockTestSuite([testCase]);

      const result = generator.generate(suite);
      const content = result.files[0].content;

      expect(content).toContain('TODO');
    });
  });
});
