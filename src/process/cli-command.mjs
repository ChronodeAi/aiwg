import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Like worker dispatch, helper processes receive only explicitly named state.
// Keep provider credentials, NODE_OPTIONS and unrelated shell variables out of
// process launch diagnostics as well as the child's own environment.
export const HELPER_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  // Platform and network plumbing a child may need to reach anything at all
  // (corporate proxies and CA bundles, Windows per-user data, git global config).
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
]);

export const DESKTOP_HELPER_ENV_ALLOWLIST = Object.freeze([
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP',
]);

// Deployment helpers read project/configuration locations and policy switches;
// none consumes provider authentication or the caller's complete shell state.
export const DEPLOYMENT_HELPER_ENV_ALLOWLIST = Object.freeze([
  ...HELPER_ENV_ALLOWLIST, 'AIWG_ROOT', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_PROJECT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'LOCALAPPDATA',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROJECT_MEMORY_HOME', 'AIWG_USER_REGISTRY_PATH', 'AIWG_RULE_BINDING_INDEX_CACHE',
  'AIWG_DEPLOY_SUBPROCESS', 'AIWG_REPORT_DEPLOY_COLLISIONS', 'CODEX_HOME', 'HERMES_HOME',
  'OPENCLAW_PROFILE', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
  'AIWG_RESOLVE_IMPL_FROM', 'NODE_ENV', 'VITEST', 'NO_UPDATE_NOTIFIER', 'NO_COLOR', 'CI',
]);

/** Copy only the helper's declared variable names; never merge the parent. */
export function helperEnvironment(source = process.env, names = HELPER_ENV_ALLOWLIST) {
  const environment = {};
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'string' && !value.includes('\0')) environment[name] = value;
  }
  return environment;
}

// Share PATH/PATHEXT lookup with callers that can launch arbitrary batch files.
function* executableCandidates(command, searchPath, pathExt, preferNative = false, cwd = process.cwd()) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : /[\\/]/.test(command)
      ? [path.resolve(cwd, ...command.split(/[\\/]/))]
      : searchPath.split(';').filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    const pathExtensions = pathExt.split(';').filter(Boolean).map(ext => ext.toLowerCase());
    const extension = path.extname(candidate).toLowerCase();
    const extensions = extension && (pathExtensions.includes(extension) || existsSync(candidate))
      ? ['']
      : pathExtensions;
    if (preferNative) {
      extensions.sort((a, b) => Number(!/\.(?:exe|com)$/i.test(a)) - Number(!/\.(?:exe|com)$/i.test(b)));
    }
    for (const extension of extensions) {
      const executable = `${candidate}${extension}`;
      if (existsSync(executable)) yield executable;
    }
  }
}

export function resolveExecutable(
  command,
  platform = process.platform,
  searchPath = process.env.PATH ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  cwd = process.cwd(),
) {
  if (platform !== 'win32') return command;
  for (const executable of executableCandidates(command, searchPath, pathExt, true, cwd)) {
    return executable;
  }
  return command;
}

// npm's Windows shims cannot be spawned directly without a shell. Resolve only
// their standard Node invocation; never evaluate batch contents or shell args.
export function cliCommand(
  command,
  args,
  platform = process.platform,
  searchPath = process.env.PATH ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  cwd = process.cwd(),
) {
  if (platform !== 'win32') return [command, args];
  for (const shim of executableCandidates(command, searchPath, pathExt, false, cwd)) {
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
  return [command, args];
}
