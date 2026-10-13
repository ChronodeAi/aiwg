// Shared checker for the npm-package install-ability guard (#3062 finding
// 1): an installed package only ships `tools/`, `bin/`, and `dist/src/`
// (see `files` in package.json), not `src/` itself. A shipped file that
// imports `../../src/<module>` by a literal relative path works in a git
// checkout (`src/` exists there) but throws `ERR_MODULE_NOT_FOUND` once
// installed, where only `dist/src/<module>` exists. This is exactly the
// bug class `tools/_resolve-impl.mjs`'s `importImpl` exists to avoid; see
// its header comment for the shipped-vs-maintainer-only distinction.
//
// Parses with the TypeScript AST (same approach as
// tools/testing/check-sync-child-process-timeouts.mjs) rather than a text
// regex, so a module-specifier-shaped string inside a comment or string
// literal is never mistaken for a real import.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Every shipped, executable file extension this guard checks. `.d.ts` is
 * deliberately excluded even though it ends in `.ts` — a type-only
 * declaration file is never executed, so an unresolvable "import" inside
 * one (really a type reference) cannot throw `ERR_MODULE_NOT_FOUND`.
 */
const EXECUTABLE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.ts'];

export function isExecutableToolFile(relFile) {
  if (relFile.endsWith('.d.ts') || relFile.endsWith('.d.mts') || relFile.endsWith('.d.cts')) return false;
  return EXECUTABLE_EXTENSIONS.some((extension) => relFile.endsWith(extension));
}

/**
 * Whether `node` (an import-bearing node) sits inside any function-like
 * ancestor before reaching the source file root — i.e. whether resolving
 * it is deferred to a later call rather than happening unconditionally
 * during module evaluation (#3062 B/C finding 2's "lazy or eager" axis).
 * A static `import`/`export ... from` declaration is never passed here —
 * those are always eager by construction, since they're hoisted and
 * linked before any of the module's own code runs.
 *
 * @param {ts.Node} node
 * @returns {boolean} true when lazy (inside a function), false when eager
 */
function isLazy(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Every relative (`.`-prefixed) import/export/dynamic-import module
 * specifier in `text`, each tagged with whether it resolves eagerly
 * (unconditionally, during module evaluation) or lazily (only once some
 * function actually runs). Covers `import ... from '...'`, `export ...
 * from '...'`, and `import('...')`. `require('...')` is intentionally out
 * of scope: this repository is ESM-only (`"type": "module"`), and nothing
 * shipped resolves its own `src/` imports through `require`.
 *
 * @param {string} file - used only for diagnostics in the parser, not read
 * @param {string} text
 * @returns {{ spec: string, lazy: boolean }[]}
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
      specifiers.push({ spec: node.moduleSpecifier.text, lazy: false });
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push({ spec: node.arguments[0].text, lazy: isLazy(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers.filter(({ spec }) => spec.startsWith('.'));
}

/**
 * Relative imports in `relFile` (given its source `text`) that do not
 * resolve to any path in `packedSet`.
 *
 * @param {{ root: string, relFile: string, text: string, packedSet: Set<string> }} args
 * @returns {{ spec: string, resolvedRel: string, lazy: boolean }[]}
 */
export function unresolvedRelativeImports({ root, relFile, text, packedSet }) {
  const absoluteFile = path.join(root, relFile);
  const violations = [];
  for (const { spec, lazy } of findRelativeImportSpecifiers(relFile, text)) {
    const resolvedAbsolute = path.resolve(path.dirname(absoluteFile), spec);
    const resolvedRel = path.relative(root, resolvedAbsolute).split(path.sep).join('/');
    if (!packedSet.has(resolvedRel)) violations.push({ spec, resolvedRel, lazy });
  }
  return violations;
}

/**
 * Every unresolved relative import across every shipped executable file
 * (`tools/**`, `bin/**`, `dist/src/**`) in `packedFiles`.
 *
 * `dist/src/**` is scanned too, not just the hand-authored `tools/`/`bin/`
 * trees (#3062 B/C finding 2): a `.mjs` file copied verbatim into
 * `dist/src/` by `tools/scripts/copy-build-resources.mjs`, or a compiled
 * `.js` file, can equally reference something outside the packed set.
 *
 * @param {{
 *   root: string,
 *   packedFiles: string[],
 *   isCandidate?: (relFile: string) => boolean,
 *   readFile?: (absolutePath: string) => string,
 * }} args
 * @returns {{ file: string, spec: string, resolvedRel: string, lazy: boolean }[]}
 */
export function checkPackedRelativeImports({
  root,
  packedFiles,
  isCandidate = (relFile) =>
    (relFile.startsWith('tools/') || relFile.startsWith('bin/') || relFile.startsWith('dist/src/'))
    && isExecutableToolFile(relFile),
  readFile = (absolutePath) => fs.readFileSync(absolutePath, 'utf8'),
}) {
  const packedSet = new Set(packedFiles);
  const candidates = packedFiles.filter(isCandidate);

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
