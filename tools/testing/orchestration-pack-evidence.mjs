// Inspect executable test declarations for owned orchestration scenario mappings.
import ts from 'typescript';

export function assertedTests(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) return [];
  const tests = new Set(); const suites = new Set(); const expects = new Set(); const asserts = new Set();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (/^(node:)?assert(\/strict)?$/.test(module) && clause?.name) asserts.add(clause.name.text);
    if (/^(node:)?test$/.test(module) && clause?.name) tests.add(clause.name.text);
    if (!['vitest', 'node:test', 'test'].includes(module)) continue;
    for (const item of clause?.namedBindings?.elements ?? []) {
      const original = (item.propertyName ?? item.name).text;
      if (['it', 'test'].includes(original)) tests.add(item.name.text);
      if (original === 'describe') suites.add(item.name.text);
      if (original === 'expect') expects.add(item.name.text);
    }
  }
  const target = expression => {
    const modifiers = [];
    while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
      if (ts.isPropertyAccessExpression(expression)) modifiers.push(expression.name.text);
      expression = expression.expression;
    }
    return { name: ts.isIdentifier(expression) ? expression.text : '', modifiers };
  };
  const hasAssertion = body => {
    let found = false;
    const expectCall = expression => {
      while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
          && expects.has(expression.expression.text) && expression.arguments.length) return true;
        expression = expression.expression;
      }
      return false;
    };
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const { name } = target(node.expression);
        // expect(value) alone is not an assertion: require a matcher call.
        if ((expects.has(name) && ts.isPropertyAccessExpression(node.expression)
          && /^to[A-Z]/.test(node.expression.name.text) && expectCall(node.expression)) || asserts.has(name)) found = true;
      }
      // An uncalled helper containing assertions is not test content.
      if (node !== body && ts.isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  const result = [];
  const visit = (node, disabled = false) => {
    if (ts.isFunctionLike(node)) return; // Declarations in uncalled helpers are not runnable.
    if (ts.isCallExpression(node)) {
      const { name, modifiers } = target(node.expression);
      const declaration = tests.has(name) || suites.has(name);
      const options = node.arguments.find(ts.isObjectLiteralExpression);
      const skipped = options?.properties.some(property => ts.isPropertyAssignment(property)
        && ['skip', 'todo', 'only'].includes(property.name.text) && property.initializer.kind !== ts.SyntaxKind.FalseKeyword);
      const inactive = disabled || skipped || (declaration && modifiers.some(value => value !== 'each'));
      const title = node.arguments[0];
      const callback = node.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (tests.has(name) && !inactive && title && ts.isStringLiteralLike(title) && callback && hasAssertion(callback.body)) {
        result.push(title.text);
      }
      if (declaration) {
        if (callback) ts.forEachChild(callback.body, child => visit(child, inactive));
        return;
      }
    }
    ts.forEachChild(node, child => visit(child, disabled));
  };
  visit(ast);
  return result;
}

export function scenarioErrors(id, pack, contents) {
  const errors = [];
  const requirements = pack.requirements;
  const scenarios = pack.scenarios;
  if (pack.status === 'implemented' && (!Array.isArray(requirements) || !requirements.length
    || !Array.isArray(scenarios) || !scenarios.length)) {
    errors.push(`${id}: implemented requires owned scenario/requirement mappings`);
  }
  if (requirements === undefined && scenarios === undefined) return errors;
  if (!Array.isArray(requirements) || !requirements.length || requirements.some(value => !/^(N?FR)-OG-\d{3}$/.test(value))
    || new Set(requirements).size !== requirements.length) errors.push(`${id}: invalid requirements`);
  if (!Array.isArray(scenarios)) return [...errors, `${id}: scenarios must be an array`];
  const seen = new Set();
  for (const scenario of scenarios) {
    const label = `${id}: scenario ${scenario?.id ?? '(missing)'}`;
    if (!scenario || typeof scenario !== 'object') { errors.push(`${label}: invalid mapping`); continue; }
    if (typeof scenario.id !== 'string' || !/^[A-Z][A-Z0-9-]*$/.test(scenario.id) || seen.has(scenario.id)) errors.push(`${label}: invalid or duplicate ID`);
    seen.add(scenario.id);
    if (!Array.isArray(requirements) || !requirements.includes(scenario.requirement)) errors.push(`${label}: requirement is not declared by pack`);
    if (!Array.isArray(pack.mechanismOwners) || !pack.mechanismOwners.includes(scenario.mechanismOwner)) errors.push(`${label}: mechanism owner is not owned by pack`);
    if (![pack.slice, ...(Array.isArray(pack.sharedSlices) ? pack.sharedSlices : [])].includes(scenario.slice)) errors.push(`${label}: slice is not owned by pack`);
    if (!pack.testFiles.includes(scenario.testFile)) errors.push(`${label}: test file is not registered to pack`);
    const title = scenario.testName;
    if (typeof title !== 'string' || ![id, scenario.id, scenario.requirement].every(token => title.split(/\s+/).includes(token))
      || !contents.get(scenario.testFile)?.includes(title)) errors.push(`${label}: no matching runnable asserted test with pack/scenario/requirement title`);
  }
  if (pack.status === 'implemented') {
    for (const requirement of Array.isArray(requirements) ? requirements : []) {
      if (!scenarios.some(scenario => scenario?.requirement === requirement)) errors.push(`${id}: unmapped requirement ${requirement}`);
    }
    for (const file of pack.testFiles) {
      if (!scenarios.some(scenario => scenario?.testFile === file)) errors.push(`${id}: unrelated test file ${file} has no owned scenario`);
    }
  }
  return errors;
}
