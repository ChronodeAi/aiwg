import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// npm's Windows shims cannot be spawned directly without a shell. Resolve only
// their standard Node invocation; never evaluate batch contents or shell args.
export function cliCommand(
  command,
  args,
  platform = process.platform,
  searchPath = process.env.PATH ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
) {
  if (platform !== 'win32') return [command, args];
  const candidates = path.isAbsolute(command)
    ? [command]
    : searchPath.split(';').filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    const extensions = path.extname(candidate) ? [''] : pathExt.split(';').filter(Boolean).map(ext => ext.toLowerCase());
    for (const extension of extensions) {
      const shim = `${candidate}${extension}`;
      if (!existsSync(shim)) continue;
      if (!/\.(?:cmd|bat)$/i.test(shim)) return [shim, args];
      const contents = readFileSync(shim, 'utf8');
      const entry = contents.match(
        /^\s*(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?(?:set PATHEXT=%PATHEXT:;.JS;=;% & )?"%_prog%"\s+((?:(?:"[^"\r\n&|<>^%]*"|[^\s"&|<>^%]+)\s+)*)"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/m,
      );
      // Node distributions bundle npm/npx launchers with named entry variables
      // rather than cmd-shim's _prog invocation. Resolve their local JS entry.
      const bundled = !entry && /^(?:npm|npx)\.cmd$/i.test(path.basename(shim))
        ? contents.match(/^SET "(NPM|NPX)_CLI_JS=%~dp0\\(node_modules\\npm\\bin\\(?:npm|npx)-cli\.js)"\s*$/im)
        : null;
      if (!entry && (!bundled || !contents.includes(`"%NODE_EXE%" "%${bundled[1]}_CLI_JS%" %*`))) {
        throw new Error(`Unsupported Windows CLI shim: ${shim}`);
      }
      const nodeArgs = entry
        ? Array.from(entry[1].matchAll(/"([^"]*)"|([^\s"]+)/g), match => match[1] ?? match[2])
        : [];
      const script = path.resolve(path.dirname(shim), ...(entry ? entry[2] : bundled[2]).split('\\'));
      if (!existsSync(script)) throw new Error(`Missing Windows CLI entry point: ${script}`);
      const localNode = path.join(path.dirname(shim), 'node.exe');
      return [existsSync(localNode) ? localNode : process.execPath, [...nodeArgs, script, ...args]];
    }
  }
  return [command, args];
}
