// Mask Markdown examples without changing source offsets.
/**
 * Blank out fenced code blocks and inline code spans, preserving offsets and line
 * structure, so link extraction sees only prose. Illustrative paths inside an
 * example block are documentation, not context links the graph should resolve (#2536).
 */
export function maskCodeRegions(content: string): string {
  const lines = content.split('\n');
  let fence: { marker: string; length: number } | null = null;
  const masked = lines.map((line) => {
    const openOrClose = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // A closing fence uses the same character, is at least as long, and carries no info string.
      if (openOrClose && openOrClose[1][0] === fence.marker && openOrClose[1].length >= fence.length && openOrClose[2].trim() === '') {
        fence = null;
      }
      return ' '.repeat(line.length);
    }
    if (openOrClose) {
      fence = { marker: openOrClose[1][0], length: openOrClose[1].length };
      return ' '.repeat(line.length);
    }
    // Inline code spans: a run of N backticks closes on the next run of exactly N.
    return line.replace(/(`+)(?:[^`]|(?!\1)`)*?\1/g, (span) => ' '.repeat(span.length));
  });
  return masked.join('\n');
}

