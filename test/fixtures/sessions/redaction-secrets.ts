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
