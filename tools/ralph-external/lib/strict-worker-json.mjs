// Parse bounded worker JSON without accepting duplicate object keys.
/**
 * Thrown by {@link parseStrictWorkerJson} with a stable `code` so callers can
 * map a scan failure to a specific contract-violation message without
 * string-matching free-text.
 */
export class StrictJsonScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * RFC 8259 JSON parser used on every strict worker-final path (JSONL lines,
 * `format: 'json'`, and the MCP `content[0].text`/top-level envelope) instead
 * of `JSON.parse`. `JSON.parse` silently keeps the LAST value when an object
 * repeats a member name — RFC 8259 §4 explicitly leaves this to the
 * implementation, and V8 picks "last wins". That lets a forged worker final
 * smuggle a second, hidden value past a first one: a trailing duplicate
 * `"status":"completed"` can overwrite an earlier `"status":"failed"`, or a
 * trailing duplicate `"type":"result"` can collapse a `"type":"message"`
 * framing envelope into a bogus result in one line (#2890 BLOCKER 1+2).
 *
 * This scanner tracks member names per object independently at every
 * nesting level (a sibling object may reuse a name the scanner already saw
 * in its parent or an earlier sibling) and rejects any object that repeats
 * one. Names are compared only after the scanner has fully decoded them —
 * resolving `\"`, other single-character escapes, and `\uXXXX` escapes
 * (including surrogate pairs, since JS string concatenation of two decoded
 * UTF-16 code units forms the pair automatically) — so an escape-obfuscated
 * collision (`"status"` vs `"status"`) is caught exactly like a literal
 * one. A non-colliding unknown key, escaped or not, is left for the existing
 * `additionalProperties: false` schema check to reject, unchanged.
 *
 * Nesting depth is bounded during the scan (not only afterward, by
 * `boundedJson()`'s post-parse walk) so pathological depth fails fast with a
 * clear `DEPTH` code instead of relying on a recursive-descent stack
 * overflow to be caught as a generic syntax error.
 *
 * @param {string} text - Decoded JSON text (already UTF-8 validated by the caller)
 * @param {number} maxDepth - Same bound as `WORKER_MAX_NESTING_DEPTH`; root value is depth 1
 * @returns {unknown}
 */
export function parseStrictWorkerJson(text, maxDepth) {
  const length = text.length;
  let index = 0;

  function fail(code, message) {
    throw new StrictJsonScanError(code, `${message} (offset ${index})`);
  }

  function skipWhitespace() {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  }

  function parseValue(depth) {
    skipWhitespace();
    if (index >= length) fail('SYNTAX', 'Unexpected end of JSON input');
    const code = text.charCodeAt(index);
    if (code === 0x7b) return parseObject(depth);
    if (code === 0x5b) return parseArray(depth);
    if (code === 0x22) return parseString();
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return parseNumber();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    fail('SYNTAX', 'Unexpected token');
  }

  function parseObject(depth) {
    if (depth > maxDepth) fail('DEPTH', 'Worker nesting depth exceeds bound');
    index += 1; // {
    const result = {};
    const seen = new Set();
    skipWhitespace();
    if (text.charCodeAt(index) === 0x7d) { index += 1; return result; }
    for (;;) {
      skipWhitespace();
      if (text.charCodeAt(index) !== 0x22) fail('SYNTAX', 'Expected object member name');
      const key = parseString();
      if (seen.has(key)) fail('DUPLICATE', `Duplicate object member name ${JSON.stringify(key)}`);
      seen.add(key);
      skipWhitespace();
      if (text.charCodeAt(index) !== 0x3a) fail('SYNTAX', 'Expected colon after object member name');
      index += 1;
      // Define, never assign: assignment would invoke the inherited __proto__
      // setter, hiding the member from own-key validation and diverging from
      // JSON.parse, which creates an ordinary own property.
      Object.defineProperty(result, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      const delimiter = text.charCodeAt(index);
      if (delimiter === 0x2c) { index += 1; continue; }
      if (delimiter === 0x7d) { index += 1; break; }
      fail('SYNTAX', 'Expected , or } in object');
    }
    return result;
  }

  function parseArray(depth) {
    if (depth > maxDepth) fail('DEPTH', 'Worker nesting depth exceeds bound');
    index += 1; // [
    const result = [];
    skipWhitespace();
    if (text.charCodeAt(index) === 0x5d) { index += 1; return result; }
    for (;;) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      const delimiter = text.charCodeAt(index);
      if (delimiter === 0x2c) { index += 1; continue; }
      if (delimiter === 0x5d) { index += 1; break; }
      fail('SYNTAX', 'Expected , or ] in array');
    }
    return result;
  }

  function parseString() {
    index += 1; // opening quote
    let value = '';
    for (;;) {
      if (index >= length) fail('SYNTAX', 'Unterminated string');
      const code = text.charCodeAt(index);
      if (code === 0x22) { index += 1; return value; }
      if (code === 0x5c) {
        index += 1;
        const escape = text[index];
        if (escape === undefined) fail('SYNTAX', 'Unterminated escape sequence');
        switch (escape) {
          case '"': value += '"'; index += 1; break;
          case '\\': value += '\\'; index += 1; break;
          case '/': value += '/'; index += 1; break;
          case 'b': value += '\b'; index += 1; break;
          case 'f': value += '\f'; index += 1; break;
          case 'n': value += '\n'; index += 1; break;
          case 'r': value += '\r'; index += 1; break;
          case 't': value += '\t'; index += 1; break;
          case 'u': {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('SYNTAX', 'Invalid unicode escape');
            // Decoded code unit is appended as-is; two consecutive decoded
            // surrogate halves recombine into one character automatically
            // through normal JS UTF-16 string concatenation.
            value += String.fromCharCode(parseInt(hex, 16));
            index += 5;
            break;
          }
          default: fail('SYNTAX', 'Invalid escape sequence');
        }
      } else if (code < 0x20) {
        fail('SYNTAX', 'Unescaped control character in string');
      } else {
        value += text[index];
        index += 1;
      }
    }
  }

  function parseNumber() {
    const start = index;
    if (text.charCodeAt(index) === 0x2d) index += 1;
    if (text.charCodeAt(index) === 0x30) {
      index += 1;
    } else if (text.charCodeAt(index) >= 0x31 && text.charCodeAt(index) <= 0x39) {
      index += 1;
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    } else fail('SYNTAX', 'Invalid number');
    if (text.charCodeAt(index) === 0x2e) {
      index += 1;
      if (!(text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39)) fail('SYNTAX', 'Invalid number fraction');
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    }
    if (text.charCodeAt(index) === 0x65 || text.charCodeAt(index) === 0x45) {
      index += 1;
      if (text.charCodeAt(index) === 0x2b || text.charCodeAt(index) === 0x2d) index += 1;
      if (!(text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39)) fail('SYNTAX', 'Invalid number exponent');
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    }
    return Number(text.slice(start, index));
  }

  const result = parseValue(1);
  skipWhitespace();
  if (index !== length) fail('SYNTAX', 'Unexpected trailing characters after JSON value');
  return result;
}

