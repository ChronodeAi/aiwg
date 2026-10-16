import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeManagerCommand, resolveManagerCommand } from '../../../src/installation/manager-command.mjs';

describe('executeManagerCommand', () => {
  it('hands a quoted Windows wrapper payload to cmd.exe verbatim', () => {
    const execute = vi.fn();

    executeManagerCommand(
      'C:\\Program Files\\nodejs\\npm.cmd',
      ['install', '--global', 'aiwg@latest'],
      {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        execute,
      },
    );

    expect(execute).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"install^^^" ^^^"--global^^^" ^^^"aiwg@latest^^^""',
      ],
      { stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it('preserves manager-probe execution options when enabling verbatim arguments', () => {
    const execute = vi.fn();
    const execOptions = {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    };

    executeManagerCommand('C:\\Program Files\\nodejs\\npm.cmd', ['--version'], {
      platform: 'win32',
      execute,
      execOptions,
    });

    expect(execute).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/v:off', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"--version^^^""'],
      { ...execOptions, windowsVerbatimArguments: true },
    );
    expect(execOptions).not.toHaveProperty('windowsVerbatimArguments');
  });

  it('does not enable Windows verbatim arguments for native executables', () => {
    const execute = vi.fn();

    executeManagerCommand('/usr/local/bin/npm', ['--version'], {
      platform: 'linux',
      execute,
    });

    expect(execute).toHaveBeenCalledWith(
      '/usr/local/bin/npm',
      ['--version'],
      { stdio: 'inherit' },
    );
  });
});

// Fixed transport vectors, including argv quoting before the two cmd parses.
const operands = [
  ['%PATH%', '^^^"^^^%PATH^^^%^^^"'],
  ['100%.txt', '^^^"100^^^%.txt^^^"'],
  ['!x!', '^^^"^^^!x^^^!^^^"'],
  ['&', '^^^"^^^&^^^"'],
  ['^', '^^^"^^^^^^^"'],
  ['"', '^^^"\\^^^"^^^"'],
  ['with spaces', '^^^"with^^^ spaces^^^"'],
  ['', '^^^"^^^"'],
  ['C:\\trailing\\', '^^^"C:\\trailing\\\\^^^"'],
  ['a\\"b', '^^^"a\\\\\\^^^"b^^^"'],
  ['|<>()', '^^^"^^^|^^^<^^^>^^^(^^^)^^^"'],
];

describe('cmd operand transport (#3117)', () => {
  it.each(operands)('preserves manager operand %j', (operand, escaped) => {
    const execute = vi.fn();
    executeManagerCommand('npm.cmd', [operand], { platform: 'win32', execute });
    expect(execute).toHaveBeenCalledWith(
      'cmd.exe', ['/d', '/v:off', '/s', '/c', `"npm.cmd ${escaped}"`],
      { stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it.each(operands)('preserves editor operand %j through the shared resolver', (operand, escaped) => {
    expect(resolveManagerCommand('C:\\Editor Files\\code.bat', ['--wait', operand], {
      platform: 'win32',
    })).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"C:\\Editor^ Files\\code.bat ^^^"--wait^^^" ${escaped}"`],
      windowsVerbatimArguments: true,
    });
  });

  it.skipIf(process.platform !== 'win32').each(['npm.cmd', 'editor.bat'])(
    'round trips literal operands through a native Windows %s wrapper', wrapperName => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiwg-cmd-operands-'));
      try {
        const capture = path.join(root, 'capture.cjs');
        const output = path.join(root, 'argv.json');
        const wrapper = path.join(root, wrapperName);
        writeFileSync(capture, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
        writeFileSync(wrapper, `@"${process.execPath}" "${capture}" %*\r\n`);
        const args = operands.map(([operand]) => operand);
        if (wrapperName === 'npm.cmd') {
          executeManagerCommand(wrapper, args, { execOptions: { timeout: 60_000 } });
        } else {
          const invocation = resolveManagerCommand(wrapper, args);
          execFileSync(invocation.file, invocation.args, {
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            timeout: 60_000,
          });
        }
        expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(args);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
