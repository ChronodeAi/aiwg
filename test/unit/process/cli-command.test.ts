import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCommand, resolveExecutable } from '../../../src/process/cli-command.mjs';

describe('cliCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiwg-cli-command-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves non-Windows invocations unchanged', () => {
    expect(cliCommand('openclaw', ['literal;argument'], 'linux', dir))
      .toEqual(['openclaw', ['literal;argument']]);
  });

  it.each([
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & ',
  ])('resolves a Windows npm shim with prefix %j without evaluating its contents', prefix => {
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, '');
    writeFileSync(join(dir, 'openclaw.cmd'), `@ECHO off\r\n${prefix}"%_prog%" --no-warnings "%dp0%\\entry.mjs" %*\r\n`);
    const args = ['$(echo injected)', '" & literal'];
    expect(cliCommand('openclaw', args, 'win32', dir, '.EXE;.CMD'))
      .toEqual([process.execPath, ['--no-warnings', entry, ...args]]);
  });

  it('resolves the npm.cmd launcher bundled with Node distributions', () => {
    const bin = join(dir, 'node_modules', 'npm', 'bin');
    const entry = join(bin, 'npm-cli.js');
    mkdirSync(bin, { recursive: true });
    writeFileSync(entry, '');
    copyFileSync(fileURLToPath(new URL('../../fixtures/codeql-residual/npm.cmd', import.meta.url)), join(dir, 'npm.cmd'));
    expect(cliCommand('npm', ['view', 'aiwg', '--json'], 'win32', dir, '.CMD'))
      .toEqual([process.execPath, [entry, 'view', 'aiwg', '--json']]);
  });

  it('uses Node installed beside a Windows npm shim when present', () => {
    const node = join(dir, 'node.exe');
    const entry = join(dir, 'entry.mjs');
    writeFileSync(node, '');
    writeFileSync(entry, '');
    writeFileSync(join(dir, 'clawhub.cmd'), '"%_prog%" "%dp0%\\entry.mjs" %*\n');
    expect(cliCommand('clawhub', ['--version'], 'win32', dir, '.CMD'))
      .toEqual([node, [entry, '--version']]);
  });

  it('leaves native Windows executables shell-free', () => {
    const executable = join(dir, 'openclaw.exe');
    writeFileSync(executable, '');
    expect(cliCommand('openclaw', ['--version'], 'win32', dir, '.EXE;.CMD'))
      .toEqual([executable, ['--version']]);
  });

  it('resolves arbitrary batch executables without interpreting their contents', () => {
    const executable = join(dir, 'code.cmd');
    writeFileSync(executable, '@echo arbitrary editor launcher');
    expect(resolveExecutable('code', 'win32', dir, '.EXE;.CMD')).toBe(executable);
    expect(resolveExecutable(executable, 'win32', '', '.EXE;.CMD')).toBe(executable);
    expect(resolveExecutable('missing', 'win32', dir, '.EXE;.CMD')).toBe('missing');
    expect(resolveExecutable('code', 'linux', dir, '.CMD')).toBe('code');
  });

  it.each(['.CMD;.EXE;.BAT;.COM', '.BAT;.COM;.CMD;.EXE'])('prefers native executables in PATHEXT order: %s', pathExt => {
    for (const extension of ['cmd', 'bat', 'exe', 'com']) {
      writeFileSync(join(dir, `code.${extension}`), '');
    }
    const expected = pathExt.indexOf('.EXE') < pathExt.indexOf('.COM') ? 'exe' : 'com';
    expect(resolveExecutable('code', 'win32', dir, pathExt)).toBe(join(dir, `code.${expected}`));
    expect(resolveExecutable('code.cmd', 'win32', dir, pathExt)).toBe(join(dir, 'code.cmd'));
  });

  it('keeps PATH precedence when preferring native executables', () => {
    const later = join(dir, 'later');
    mkdirSync(later);
    writeFileSync(join(dir, 'code.cmd'), '');
    writeFileSync(join(later, 'code.exe'), '');
    expect(resolveExecutable('code', 'win32', `${dir};${later}`, '.CMD;.EXE'))
      .toBe(join(dir, 'code.cmd'));
  });

  it.each(['.\\code.exe', './code.exe'])('resolves relative %s against cwd instead of PATH', command => {
    const cwd = join(dir, 'project');
    mkdirSync(cwd);
    const executable = join(cwd, 'code.exe');
    writeFileSync(executable, '');
    writeFileSync(join(dir, 'code.exe'), '');
    expect(resolveExecutable(command, 'win32', dir, '.EXE;.CMD', cwd)).toBe(executable);
    expect(cliCommand(command, ['--wait'], 'win32', dir, '.EXE;.CMD', cwd))
      .toEqual([executable, ['--wait']]);
    rmSync(executable);
    expect(resolveExecutable(command, 'win32', dir, '.EXE;.CMD', cwd)).toBe(command);
    expect(cliCommand(command, [], 'win32', dir, '.EXE;.CMD', cwd)).toEqual([command, []]);
  });

  it('applies PATHEXT to relative paths against cwd', () => {
    const cwd = join(dir, 'project');
    const tools = join(cwd, 'tools');
    mkdirSync(tools, { recursive: true });
    const shim = join(tools, 'code.cmd');
    const entry = join(tools, 'entry.mjs');
    writeFileSync(entry, '');
    writeFileSync(shim, '"%_prog%" "%dp0%\\entry.mjs" %*\n');
    expect(resolveExecutable('tools\\code', 'win32', dir, '.EXE;.CMD', cwd)).toBe(shim);
    expect(cliCommand('tools\\code', ['--wait'], 'win32', dir, '.EXE;.CMD', cwd))
      .toEqual([process.execPath, [entry, '--wait']]);
  });

  it('tries PATHEXT for dotted names while honoring an existing exact name', () => {
    const executable = join(dir, 'subl.v2.exe');
    const exact = join(dir, 'subl.v2');
    writeFileSync(executable, '');
    expect(resolveExecutable('subl.v2', 'win32', dir, '.EXE;.CMD')).toBe(executable);
    expect(cliCommand('subl.v2', [], 'win32', dir, '.EXE;.CMD')).toEqual([executable, []]);
    writeFileSync(exact, '');
    expect(resolveExecutable('subl.v2', 'win32', dir, '.EXE;.CMD')).toBe(exact);
    expect(cliCommand('subl.v2', [], 'win32', dir, '.EXE;.CMD')).toEqual([exact, []]);
  });

  it('keeps PATH directory precedence for cliCommand', () => {
    const later = join(dir, 'later');
    mkdirSync(later);
    const executable = join(dir, 'code.exe');
    writeFileSync(executable, '');
    writeFileSync(join(later, 'code.com'), '');
    expect(cliCommand('code', [], 'win32', `${dir};${later}`, '.COM;.EXE'))
      .toEqual([executable, []]);
  });

  it('refuses unsupported batch scripts and missing npm entry points', () => {
    const shim = join(dir, 'openclaw.cmd');
    writeFileSync(shim, '@echo arbitrary batch script\n');
    expect(() => cliCommand('openclaw', [], 'win32', dir, '.CMD'))
      .toThrow('Unsupported Windows CLI shim');
    writeFileSync(shim, '"%_prog%" "%dp0%\\missing.mjs" %*\n');
    expect(() => cliCommand('openclaw', [], 'win32', dir, '.CMD'))
      .toThrow('Missing Windows CLI entry point');
  });
});
