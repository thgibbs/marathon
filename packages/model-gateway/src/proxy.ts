import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Host-side key-injecting model proxy (design §12.6 Pattern 1; K7, claude-code-impl.md §4.1).
 *
 * The Claude Code CLI calls the Anthropic API itself from *inside* the sandbox, so the
 * classic Pattern-1 cost — "the key must enter the container" — is paid off here: the
 * container gets `ANTHROPIC_BASE_URL=<this proxy>` and a placeholder key, and the proxy
 * (host-side, per task) replaces the auth header with the real per-tenant key, forwards
 * ONLY Anthropic API paths, refuses everything else, and meters usage as a backstop
 * independent of what the agent self-reports. No key material ever enters the image, the
 * container env, or the workspace.
 */

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** Anthropic API paths the proxy forwards; everything else is refused (§4.1). */
const ALLOWED_PATHS: RegExp[] = [
  /^\/v1\/messages\/?(\?.*)?$/,
  /^\/v1\/messages\/count_tokens\/?(\?.*)?$/,
  /^\/v1\/models(\/[^/]+)?\/?(\?.*)?$/,
];

export function isAllowedAnthropicPath(path: string): boolean {
  return ALLOWED_PATHS.some((re) => re.test(path));
}

/**
 * Strip any client-supplied auth and inject the real per-tenant key. Header
 * names are lowercased by Node; we drop `authorization`/`x-api-key`, set the
 * real `x-api-key`, and drop hop-by-hop/host headers so the upstream sees a
 * clean request. Pure + exported so the injection can be asserted without a
 * live socket (K7: "assert no key in the container env" — the key only exists here).
 */
export function injectAuthHeaders(
  headers: Record<string, string | string[] | undefined>,
  apiKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === "authorization" || key === "x-api-key" || key === "host" || key === "connection" || key === "content-length") {
      continue;
    }
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  out["x-api-key"] = apiKey;
  return out;
}

export interface ProxyUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Backstop metering: pull usage out of an Anthropic (non-streamed) message response. */
export function parseUsageFromAnthropicResponse(body: string): ProxyUsage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const j = json as Record<string, unknown>;
  const usage = j.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    model: typeof j.model === "string" ? j.model : undefined,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
  };
}

export interface AnthropicKeyProxyOptions {
  /** The real per-tenant Anthropic key, resolved host-side. Never leaves the host. */
  apiKey: string;
  /** Upstream base (default `https://api.anthropic.com`). */
  upstreamBase?: string;
  /** Backstop metering sink (§4.1) — called per forwarded non-streamed response. */
  onUsage?: (usage: ProxyUsage) => void;
}

/**
 * A minimal per-task HTTP proxy. `listen()` binds an ephemeral port and returns
 * the base URL to hand the container as `ANTHROPIC_BASE_URL`; `close()` tears it
 * down with the task. Non-allowlisted paths get a 403 without ever reaching upstream.
 */
export class AnthropicKeyProxy {
  private server?: Server;
  constructor(private readonly opts: AnthropicKeyProxyOptions) {}

  async listen(host = "127.0.0.1", port = 0): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("proxy failed to bind a TCP port");
    return `http://${host}:${addr.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? "/";
    if (!isAllowedAnthropicPath(path)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "forbidden", message: `path not allowed by Marathon proxy: ${path}` } }));
      return;
    }
    const upstream = new URL(path, this.opts.upstreamBase ?? DEFAULT_UPSTREAM);
    const headers = injectAuthHeaders(req.headers, this.opts.apiKey);
    const chunks: Buffer[] = [];
    const upstreamReq = httpsRequest(
      upstream,
      { method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.on("data", (d: Buffer) => {
          chunks.push(d);
          res.write(d);
        });
        upstreamRes.on("end", () => {
          res.end();
          if (this.opts.onUsage) {
            const usage = parseUsageFromAnthropicResponse(Buffer.concat(chunks).toString("utf8"));
            if (usage) this.opts.onUsage(usage);
          }
        });
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "bad_gateway", message: String(err) } }));
    });
    req.pipe(upstreamReq);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
