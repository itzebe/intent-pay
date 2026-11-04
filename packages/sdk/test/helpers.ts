/**
 * A scriptable `fetch` double.
 *
 * The SDK is exercised against real request/response objects — a real
 * `Response`, real headers, real JSON text — so the transport's parsing, retry
 * and error mapping run for real. Only the network is replaced.
 */

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type RouteHandler = (req: RecordedRequest, attempt: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function textResponse(text: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(text, { status: init.status ?? 200, headers: init.headers ?? {} });
}

/** The API's error envelope. */
export function errorResponse(code: string, message: string, status: number, extra: { detail?: string; requestId?: string } = {}): Response {
  return jsonResponse({ ok: false, error: { code, message, ...extra } }, { status });
}

export class MockFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, RouteHandler>();
  private readonly attempts = new Map<string, number>();
  private fallback: RouteHandler | null = null;

  /** Register a handler for `METHOD /path` (path is matched exactly). */
  on(method: string, path: string, handler: RouteHandler): this {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  onFallback(handler: RouteHandler): this {
    this.fallback = handler;
    return this;
  }

  get calls(): RecordedRequest[] {
    return this.requests;
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const parsed = new URL(url);
      const key = `${method} ${parsed.pathname}`;
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      const req: RecordedRequest = { url, method, headers, body };
      this.requests.push(req);

      const handler = this.routes.get(key) ?? this.fallback;
      if (!handler) return errorResponse("not_found", `No route registered for ${key}`, 404);
      return handler(req, attempt);
    }) as typeof fetch;
  }
}

/** A `fetch` that rejects, simulating a network failure. */
export function failingFetch(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

/** A `fetch` that never resolves until its AbortSignal fires (a timeout). */
export function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;
}
