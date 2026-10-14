import { describe, expect, it } from 'vitest';
import { noteSentences, replaceHtmlComments } from '../helpers/comment-text.mjs';
import { clausesOf } from './decision/d29-structure-scan.mjs';

describe('comment handling in test assertions', () => {
  it('removes complete comments with either HTML terminator without joining tokens', () => {
    expect(replaceHtmlComments('before<!-- note > details -->after')).toBe('before after');
    expect(replaceHtmlComments('before<!-- hidden --!>after')).toBe('before after');
    expect(replaceHtmlComments('<!-- hidden --!><script>live</script>', '')).toBe('<script>live</script>');
    expect(replaceHtmlComments('<!-- outer <!-- nested -->visible-->')).toBe(' visible-->');
    expect(replaceHtmlComments('<!-<!-- hidden -->->')).toBe('<!- ->');
    expect(replaceHtmlComments('<!-- hidden --> <script type="module" src="live.js">'))
      .toContain('<script type="module" src="live.js">');
  });

  it('strips unterminated comments through EOF for the cockpit bundle assertion', () => {
    const html = '<p>visible</p><!-- <script type="module" src="assets/hidden.js"></script>';
    const live = replaceHtmlComments(html, '');
    expect(live).toBe('<p>visible</p>');
    expect(live.match(/<script[^>]+type="module"[^>]+src="([^"]*assets\/[^"]+\.js)"/)).toBeNull();
    expect(replaceHtmlComments('before<!-- hidden\nmore hidden')).toBe('before ');
  });

  it('splits note delimiters without creating new text from adjacent fragments', () => {
    expect(noteSentences('before<!-- nested <!-- note -->after-->tail')).toEqual(['before after--', 'tail']);
    expect(noteSentences('before<!-- unfinished')).toEqual(['before']);
    expect(noteSentences('Sentence. (Another sentence.)\n> Last.')).toEqual(['Sentence.', 'Another sentence.', 'Last.']);
    expect(noteSentences('Visible. <!-- hidden. --!> Another.')).toEqual(['Visible.', 'Another.']);
    expect(clausesOf({ claim: 'before<!-- note --!>after' })).toEqual(['before', 'note', 'after']);
    expect(clausesOf({ claim: 'before<!-- nested <!-- note -->after-->tail' })).toEqual(['before', 'nested', 'note', 'after', 'tail']);
  });
});
