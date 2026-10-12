/**
 * MCP credential rendering and policy.
 *
 * A registry entry carries credentials in two ways:
 *   - literal values in `env` / `headers` (and OMP `auth` / `oauth` secrets)
 *   - references: `headerEnv` (header -> variable) and `envFrom`
 *     (server variable -> variable), which name a variable the harness
 *     resolves when it starts the server. Only the variable name is written.
 *
 * Each harness spells a reference differently; ENV_REFERENCE_SYNTAX holds the
 * documented form. `null` means the harness documents no interpolation in its
 * MCP config, so a reference cannot be rendered and injection refuses.
 */

const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keyed by normalized MCP provider id.
 * Sources (checked 2026-10-03):
 *   claude-code  https://code.claude.com/docs/en/mcp (command, args, env, url, headers)
 *   cursor       https://cursor.com/docs/context/mcp (command, args, env, url, headers)
 *   windsurf     https://docs.devin.ai/desktop/cascade/mcp (command, args, env, url, headers)
 *   factory      https://docs.factory.com/cli/configuration/mcp (env and headers values only)
 *   opencode     https://opencode.ai/docs/config (any string value)
 *   antigravity  https://antigravity.google/docs/mcp (no interpolation documented)
 *   warp         https://docs.warp.dev/agent-platform/capabilities/mcp/ (no interpolation documented)
 *   codex        named keys instead of interpolation (env_vars, env_http_headers)
 */
export const ENV_REFERENCE_SYNTAX = Object.freeze({
  'claude-code': '${NAME}',
  claude: '${NAME}',
  cursor: '${env:NAME}',
  windsurf: '${env:NAME}',
  factory: '${NAME}',
  opencode: '{env:NAME}',
  omp: '${NAME}',
  'grok-build': '${NAME}',
  antigravity: null,
  agy: null,
  warp: null,
});

export const CREDENTIAL_POLICIES = Object.freeze(['literal', 'references', 'none']);

export function validateEnvReferenceName(name) {
  if (!ENV_REFERENCE_NAME.test(name)) {
    throw new Error(`Invalid MCP environment variable reference "${name}"`);
  }
}

