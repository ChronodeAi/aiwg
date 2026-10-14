/**
 * Scanned-page vision extraction (#1507) — provider-neutral orchestration.
 *
 * @source @src/artifacts/corpus-tools/vision-extract.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPrompt,
  resolveAdapter,
  extractPages,
  pdftoppmAvailable,
  type VisionAdapter,
} from '../../../src/artifacts/corpus-tools/vision-extract.js';

let root: string;
let imageDir: string;
let outDir: string;

function pages(n: number): void {
  for (let i = 1; i <= n; i++) writeFileSync(join(imageDir, `page-${String(i).padStart(3, '0')}.png`), 'PNG');
}
/** Fake adapter: transcribes to `# Page N` unless the page is in `failPages`. */
function fake(failPages: number[] = []): VisionAdapter {
  return {
    name: 'fake',
    transcribe(_img, _prompt, ctx) {
      if (failPages.includes(ctx.page)) return { ok: false };
      return { ok: true, text: `# Page ${ctx.page}\n\nbody of page ${ctx.page}` };
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-vision-'));
  imageDir = join(root, 'images');
  outDir = join(root, 'out');
  mkdirSync(imageDir, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('buildPrompt (#1507)', () => {
  it('encodes the `# Page N` start contract', () => {
    const p = buildPrompt(7, 'Some Book');
    expect(p).toContain('Start exactly with: "# Page 7"');
    expect(p).toContain('Some Book');
    expect(p).toContain('[unreadable]');
  });
});

describe('resolveAdapter (#1507)', () => {
  it('defaults to codex', () => {
    expect(resolveAdapter().name).toBe('codex');
  });
  it('command provider requires a template', () => {
    expect(() => resolveAdapter({ provider: 'command' })).toThrow(/requires --command/);
    expect(resolveAdapter({ provider: 'command', command: 'x {image} {out}' }).name).toBe('command');
  });
  it.each(['image', 'prompt_file', 'out'])('rejects backslash-newline continuations that extend an allowed name for {%s}', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y -z');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    for (const name of ['AIWG_VISION_OUT', 'AIWG_VISION_IMAGE', 'AIWG_VISION_PROMPT_FILE']) {
      for (const newline of ['\n', '\r\n']) {
        const command = `${name}_S=sh; "$${name}\\${newline}_S" -c 'printf original:'{${placeholder}} > {out}`;
        expect(() => {
          const adapter = resolveAdapter({ provider: 'command', command: `cd '${root}'; ${command}` });
          adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
        }, command).toThrow(/line continuations/);
        expect(existsSync(join(root, 'PWNED'))).toBe(false);
        expect(existsSync(join(dir, 'PWNED'))).toBe(false);
      }
    }
  });
  it('bounds template validation: rejects oversized templates and stays fast on whitespace-heavy input', () => {
    expect(() => resolveAdapter({ provider: 'command', command: `x {image} {out}${' '.repeat(4096)}` }))
      .toThrow(/longer than 4096 characters/);
    const whitespaceLines = `${' '.repeat(40)}\n`.repeat(99) + 'x {image} {out}';
    const started = Date.now();
    expect(resolveAdapter({ provider: 'command', command: whitespaceLines }).name).toBe('command');
    expect(Date.now() - started).toBeLessThan(200);
  });
  it('passes image, prompt and output paths as positional arguments in real shell templates (141)', () => {
    const marker = join(root, 'pwned');
    const backtickMarker = join(root, 'backtick-pwned');
    // A slash-free relative marker lets the payload appear in a directory name.
    // The command intentionally starts in root so an unsafe substitution touches it.
    const dir = join(root, "x;:>PWNED;y images {prompt_file} {out} $(touch pwned) `touch backtick-pwned` 'single' \\ \"double\"");
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'literal image');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const adapter = resolveAdapter({ provider: 'command', command:
      `cd ${quote(root)} && cat {image} {prompt_file} > {out}` });
    const result = adapter.transcribe(image, '# Page 1\nPrompt', { root, page: 1, timeoutSec: 10 });
    expect(result).toEqual({ ok: true, text: 'literal image# Page 1\nPrompt' });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(backtickMarker)).toBe(false);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    expect(existsSync(join(dir, '.vision-out-1.txt'))).toBe(false);
  });

  it.each(['"{image}"', "'{prompt_file}'", '\\{image}'])('rejects unsafe placeholder context %s (141)', (placeholder) => {
    const dir = join(root, '$(touch pwned)');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    expect(() => {
      const adapter = resolveAdapter({ provider: 'command', command: `cd "${root}" && cat ${placeholder}` });
      adapter.transcribe(image, '# Page 1', { root, page: 1, timeoutSec: 10 });
    }).toThrow(/placeholders must/);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it.each(['image', 'prompt_file', 'out'])('rejects nested re-parsing and comment desync for {%s}', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const commands = [
      [`printf '%s\\n' "$(sh -c "printf original:{${placeholder}}")"`, /command substitution/],
      [`# "\nsh -c "printf original:{${placeholder}}"`, /nested shell/],
      [`# "\nprintf '<%s>\\n' "{${placeholder}}"`, /comments/],
    ] as const;
    for (const [command, error] of commands) {
      expect(() => {
        const adapter = resolveAdapter({ provider: 'command', command: `cd ${quote(root)}; ${command}` });
        adapter.transcribe(image, '# Page 1', { root, page: 1, timeoutSec: 10 });
      }).toThrow(error);
      expect(existsSync(join(root, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    }
  });

  it.each([
    ['printf "%s" "$(cat "$2")"', 'command substitution'],
    ['printf "%s" `cat "$2"`', 'backticks'],
    ['eval "$1"', 'eval'],
    ['e"val" "$1"', 'eval'],
    ...['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash', 'fish', 'csh', 'tcsh', 'rbash', 'busybox', 'toybox', 'busybox sh'].map(shell => [`${shell} -c "$1"`, 'nested shell']),
    ['env MODE=vision sh -c "$1"', 'nested shell'],
    ...['exec', 'command', 'nice -n 19', 'timeout 10', 'timeout 1.5s', 'env MODE=vision exec nice -n 19 timeout 10'].map(prefix => [`${prefix} /bin/sh -c "$1"`, 'nested shell']),
    ...[';', '|', '&&', '||', '&', '\n'].map(separator => [`printf x ${separator} sh -c "$1"`, 'nested shell']),
    ...['2>&1', '3<&0', '2>&-', '>&1', '<&0', '&>/dev/null', '2>>/dev/null'].map(redirection => [`sh ${redirection} -xc "$1"`, 'nested shell']),
    ['bash --noprofile "-xc" "$1"', 'nested shell'],
    ['bash -cl "$1"', 'nested shell'],
    ['s"h" -c "$1"', 'nested shell'],
    ['sh \\\n-c "$1"', 'line continuations'],
    ['printf "%s" "#"', 'comments'],
    ['printf "%s" \\#', 'comments'],
  ])('rejects re-parsing construct in %s with actionable guidance', (command, construct) => {
    expect(() => resolveAdapter({ provider: 'command', command })).toThrow(construct);
    expect(() => resolveAdapter({ provider: 'command', command })).toThrow('"$1"/"$2"/"$3"');
    expect(() => resolveAdapter({ provider: 'command', command })).toThrow('wrapper script');
  });

  it.each(['image', 'prompt_file', 'out'])('rejects expansion and joined shell bypasses for {%s} before execution', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y  -z *');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    const payload = `'printf original:'{${placeholder}} > {out}`;
    const commands = [
      `$SHELL -c ${payload}`,
      `"$SHELL" -c ${payload}`,
      `${'${SHELL}'} -c ${payload}`,
      `/bin/bash -c ${payload}`,
      `sh-c ${payload}`,
      `sh$IFS-c ${payload}`,
      `sh${'${IFS}'}-c ${payload}`,
      `S=/bin/sh; $S -c ${payload}`,
    ];
    for (const command of commands) {
      expect(() => {
        const adapter = resolveAdapter({ provider: 'command', command: `cd '${root}'; ${command}` });
        adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
      }, command).toThrow(/Vision command rejects.*wrapper script/);
      expect(existsSync(join(root, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    }
  });

  it.each([
    '$HOME', '"$HOME"', '${HOME}', '$S', '$IFS', '$SHELL', '$@', '$*', '$0', '$4', '${4}',
    '$', '$$', '$-', '$?', '$#', '$[1+1]', '$((1+1))', '$10', '${}',
    '${1:-fallback}', '${2#prefix}', '${3%tail}', '${AIWG_VISION_OUT:-fallback}',
    '$AIWG_VISION_OUTPUT', '$AIWG_VISION_IMAGE_suffix', '${AIWG_VISION_OUT_suffix}',
    "$'{image}'", '"$\'HOME"',
  ])('rejects non-contract dollar syntax %s with guidance independently of shell tokens', (expansion) => {
    const command = `tool ${expansion} {image} > {out}`;
    expect(() => resolveAdapter({ provider: 'command', command })).toThrow(/Vision command rejects.*wrapper script/);
    expect(() => resolveAdapter({ provider: 'command', command })).toThrow('"$1"/"$2"/"$3"');
  });

  it.each(['-color', '-cache', '-c1', '-c=1'])('conservatively rejects sh with %s', (option) => {
    expect(() => resolveAdapter({ provider: 'command', command: `sh ./vision ${option} {image}` }))
      .toThrow(/nested shell invocation/);
  });

  it.each(['image', 'prompt_file', 'out'])('rejects redirection-hidden nested shells for {%s}', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y  -z');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    expect(() => {
      const adapter = resolveAdapter({ provider: 'command', command:
        `cd '${root}'; sh 2>&1 -c 'printf original:'{${placeholder}} > {out}` });
      adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
    }).toThrow(/nested shell.*wrapper script/);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
  });

  it.each(['image', 'prompt_file', 'out'])('rejects nested shell prefix and option bypasses for {%s}', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y -z');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    const payload = `'printf original:'{${placeholder}} > {out}`;
    const commands = [
      ...['MODE=x', 'MODE=vision', 'FOO=1', '/usr/bin/env', 'env -u HOME', '</dev/null', 'exec >/dev/null', 'nohup']
        .map(prefix => `${prefix} sh -c ${payload}`),
      `{ sh -c ${payload}; }`,
      `(sh -c ${payload})`,
      `if true; then sh -c ${payload}; fi`,
      ...['-c', '-Cc', '-ec', '-xc', '-lc'].map(option => `sh ${option} ${payload}`),
      `busybox ash -c ${payload}`,
      `toybox sh -c ${payload}`,
      `printf '%s' -c; /bin/sh ${payload}`,
      // Option and command text joined into one word must not slip past the -c rule.
      `sh -c"$1" ${payload}`,
      `sh -c$1 ${payload}`,
      `sh -xc"$1" ${payload}`,
    ];
    for (const command of commands) {
      expect(() => {
        const adapter = resolveAdapter({ provider: 'command', command: `cd '${root}'; ${command}` });
        adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
      }, command).toThrow(/nested shell invocation \(-c\).*wrapper script/);
      expect(existsSync(join(root, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    }
  });

  it.each(['-C', '--c', '--concise', '-1c'])('accepts sh with an option outside the lowercase -c cluster rule: %s', (option) => {
    expect(resolveAdapter({ provider: 'command', command: `sh ./vision ${option} {image} {prompt_file} {out}` }).name)
      .toBe('command');
  });

  it.each(['image', 'prompt_file', 'out'])('rejects here-doc quote desync and here-strings for {%s}', (placeholder) => {
    const dir = join(root, 'x;:>PWNED;y  -z *');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    for (const command of [
      `exec > {out}\ncat <<'EOF' >/dev/null\n"\nEOF\nprintf '<%s>' "{${placeholder}}"`,
      `cat <<< {${placeholder}} > {out}`,
    ]) {
      expect(() => {
        const adapter = resolveAdapter({ provider: 'command', command: `cd '${root}'; ${command}` });
        adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
      }).toThrow(/here-documents and here-strings.*"\$1"\/"\$2"\/"\$3".*wrapper script/);
      expect(existsSync(join(root, 'PWNED'))).toBe(false);
      expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    }
  });

  it.each([
    ['./vision.sh --scale', 'vision.sh', '--scale'],
    ['sh ./vision --concise', 'vision', '--concise'],
  ])('passes every hostile path as one argument to %s through a real shell', (command, script, option) => {
    const dir = join(root, 'x;:>PWNED;y  -z *');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    writeFileSync(join(root, script), '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" > "$4"\n', { mode: 0o755 });
    const adapter = resolveAdapter({ provider: 'command', command:
      `cd '${root}' && ${command} {image} {prompt_file} {out}` });
    const result = adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
    expect(result.ok).toBe(true);
    expect(result.text?.trimEnd().split('\n')).toEqual([
      '4', option, image, join(dir, '.vision-prompt-1.txt'), join(dir, '.vision-out-1.txt'),
    ]);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });

  it('passes hostile paths literally through tool options and output redirection in a real shell', () => {
    const dir = join(root, 'x;:>PWNED;y -z');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    writeFileSync(join(root, 'tool'), '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" "$AIWG_VISION_OUT"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    const adapter = resolveAdapter({ provider: 'command', command:
      `cd '${root}' && tool --image {image} --prompt-file {prompt_file} > {out}` });
    const result = adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
    expect(result.ok).toBe(true);
    expect(result.text?.trimEnd().split('\n')).toEqual([
      '4', '--image', image, '--prompt-file', join(dir, '.vision-prompt-1.txt'), join(dir, '.vision-out-1.txt'),
    ]);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });

  it.each([
    'agentic/code/frameworks/research-complete/skills/vision-extract/SKILL.md',
    'agentic/code/plugins/research/skills/vision-extract/SKILL.md',
  ])('runs the documented wrapper example in %s with literal path arguments', (file) => {
    const doc = readFileSync(file, 'utf8');
    const command = doc.match(/--command '([^']+)'/)?.[1];
    const script = doc.match(/```sh\n(#!\/bin\/sh\n[\s\S]*?)\n```/)?.[1];
    expect(command).toBeDefined();
    expect(script).toBeDefined();
    expect(doc).toContain('Templates are trusted executable code');
    expect(doc).toContain('must not re-parse path values');
    expect(doc).toContain('All other `$` parameter/variable expansions are rejected');
    const dir = join(root, 'x;:>PWNED;y  -z *');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    writeFileSync(join(root, 'vision.sh'), script!, { mode: 0o755 });
    writeFileSync(join(root, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    const adapter = resolveAdapter({ provider: 'command', command:
      `cd '${root}' && ${command}` });
    const result = adapter.transcribe(image, 'prompt with spaces', { root, page: 1, timeoutSec: 10 });
    expect(result.ok).toBe(true);
    expect(result.text?.trimEnd().split('\n')).toEqual(['4', '-p', 'prompt with spaces', '--image', image]);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
  });

  it.each([
    'cat "$1" "$2" > "$3"',
    'cat "${1}" "${2}" > "${3}"',
    'cat "$AIWG_VISION_IMAGE" "$AIWG_VISION_PROMPT_FILE" > "$AIWG_VISION_OUT"',
    'cat "${AIWG_VISION_IMAGE}" "${AIWG_VISION_PROMPT_FILE}" > "${AIWG_VISION_OUT}"',
  ])('accepts direct data references and single-quoted # in %s', (command) => {
    const dir = join(root, 'x;:>PWNED;y');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'image');
    const adapter = resolveAdapter({ provider: 'command', command: `printf '%s' '#'; ${command}` });
    expect(adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 }))
      .toEqual({ ok: true, text: 'imageprompt' });
  });

  it.each([
    ['./vision.sh "$1" "$2" "$3"', 'vision.sh', '3'],
    ['tool --out "$AIWG_VISION_OUT" {image}', 'tool', '3'],
    ["./vision.sh '$HOME' {image}", 'vision.sh', '2'],
  ])('accepts contract references and literal single-quoted dollars in %s through a real shell', (command, script, count) => {
    const dir = join(root, 'x;:>PWNED;y  -z *');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    writeFileSync(join(root, script), '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" > "$AIWG_VISION_OUT"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    const adapter = resolveAdapter({ provider: 'command', command: `cd '${root}' && ${command}` });
    const result = adapter.transcribe(image, 'prompt', { root, page: 1, timeoutSec: 10 });
    const expected = command.startsWith('tool') ? ['--out', join(dir, '.vision-out-1.txt'), image]
      : command.includes('$HOME') ? ['$HOME', image]
      : [image, join(dir, '.vision-prompt-1.txt'), join(dir, '.vision-out-1.txt')];
    expect(result.ok).toBe(true);
    expect(result.text?.trimEnd().split('\n')).toEqual([count, ...expected]);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });
  it('rejects an unknown provider', () => {
    expect(() => resolveAdapter({ provider: 'bogus' })).toThrow(/unknown vision provider/);
  });
});

describe('extractPages orchestration (#1507)', () => {
  it('transcribes pages → per-page + combined Markdown with complete markers', async () => {
    pages(3);
    const r = await extractPages({ imageDir, outDir, adapter: fake(), title: 'Test Book' });
    expect(r).toMatchObject({ processed: 3, completed: 3, failed: 0 });
    const p1 = readFileSync(join(outDir, 'pages', 'page-001.md'), 'utf8');
    expect(p1.startsWith('<!-- extraction-status: complete -->')).toBe(true);
    expect(p1).toContain('# Page 1');
    // Combined MD + stripped txt.
    const md = readFileSync(join(outDir, 'out.vision.md'), 'utf8');
    expect(md).toContain('# Test Book');
    expect(md).toContain('# Page 1');
    expect(md).toContain('# Page 3');
    const txt = readFileSync(join(outDir, 'out.vision.txt'), 'utf8');
    expect(txt).not.toContain('extraction-status'); // comment markers stripped
  });

  it('is resumable — a second run skips already-complete pages', async () => {
    pages(2);
    await extractPages({ imageDir, outDir, adapter: fake() });
    // An adapter that would FAIL every page; resume must not call it for complete pages.
    let calls = 0;
    const counting: VisionAdapter = { name: 'count', transcribe: (_i, _p, ctx) => { calls++; return { ok: true, text: `# Page ${ctx.page}` }; } };
    const r = await extractPages({ imageDir, outDir, adapter: counting });
    expect(calls).toBe(0); // both pages already complete → adapter never invoked
    expect(r.completed).toBe(2);
  });

  it('--force re-transcribes complete pages', async () => {
    pages(1);
    await extractPages({ imageDir, outDir, adapter: fake() });
    let calls = 0;
    const counting: VisionAdapter = { name: 'count', transcribe: (_i, _p, ctx) => { calls++; return { ok: true, text: `# Page ${ctx.page}` }; } };
    await extractPages({ imageDir, outDir, adapter: counting, force: true });
    expect(calls).toBe(1);
  });

  it('writes a failed marker when transcription fails after retries', async () => {
    pages(2);
    const r = await extractPages({ imageDir, outDir, adapter: fake([2]), retries: 1, sleep: () => {} });
    expect(r).toMatchObject({ completed: 1, failed: 1 });
    expect(readFileSync(join(outDir, 'pages', 'page-002.md'), 'utf8')).toContain('<!-- extraction-status: failed -->');
  });

  it('rejects output that does not start with the `# Page N` contract', async () => {
    pages(1);
    const wrong: VisionAdapter = { name: 'wrong', transcribe: () => ({ ok: true, text: 'garbage without the page header' }) };
    const r = await extractPages({ imageDir, outDir, adapter: wrong, sleep: () => {} });
    expect(r.failed).toBe(1);
  });

  it('honors --start / --end page filtering', async () => {
    pages(5);
    const r = await extractPages({ imageDir, outDir, adapter: fake(), start: 2, end: 3 });
    expect(r.processed).toBe(2);
    expect(existsSync(join(outDir, 'pages', 'page-002.md'))).toBe(true);
    expect(existsSync(join(outDir, 'pages', 'page-001.md'))).toBe(false);
  });
});

describe('pdftoppm availability (#1507 rasterize)', () => {
  it('reports a boolean (true in this env)', () => {
    expect(typeof pdftoppmAvailable()).toBe('boolean');
  });
});
