export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Objects are sent as JSON; Uint8Array as raw bytes. */
  json?: unknown;
  body?: Uint8Array | string;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

export interface HttpClientPort {
  /** Throws ProviderApiError for non-2xx responses unless `allowStatus` includes the status. */
  request<T = unknown>(req: HttpRequest, opts?: { provider?: string; allowStatus?: number[] }): Promise<HttpResponse<T>>;
}