function hasEntries(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

function hasReferences(server) {
  return hasEntries(server.headerEnv) || hasEntries(server.envFrom);
}

/**
 * Render the env and headers maps a JSON harness receives, with references in
 * the harness's own syntax. Throws when the server carries references and the
 * harness has no documented syntax for them.
 */
export function renderCredentialMaps(server, provider) {
  const env = server.env ? { ...server.env } : undefined;
  const headers = server.headers ? { ...server.headers } : undefined;
  if (!hasReferences(server)) return { env, headers };

  const syntax = ENV_REFERENCE_SYNTAX[provider];
  if (!syntax) {
    throw new Error(
      `MCP server "${server.name}" uses environment references (header-env/env-from), ` +
      `but ${provider} documents no environment interpolation in its MCP config. ` +
      'Refusing to render it rather than writing the secret value or dropping the reference.',
    );
  }
  const reference = name => {
    validateEnvReferenceName(name);
    return syntax.replace('NAME', name);
  };
  const renderedEnv = { ...(env || {}) };
  for (const [key, name] of Object.entries(server.envFrom || {})) renderedEnv[key] = reference(name);
  const renderedHeaders = { ...(headers || {}) };
  for (const [header, name] of Object.entries(server.headerEnv || {})) renderedHeaders[header] = reference(name);
  return {
    env: Object.keys(renderedEnv).length > 0 ? renderedEnv : undefined,
    headers: Object.keys(renderedHeaders).length > 0 ? renderedHeaders : undefined,
  };
}

// A supported environment-reference value in any documented harness syntax:
// ${NAME} (claude/factory/omp/grok), ${env:NAME} (cursor/windsurf),
// {env:NAME} (opencode). Such a value names a variable; it is not a secret.
const CREDENTIAL_REFERENCE_VALUE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{env:[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/;

/** True when the value is a supported reference form rather than a literal secret. */
export function isCredentialReferenceValue(value) {
  return typeof value === 'string' && CREDENTIAL_REFERENCE_VALUE.test(value);
}

// A `-flag` or `--flag` whose name itself names a credential kind (one or two
// leading dashes, matching the full word - never a single-letter alias); the
// value, in the next argv element or after `=`, is almost always the literal
// secret. This is a name-shape heuristic: positional `KEY=value` forms (no
// leading dash at all) are not detected, short aliases (`-p secret`) are not
// detected because `p` never matches the full-word list below, and flags
// that name a secret location rather than a secret (`--token-file`,
// `--password-stdin`, `--secret-name`) are excluded. A finding additionally
// requires a non-empty, non-reference value: bare flags, empty values and
// `${VAR}`/`${env:VAR}`/`{env:VAR}` references are not findings.
const CREDENTIAL_ARG_NAME = /^(api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret|password|passwd|token)$/i;
const SECRET_LOCATION_SUFFIX = /-(file|files|path|dir|stdin|name|names)$/i;

/** The credential kind named by a `-flag` or `--flag`, or null when not credential-like. */
function credentialFlagName(flag) {
  if (typeof flag !== 'string') return null;
  const dashes = flag.startsWith('--') ? 2 : flag.startsWith('-') ? 1 : 0;
  if (!dashes) return null;
  const name = flag.slice(dashes);
  if (!CREDENTIAL_ARG_NAME.test(name)) return null;
  if (SECRET_LOCATION_SUFFIX.test(name)) return null;
  return name;
}

/**
 * Scan argv for credential-bearing flags. Each hit is the flag index and the
 * number of argv elements it occupies: 1 for `--flag=value`, 2 for
 * `--flag value`.
 */
function credentialArgHits(args) {
  const hits = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    const equals = arg.indexOf('=');
    if (equals >= 0) {
      if (!credentialFlagName(arg.slice(0, equals))) continue;
      const value = arg.slice(equals + 1);
      if (value !== '' && !isCredentialReferenceValue(value)) hits.push({ index, length: 1 });
      continue;
    }
    if (!credentialFlagName(arg)) continue;
    const next = args[index + 1];
    // The next token is this flag's value unless it is itself a long `--flag`
    // with no embedded value form - a bare flag, not this flag's value. A
    // value that happens to start with a single dash (`-SYNTHETIC`) is still
    // a value, not another flag, so it is not exempted here.
    const nextIsBareFlag = typeof next === 'string' && next.startsWith('--');
    if (typeof next === 'string' && next !== '' && !nextIsBareFlag && !isCredentialReferenceValue(next)) {
      hits.push({ index, length: 2 });
    }
  }
  return hits;
}

/** List the `args` entries that carry a literal credential value. */
export function credentialLikeArgs(args) {
  if (!Array.isArray(args)) return [];
  return credentialArgHits(args).map(({ index, length }) =>
    length === 1 ? args[index] : `${args[index]} ${args[index + 1]}`);
}

/** Copy argv with every detected literal credential value replaced by `***`. */
export function redactCredentialArgs(args) {
  if (!Array.isArray(args)) return args;
  const redacted = [...args];
  for (const { index, length } of credentialArgHits(args)) {
    if (length === 1) {
      const equals = String(args[index]).indexOf('=');
      redacted[index] = `${String(args[index]).slice(0, equals)}=***`;
    } else {
      redacted[index + 1] = '***';
    }
  }
  return redacted;
}

export function urlCarriesUserinfo(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    // Invalid hosts must not conceal userinfo from policy checks. Restrict
    // the fallback to the authority so an @ in a path is not a credential.
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url.trim())?.[1];
    return authority?.includes('@') ?? false;
  }
}

/**
 * List the fields of a server that the policy forbids.
 *
 *   literal     nothing is forbidden
 *   references  literal env/headers values, literal auth argument values, URL
 *               userinfo, and literal auth/oauth secrets are forbidden;
 *               header-env/env-from are allowed
 *   none        every credential-bearing field is forbidden, references included
 */
export function credentialPolicyViolations(server, policy) {
  if (policy === 'literal' || policy === undefined) return [];
  const violations = [];
  if (hasEntries(server.env)) violations.push('env');
  if (hasEntries(server.headers)) violations.push('headers');
  if (credentialLikeArgs(server.args).length > 0) violations.push('args');
  if (urlCarriesUserinfo(server.url)) violations.push('url userinfo');
  for (const field of ['auth', 'oauth']) {
    for (const key of ['tokenUrl', 'redirectUri', 'resource']) {
      if (urlCarriesUserinfo(server[field]?.[key])) violations.push(`${field}.${key} userinfo`);
    }
  }
  if (server.auth?.clientSecret) violations.push('auth.clientSecret');
  if (server.oauth?.clientSecret) violations.push('oauth.clientSecret');
  if (policy === 'none') {
    if (hasEntries(server.headerEnv)) violations.push('headerEnv');
    if (hasEntries(server.envFrom)) violations.push('envFrom');
    if (server.auth) violations.push('auth');
    if (server.oauth) violations.push('oauth');
  }
  return [...new Set(violations)];
}

