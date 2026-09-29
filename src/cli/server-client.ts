// How the CLI reaches the review server, starting it (or replacing an outdated one) when needed.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { APP, buildId, PACKAGE_ROOT, serverPort, stateDir } from "../paths.ts";
import { CliError } from "./args.ts";

const BIN = join(PACKAGE_ROOT, "bin", "coplan.js");

export const baseUrl = () => `http://127.0.0.1:${serverPort()}`;

export interface Response<T> {
  status: number;
  json: T;
}

/** One HTTP request to the server. `timeoutMs` 0 waits forever, which is what a poll wants. */
export function request<T = Record<string, unknown>>(
  method: "GET" | "POST",
  url: string,
  { body, timeoutMs = 0 }: { body?: unknown; timeoutMs?: number } = {},
): Promise<Response<T>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      { method, headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: parseBody(Buffer.concat(chunks).toString("utf8").trim()) as T }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text };
  }
}

export interface Health {
  app?: string;
  build?: string;
}

/** What is listening on the port: a server's health, `{}` for something else, null for nothing. */
export async function health(): Promise<Health | null> {
  try {
    const { status, json } = await request<Health>("GET", `${baseUrl()}/health`, { timeoutMs: 800 });
    return status === 200 ? json : {};
  } catch {
    return null;
  }
}

async function waitFor<T>(check: () => Promise<T | null | false>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Makes sure a server running this exact build is listening, replacing an older one. */
export async function ensureServer(): Promise<string> {
  const build = buildId();
  const current = await health();
  if (current?.app === APP && current.build === build) return baseUrl();
  if (current && current.app !== APP) {
    throw new CliError(`port ${serverPort()} is in use by something that is not Coplan`, [
      "Set COPLAN_PORT to a free port and re-run",
    ]);
  }
  if (current?.app === APP) {
    await request("POST", `${baseUrl()}/shutdown`, { timeoutMs: 2000 }).catch(() => {});
    await waitFor(async () => !(await health()), 5000);
  }

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const log = openSync(join(dir, "server.log"), "a");
  spawn(process.execPath, [BIN, "server"], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  const started = await waitFor(async () => {
    const h = await health();
    return h?.app === APP && h.build === build ? h : null;
  }, 8000);
  if (!started) throw new CliError("the Coplan server did not start", [`Check ${join(dir, "server.log")}`]);
  return baseUrl();
}
