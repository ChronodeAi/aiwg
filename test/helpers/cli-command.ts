import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// npm's Windows shims cannot be spawned directly without a shell. Resolve only
// their standard Node invocation; never evaluate batch contents or shell args.
export function cliCommand(
  command: string,
  args: string[],
  platform = process.platform,
  searchPath = process.env.PATH ?? '',
): [string, string[]] {
  if (platform !== 'win32') return [command, args];
  const candidates = path.isAbsolute(command)
    ? [command]
    : searchPath.split(';').filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    const executable = candidate.endsWith('.exe') ? candidate : `${candidate}.exe`;
    if (existsSync(executable)) return [executable, args];
    const shim = candidate.endsWith('.cmd') ? candidate : `${candidate}.cmd`;
    if (!existsSync(shim)) continue;
    const entry = readFileSync(shim, 'utf8').match(
      /^\s*(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?"%_prog%"\s+"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/m,
    );
    if (!entry) throw new Error(`Unsupported Windows CLI shim: ${shim}`);
    const script = path.resolve(path.dirname(shim), ...entry[1].split('\\'));
    if (!existsSync(script)) throw new Error(`Missing Windows CLI entry point: ${script}`);
    const localNode = path.join(path.dirname(shim), 'node.exe');
    return [existsSync(localNode) ? localNode : process.execPath, [script, ...args]];
  }
  return [command, args];
}