/** Throw if any server violates the policy; names every offending server and field. */
export function assertCredentialPolicy(servers, policy) {
  if (!CREDENTIAL_POLICIES.includes(policy ?? 'literal')) {
    throw new Error(`Unknown MCP credential policy "${policy}". Use one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  }
  const offenders = servers
    .map(server => ({ name: server.name, fields: credentialPolicyViolations(server, policy) }))
    .filter(entry => entry.fields.length > 0);
  if (offenders.length === 0) return;
  const detail = offenders.map(entry => `${entry.name} (${entry.fields.join(', ')})`).join('; ');
  const remedy = policy === 'none'
    ? 'Credential policy "none" renders no credential-bearing field at all.'
    : 'Credential policy "references" renders only header-env/env-from references; move literal values into environment variables.';
  throw new Error(`Refusing to render MCP servers with credentials: ${detail}. ${remedy}`);
}

// Relaxations can be encountered repeatedly while loading layers and rendering.
const warnedRelaxations = new Set();

export function warnCredentialPolicyRelaxation(candidate, floor) {
  if (warnedRelaxations.has(candidate)) return;
  warnedRelaxations.add(candidate);
  console.warn(`Ignoring MCP credential policy "${candidate}": cannot relax credential policy floor "${floor}".`);
}

function validatePolicyValue(candidate) {
  if (!CREDENTIAL_POLICIES.includes(candidate)) {
    throw new Error(`Unknown MCP credential policy "${candidate}". Use one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  }
}

/**
 * Resolve a credential policy for one invocation.
 *
 * `registryPolicy` (the personal/stored policy), `env`
 * (AIWG_MCP_CREDENTIAL_POLICY) and `flag` compose as a default: the most
 * specific source wins outright, including a relaxation. `flag` overrides
 * `env`, which overrides `registryPolicy`, which overrides the built-in
 * `literal` default - a flag or the environment may freely relax or tighten
 * a personal stored policy.
 *
 * `floorPolicy`, when given, is an enforced policy from a lower (shared or
 * organisation) configuration layer - the strictest value declared in any
 * such layer. It cannot be relaxed by `registryPolicy`, `env` or `flag`,
 * only tightened further. An attempt to relax below it is ignored, with a
 * warning once per process per attempted value, and the floor is used
 * instead.
 */
export function resolveCredentialPolicy({ flag, registryPolicy, floorPolicy, env = process.env } = {}) {
  let policy = 'literal';
  // Whether any of registryPolicy/env/flag actually supplied a value, as
  // opposed to `policy` merely sitting at the built-in default. The default
  // landing below an enforced floor is ordinary inheritance, not a
  // relaxation attempt, and must not warn.
  let explicit = false;
  // An empty environment string is unset; empty layer/flag values are errors.
  const envPolicy = env.AIWG_MCP_CREDENTIAL_POLICY === '' ? undefined : env.AIWG_MCP_CREDENTIAL_POLICY;
  for (const candidate of [registryPolicy, envPolicy, flag]) {
    if (candidate === undefined) continue;
    validatePolicyValue(candidate);
    policy = candidate;
    explicit = true;
  }
  if (floorPolicy !== undefined) {
    validatePolicyValue(floorPolicy);
    if (CREDENTIAL_POLICIES.indexOf(policy) < CREDENTIAL_POLICIES.indexOf(floorPolicy)) {
      if (explicit) warnCredentialPolicyRelaxation(policy, floorPolicy);
      policy = floorPolicy;
    }
  }
  return policy;
}

/**
 * The stricter of two credential policies; `undefined` means no preference
 * and defers to the other side. Folds an organisation floor across several
 * lower configuration layers (each layer's own declared value is validated).
 */
export function stricterCredentialPolicy(a, b) {
  if (a !== undefined) validatePolicyValue(a);
  if (b !== undefined) validatePolicyValue(b);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return CREDENTIAL_POLICIES.indexOf(a) >= CREDENTIAL_POLICIES.indexOf(b) ? a : b;
}
