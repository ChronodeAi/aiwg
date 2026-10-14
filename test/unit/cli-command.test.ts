import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliCommand } from '../helpers/cli-command.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Windows test CLI resolution', () => {
  it.each([
    { command: 'opencode', prefix: '', nodeArgs: [] },
    { command: 'droid', prefix: 'set PATHEXT=%PATHEXT:;.JS;=;% & ', nodeArgs: [] },
    { command: 'opencode', prefix: 'set PATHEXT=%PATHEXT:;.JS;=;% & ', nodeArgs: ['--no-warnings', '--title', 'CLI with spaces'] },
    { command: 'droid', prefix: '', nodeArgs: ['--no-warnings'] },
  ])('resolves the npm $command shim with prefix "$prefix" and args $nodeArgs', ({ command, prefix, nodeArgs }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli shim with spaces-'));
    dirs.push(dir);
    const script = path.join(dir, 'node_modules', command, 'bin.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(path.join(dir, `${command}.cmd`),
      `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${prefix}"%_prog%"  ${nodeArgs.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')} "%dp0%\\node_modules\\${command}\\bin.js" %*\r\n`);
    const args = ['--version', 'space ; $literal & "quoted"'];
    const [executable, argv] = cliCommand(command, args, 'win32', dir);
    expect(executable).toBe(process.execPath);
    expect(argv).toEqual([...nodeArgs, script, ...args]);
    expect(JSON.parse(execFileSync(executable, argv, { encoding: 'utf8', timeout: 60_000 }))).toEqual(args);
    expect(cliCommand(path.join(dir, `${command}.cmd`), args, 'win32', ''))
      .toEqual([executable, argv]);
    writeFileSync(path.join(dir, 'node.exe'), '');
    expect(cliCommand(command, args, 'win32', dir)).toEqual([path.join(dir, 'node.exe'), argv]);
    rmSync(script);
    expect(() => cliCommand(command, args, 'win32', dir)).toThrow('Missing Windows CLI entry point');
  });

  it('honors PATHEXT order and the default COM, EXE, BAT, CMD order', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-extension-order-'));
    dirs.push(dir);
    const script = path.join(dir, 'bin.js');
    writeFileSync(script, '');
    writeFileSync(path.join(dir, 'droid.exe'), '');
    writeFileSync(path.join(dir, 'droid.cmd'), '"%_prog%" "%dp0%\\bin.js" %*');
    expect(cliCommand('droid', [], 'win32', dir, '.CMD;.EXE'))
      .toEqual([process.execPath, [script]]);
    expect(cliCommand('droid', [], 'win32', dir, '.EXE;.CMD'))
      .toEqual([path.join(dir, 'droid.exe'), []]);
    vi.stubEnv('PATHEXT', '.CMD;.EXE');
    expect(cliCommand('droid', [], 'win32', dir)).toEqual([process.execPath, [script]]);
    vi.stubEnv('PATHEXT', undefined);
    writeFileSync(path.join(dir, 'droid.com'), '');
    expect(cliCommand('droid', [], 'win32', dir))
      .toEqual([path.join(dir, 'droid.com'), []]);
    rmSync(path.join(dir, 'droid.com'));
    expect(cliCommand('droid', [], 'win32', dir)).toEqual([path.join(dir, 'droid.exe'), []]);
    rmSync(path.join(dir, 'droid.exe'));
    writeFileSync(path.join(dir, 'droid.bat'), '"%_prog%" --no-warnings "%dp0%\\bin.js" %*');
    expect(cliCommand('droid', [], 'win32', dir)).toEqual([process.execPath, ['--no-warnings', script]]);
    expect(cliCommand(path.join(dir, 'droid.cmd'), [], 'win32', '', '.EXE;.CMD'))
      .toEqual([process.execPath, [script]]);
  });

  it('uses native executables and rejects unsupported batch shims explicitly', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-native-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'droid.cmd'), '@ECHO off\r\necho unsupported');
    expect(() => cliCommand('droid', [], 'win32', dir)).toThrow('Unsupported Windows CLI shim');
    writeFileSync(path.join(dir, 'droid.exe'), '');
    expect(cliCommand('droid', ['--version'], 'win32', dir))
      .toEqual([path.join(dir, 'droid.exe'), ['--version']]);
    expect(cliCommand(path.join(dir, 'droid.exe'), [], 'win32', ''))
      .toEqual([path.join(dir, 'droid.exe'), []]);
    expect(cliCommand('droid', ['--version'], 'linux', dir)).toEqual(['droid', ['--version']]);
  });
});
