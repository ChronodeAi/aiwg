// Run the installed issue-audit source owner when invoked through a script runtime.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.env.AIWG_ROOT ?? path.resolve(import.meta.dirname, '../../../../../../..');
const { main } = await import(pathToFileURL(path.join(root, 'dist/src/issues/audit-cli.js')).href);
process.exitCode = await main(process.argv.slice(2), process.env.AIWG_PROJECT_ROOT ?? process.cwd());
