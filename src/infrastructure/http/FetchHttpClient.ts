import { ProviderApiError, type HttpClientPort, type HttpRequest, type HttpResponse } from '../../domain/index.js';

export interface FetchHttpClientOptions {
  retries?: number;
  /** Base delay for exponential backoff (ms). */
  backoffMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class FetchHttpClient implements HttpClientPort {
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: FetchHttpClientOptions = {}) {
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.userAgent = opts.userAgent ?? 'omnideploy-cli';
    this.fetchImpl = opts.fetchImpl;
  }

  async request<T>(req: HttpRequest, opts: { provider?: string; allowStatus?: number[] } = {}): Promise<HttpResponse<T>> {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: 'application/json', ...req.headers };
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.body !== undefined) {
      body = req.body as BodyInit;
    }

    const provider = opts.provider ?? url.hostname;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        // Resolve fetch per call so test interceptors and polyfills installed later are honoured.
        res = await (this.fetchImpl ?? globalThis.fetch)(url, { method: req.method ?? 'GET', headers, body });
      } catch (e) {
        lastError = e;
        continue; // network error: retry
      }

      const data = await parseBody(res);
      if (res.ok || opts.allowStatus?.includes(res.status)) {
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data: data as T };
      }
      lastError = new ProviderApiError(provider, extractMessage(data, res.statusText), res.status, hintFor(res.status));
      if (!RETRYABLE.has(res.status)) break;
    }
    if (lastError instanceof ProviderApiError) throw lastError;
    throw new ProviderApiError(provider, `request to ${url.host} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, undefined, 'Check your network connection.');
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string') return data.slice(0, 300) || fallback;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const err = d.error;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, string>).message!;
    }
    if (typeof err === 'string') return err;
    if (typeof d.message === 'string') return d.message;
    if (Array.isArray(d.errors) && d.errors.length) return JSON.stringify(d.errors).slice(0, 300);
  }
  return fallback || 'unknown error';
}

function hintFor(status: number): string | undefined {
  if (status === 401 || status === 403) return 'Your token may be invalid or expired. Run `omnideploy login <provider>` again.';
  if (status === 404) return 'The resource was not found — check the IDs in omnideploy.json.';
  if (status === 429) return 'Rate limited by the provider. Wait a moment and retry.';
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
