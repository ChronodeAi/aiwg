// Shared checker for the npm-package install-ability guard (#3062 finding
// 1): an installed package only ships `tools/` and `dist/src/` (see
// `files` in package.json), not `src/` itself. A shipped `tools/**/*.mjs`
// or `bin/**` file that imports `../../src/<module>` by a literal relative
// path works in a git checkout (`src/` exists there) but throws
// `ERR_MODULE_NOT_FOUND` once installed, where only `dist/src/<module>`
// exists. This is exactly the bug class `tools/_resolve-impl.mjs`'s
// `importImpl` exists to avoid; see its header comment for the shipped-vs-
// maintainer-only distinction.
//
// Parses with the TypeScript AST (same approach as
// tools/testing/check-sync-child-process-timeouts.mjs) rather than a text
// regex, so a module-specifier-shaped string inside a comment or string
// literal is never mistaken for a real import.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Every relative (`.`-prefixed) import/export/dynamic-import module
 * specifier in `text`. Covers `import ... from '...'`, `export ... from
 * '...'`, and `import('...')`. `require('...')` is intentionally out of
 * scope: this repository is ESM-only (`"type": "module"`), and nothing in
 * tools/**\/*.mjs resolves its own `src/` imports through `require`.
 *
 * @param {string} file - used only for diagnostics in the parser, not read
 * @param {string} text
 * @returns {string[]}
 */
export function findRelativeImportSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers.filter((spec) => spec.startsWith('.'));
}

/**
 * Relative imports in `relFile` (given its source `text`) that do not
 * resolve to any path in `packedSet`.
 *
 * @param {{ root: string, relFile: string, text: string, packedSet: Set<string> }} args
 * @returns {{ spec: string, resolvedRel: string }[]}
 */
export function unresolvedRelativeImports({ root, relFile, text, packedSet }) {
  const absoluteFile = path.join(root, relFile);
  const violations = [];
  for (const spec of findRelativeImportSpecifiers(relFile, text)) {
    const resolvedAbsolute = path.resolve(path.dirname(absoluteFile), spec);
    const resolvedRel = path.relative(root, resolvedAbsolute).split(path.sep).join('/');
    if (!packedSet.has(resolvedRel)) violations.push({ spec, resolvedRel });
  }
  return violations;
}

/**
 * Every unresolved relative import across every shipped `tools/**\/*.mjs`
 * or `bin/**` file in `packedFiles` whose name matches `pattern`.
 *
 * @param {{
 *   root: string,
 *   packedFiles: string[],
 *   pattern?: RegExp,
 *   readFile?: (absolutePath: string) => string,
 * }} args
 * @returns {{ file: string, spec: string, resolvedRel: string }[]}
 */
export function checkPackedRelativeImports({
  root,
  packedFiles,
  pattern = /\.mjs$/,
  readFile = (absolutePath) => fs.readFileSync(absolutePath, 'utf8'),
}) {
  const packedSet = new Set(packedFiles);
  const candidates = packedFiles.filter(
    (relFile) => (relFile.startsWith('tools/') || relFile.startsWith('bin/')) && pattern.test(relFile),
  );

  const violations = [];
  for (const relFile of candidates) {
    let text;
    try {
      text = readFile(path.join(root, relFile));
    } catch {
      continue; // listed in the manifest but not actually readable here — not this guard's concern
    }
    for (const violation of unresolvedRelativeImports({ root, relFile, text, packedSet })) {
      violations.push({ file: relFile, ...violation });
    }
  }
  return violations;
}
