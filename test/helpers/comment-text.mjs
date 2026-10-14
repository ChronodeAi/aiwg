/** Replace comment spans without rescanning the resulting text for delimiters. */
export function replaceHtmlComments(text, replacement = ' ') {
  return text.replace(/<!--[\s\S]*?(?:--!>|-->|$)/g, replacement);
}

/** Delimiters separate note text; removing them must not join text into new tokens. */
export function splitCommentDelimiters(text) {
  return text.split(/<!--|--!?>/);
}

export function noteSentences(text) {
  return replaceHtmlComments(text, ' ').split(/[>()[\]]/)
    .flatMap(part => part.split(/(?<=[.!?])\s+/))
    .map(part => part.trim()).filter(Boolean);
}
