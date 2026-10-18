/** Encode a complete TOML basic string using valid Unicode scalar values. */
export function tomlString(value) {
  if (typeof value !== 'string' || [...value].some(char => {
    const point = char.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff;
  })) throw new Error('TOML values must be strings containing valid Unicode scalar values');
  // JSON escapes align with TOML basic strings except DEL must also be escaped.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}
