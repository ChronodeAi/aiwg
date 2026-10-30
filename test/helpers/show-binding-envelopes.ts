import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the production CLI parser and JSON renderer in one process.
 * The local backend isolates binding/envelope behavior from Fortemi cache
 * verification. Requests run serially without nested CLI fan-out. */
export function showBindingEnvelopes(
  repo: string,
  env: NodeJS.ProcessEnv,
  requests: Array<{ type: string; id: string }>,
): any[] {
  const cli = pathToFileURL(path.join(repo, 'dist/src/artifacts/cli.js')).href;
  const script = `
    const { main } = await import(${JSON.stringify(cli)});
    const emit = console.log;
    const results = [];
    console.log = value => results.push(JSON.parse(value));
    for (const { type, id } of JSON.parse(process.argv[1])) {
      await main(['show', type, id, '--json', '--backend', 'local']);
    }
    emit(JSON.stringify(results));
  `;
  return JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '--eval', script, JSON.stringify(requests)],
    { cwd: repo, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
}
