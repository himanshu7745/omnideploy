/**
 * Secret detection, by file name and by content. Pure functions: callers decide what to do with a match.
 * Tuned to avoid false alarms: a missed secret is bad, but a check that always cries wolf gets ignored.
 */

/** Files that hold secrets by convention, in any language. They should never be committed or uploaded. */
const SECRET_FILE = new RegExp(
  '(^|/)(' +
    [
      '\\.env(\\..+)?', // .env, .env.local, .env.production (dotenv: Node, Python, PHP/Laravel, Ruby, Go, Rust)
      '.+\\.(pem|key|p12|pfx|jks|keystore|p8|ppk)', // private keys, certificates with keys, Java keystores
      'id_(rsa|dsa|ecdsa|ed25519)', // SSH private keys
      'credentials\\.json|client_secret[^/]*\\.json|service[-_]?account[^/]*\\.json', // Google/OAuth credential files
      'application-(local|secret|secrets|private)\\.(ya?ml|properties)', // Spring Boot local/secret profiles
      '\\.streamlit/secrets\\.toml', // Streamlit
      'local\\.settings\\.json', // Azure Functions
      '\\.netrc|\\.git-credentials|\\.htpasswd|\\.pgpass',
      '[^/]*\\.tfvars|[^/]*\\.tfstate(\\.backup)?', // Terraform
    ].join('|') +
    ')$',
);
/** Templates meant to be committed. */
const SECRET_FILE_OK = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/;

export function looksLikeSecret(path: string): boolean {
  return SECRET_FILE.test(path) && !SECRET_FILE_OK.test(path);
}

export interface SecretMatch {
  line: number;
  /** What was found, e.g. "AWS access key" or "password". */
  kind: string;
  /** The value with most characters hidden — safe to print. */
  preview: string;
}

/** Token formats that are secrets wherever they appear (code or config). */
const TOKENS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{16,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
];

/** user:password@host in a connection URL (postgres://, mongodb+srv://, jdbc:mysql://, amqp://, redis://, ...). */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.:-]*:\/\/([^\s/:@'"]+):([^\s/@'"]+)@[^\s'"]+/i;

/** `key: value` / `key=value` / `"key": "value"` in config files, where the key names a secret. */
const SECRET_KEY =
  /^\s*["']?([\w.\-[\]]*?(?:password|passwd|pwd|pass|secret|secret[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|token))["']?\s*[:=]\s*["']?([^"'\s#,}]+)/i;
/** Password=…; inside a connection string (.NET, ODBC, JDBC). */
const CONN_STRING_PASSWORD = /\b(?:password|pwd)\s*=\s*([^;"'\s&]+)/i;
/** <password>…</password> in XML config (e.g. Maven settings.xml). */
const XML_SECRET = /<((?:\w+[_-]?)?(?:password|passwd|secret|apiKey|api-key|token))>([^<\s]+)<\//i;
const TOKEN_ONLY_KEY = /token$/i;

/** Config-file extensions where `key: value` assignments are checked (code is only checked for token formats). */
const CONFIG_FILE = /(^|\/)(\.env(\..+)?|[^/]+\.(ya?ml|properties|toml|ini|cfg|conf|json|xml|env)|\.npmrc|\.pypirc)$/i;

/** Values that are clearly not real secrets: references to env vars, templates, placeholders. */
function isPlaceholder(value: string): boolean {
  return (
    /^(\$\{|\$\(|\$[A-Z_]|#\{|\{\{|%\(|%[A-Z_]+%|<|\[|ENV\[|@)/.test(value) ||
    /getenv|process\.env|os\.environ|System\.getenv|Environment\./.test(value) ||
    /^(changeme|change[-_]?me|changeit|password|passwd|secret|example|sample|dummy|placeholder|test|testing|none|null|nil|undefined|true|false|yes|no|on|off|empty|todo|tbd|redacted|replace[-_]?me|postgres|root|admin|guest|pass|your[-_].*|x+|\*+|\.+|-+)$/i.test(value) ||
    /^\d+$/.test(value) || // numbers: ports, timeouts, lengths
    /^(.)\1+$/.test(value) // xxxxxx, ******
  );
}

export function maskSecret(value: string): string {
  return value.length < 8 ? `${value[0] ?? ''}•••` : `${value.slice(0, 2)}•••${value.slice(-2)}`;
}

/**
 * Finds hard-coded secrets in a file's text. `path` decides which rules apply:
 * token formats everywhere, `password: …`-style assignments only in config files.
 */
export function findSecretsInText(path: string, text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const isConfig = CONFIG_FILE.test(path);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.slice(0, 2000);
    // Token formats are real wherever they are, even in a comment; assignments in comments are usually examples.
    const commented = /^\s*(#|\/\/|;|<!--|\*)/.test(line);

    const token = TOKENS.find(([, re]) => re.test(line));
    if (token) {
      const value = line.match(token[1])![0];
      matches.push({ line: i + 1, kind: token[0], preview: token[0] === 'private key' ? 'BEGIN PRIVATE KEY' : maskSecret(value) });
      continue;
    }

    if (commented) continue;
    const url = line.match(URL_CREDENTIALS);
    if (url && !isPlaceholder(url[2]!) && !/^(localhost|127\.|0\.0\.0\.0)/.test(line.split('@')[1] ?? '')) {
      matches.push({ line: i + 1, kind: 'password in a connection URL', preview: maskSecret(url[2]!) });
      continue;
    }

    if (!isConfig) continue;
    const kv = line.match(SECRET_KEY) ?? line.match(XML_SECRET);
    if (!kv) {
      const conn = line.match(CONN_STRING_PASSWORD);
      if (conn && !isPlaceholder(conn[1]!) && conn[1]!.length >= 4) matches.push({ line: i + 1, kind: 'password in a connection string', preview: maskSecret(conn[1]!) });
      continue;
    }
    const [, key, value] = kv as unknown as [string, string, string];
    if (isPlaceholder(value)) continue;
    // Keys ending in "token" are often settings (csrf-token-name: X-CSRF-TOKEN); only flag random-looking values.
    if (TOKEN_ONLY_KEY.test(key) && !(value.length >= 16 && /\d/.test(value))) continue;
    if (value.length < 4) continue;
    matches.push({ line: i + 1, kind: key.replace(/^.*[.[]/, '').replace(/\]$/, ''), preview: maskSecret(value) });
  }
  return matches;
}
