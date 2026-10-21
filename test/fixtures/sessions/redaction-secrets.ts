// Deliberately synthetic values; no provider-issued credentials.
export const syntheticSecrets: Array<[string, string]> = [
  ['provider-token', `eyJ${'a'.repeat(12)}.${'b'.repeat(16)}.${'c'.repeat(16)}`],
  ['provider-token', `AIza${'F'.repeat(35)}`],
  ['provider-token', 'https://hooks.slack.com/services/TFAKE000/BFAKE000/FAKEFAKEFAKEFAKE'],
  ...['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'glpat-', 'xai-', 'npm_', 'hf_', 'sk-ant-']
    .map((prefix): [string, string] => ['provider-token', `${prefix}FAKE00000000000000000000`]),
  ['environment-assignment', `AWS_SECRET_ACCESS_KEY=${'F'.repeat(40)}`],
  ...['DSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY']
    .map((label): [string, string] => ['private-key', `-----BEGIN ${label}-----\nFAKEPRIVATEKEYBODY\n-----END ${label}-----`]),
  ['credential', '  password fake-netrc-value'],
];

// Built from obviously fake pieces, without a prefix caught by another policy rule.
export const multilineSecretValue = 'FAKE' + 'a1B2c3D4'.repeat(3);
const gaps = ['\n', '\n    ', '\n\n', '\r\n\t', ' \t\r\n \r\n    '];
export const multilineSecrets: Array<[string, string]> = [
  ...['password', 'token', 'secret', 'api_key', 'api-key', 'apikey'].flatMap(key =>
    [':', '='].flatMap(separator => gaps.flatMap(gap =>
      ['', '"', "'", '`'].map((quote): [string, string] =>
        ['credential', `${key}${separator}${gap}${quote}${multilineSecretValue}${quote}`])))),
  ...['AWS_SECRET_ACCESS_KEY', 'MY_API_TOKEN', 'MY_SECRET', 'MY_PASSWORD', 'MY_PASSWD', 'MY_API_KEY'].flatMap(key =>
    gaps.flatMap(gap => ['', '"', "'", '`'].map((quote): [string, string] =>
      ['environment-assignment', `${key}=${gap}${quote}${multilineSecretValue}${quote}`]))),
  ...['\t', ...gaps].flatMap(gap => ['', '"', "'", '`', '\\"'].map((quote): [string, string] =>
    ['bearer-token', `Bearer${gap}${quote}${multilineSecretValue}${quote}`])),
  ...['Authorization', 'Cookie', 'Set-Cookie'].flatMap(key => ['\t', ...gaps].flatMap(gap =>
    ['', '"', "'", '`', '\\"'].map((quote): [string, string] =>
      [key === 'Authorization' ? 'authorization' : 'cookie', `${key}:${gap}${quote}${multilineSecretValue}${quote}`]))),
  ...['\t', ...gaps].flatMap(gap => [
    `https://fixture-user:${gap}${multilineSecretValue}@example.test/path`,
    `https://${gap}fixture-user:${multilineSecretValue}@example.test/path`,
    `https://fixture-user:${multilineSecretValue}@${gap}example.test/path`,
  ].map((value): [string, string] => ['credential-url', value])),
  ...['"', "'", '`', '\\"'].map((quote): [string, string] =>
    ['credential-url', `https://fixture-user:${quote}${multilineSecretValue}${quote}@example.test/path`]),
  ['credential-url', `https://fixture-user:"${multilineSecretValue} fake\\"suffix"@example.test/path`],
];

// The issue describes scan-strict.py as these policy patterns with \s* gaps and
// case-sensitive keywords. Keep this oracle independent of policy.ts; the titan
// scanner itself is not available in the local fixture corpus.
export const strictScannerPatterns = [
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/,
  /\b(?:AWS_SECRET_ACCESS_KEY|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY))\s*=\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/,
  /\bAuthorization\s*:\s*[^\r\n]+/,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/,
];
