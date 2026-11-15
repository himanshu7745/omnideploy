/**
 * Parsing of .env files and detection of the environment variables an app expects. Pure functions.
 */

/**
 * Parses dotenv syntax: `KEY=value`, `export KEY=value`, single/double quotes, `\n` escapes in double quotes,
 * multi-line double-quoted values, `# comments` (inline only after whitespace in unquoted values).
 */
export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let raw = m[2]!;
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Multi-line quoted value: keep reading until the closing quote.
      while (!closesQuote(raw, quote) && i + 1 < lines.length) raw += '\n' + lines[++i];
      const end = raw.lastIndexOf(quote);
      let value = end > 0 ? raw.slice(1, end) : raw.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      vars[key] = value;
    } else {
      vars[key] = raw.replace(/\s+#.*$/, '').trim();
    }
  }
  return vars;
}

function closesQuote(raw: string, quote: string): boolean {
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] === quote) return raw[i - 1] !== '\\' || quote !== '"';
  }
  return false;
}

/** Serializes one variable for a .env file, quoting when needed. */
export function formatDotenvLine(key: string, value: string): string {
  if (value === '' || /^[\w@%+=:,./~-]*$/.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * `${VAR}` placeholders without a default in Spring Boot / Quarkus / Micronaut config — the app fails to start
 * if VAR isn't set. Only UPPER_CASE names count: `${server.port}` refers to another property, not the environment.
 */
export function requiredPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[^}]*)?\}/g)) {
    if (m[2] === undefined) found.add(m[1]!);
  }
  return [...found];
}

/** Values that point at the developer's machine — they can't work on a hosting platform. */
export function pointsToLocalhost(value: string): boolean {
  return /(^|[/@:=\s])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/\s]|$)/i.test(value);
}

/** Variables the platform sets itself; a value from a file would break routing. */
export const PLATFORM_MANAGED_VARS = new Set(['PORT']);
