// Request and response plumbing shared by every route.

import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

/** Served pages may only talk to this server and cannot be framed or submit forms elsewhere. */
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** An error a route throws to answer with a status and a JSON body. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": PAGE_CSP,
  });
  res.end(page);
}

export function sendText(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

/** The request body as JSON: `{}` when empty, 400 when malformed, 413 past 1 MB. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { error: "request body too large" });
    chunks.push(chunk);
  }
  if (!size) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { error: "request body is not JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, { error: "request body must be an object" });
  return body as Record<string, unknown>;
}

// --- who may call what ---

/**
 * Every request must name this server by a loopback host, which defeats DNS rebinding: a page on
 * another site that resolves its own name to 127.0.0.1 still sends its own Host header.
 */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = String(req.headers.host ?? "");
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * Browser routes must come from our own pages. Agent routes are called by the CLI with no Origin
 * at all, so any Origin present there must still be ours.
 */
export function originAllowed(req: IncomingMessage, { required }: { required: boolean }): boolean {
  const origin = req.headers.origin;
  if (!origin) return !required;
  return origin === `http://${req.headers.host}`;
}
