import { execFileSync } from 'node:child_process';

const cmdMetaChars = /([()\][%!^"`<>&|;, *?])/g;

function quoteCmdArgument(value) {
  // Match cross-spawn's argument transport: first escape quotes and trailing
  // backslashes for the target's argv parser, then protect cmd metacharacters
  // outside quotes. Doubling % only works in batch source, not a /c operand.
  const argument = String(value)
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, '$1$1');
  // Batch wrappers forward operands through another cmd parse (typically %*),
  // so retain one layer of caret escaping for that second parse.
  return `"${argument}"`.replace(cmdMetaChars, '^$1').replace(cmdMetaChars, '^$1');
}

/**
 * Resolve a package-manager invocation without asking Node to execute a
 * Windows command script directly. Node rejects direct .cmd/.bat execution on
 * current Windows releases; cmd.exe is the native interpreter for those files.
 */
export function resolveManagerCommand(file, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args };
  }

  const env = options.env ?? process.env;
  const commandInterpreter = env.ComSpec || env.COMSPEC || 'cmd.exe';
  // The command itself is consumed by the first parse; only its operands need
  // the second escape layer. Escape spaces in the path as well as operators.
  const command = `"${[String(file).replace(cmdMetaChars, '^$1'), ...args.map(quoteCmdArgument)].join(' ')}"`;
  return {
    file: commandInterpreter,
    args: ['/d', '/v:off', '/s', '/c', command],
    // The payload above already contains cmd.exe-native quoting. Instruct
    // Node not to apply MSVCRT escaping to those embedded quotes (#173).
    windowsVerbatimArguments: true,
  };
}

export function executeManagerCommand(file, args, options = {}) {
  const invocation = resolveManagerCommand(file, args, options);
  const execute = options.execute ?? execFileSync;
  const execOptions = options.execOptions
    ? { ...options.execOptions }
    : { stdio: 'inherit' };
  if (invocation.windowsVerbatimArguments === true) {
    execOptions.windowsVerbatimArguments = true;
  }
  return execute(invocation.file, invocation.args, execOptions);
}
