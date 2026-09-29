// The review server: one background process serves every plan on the machine, on loopback only.
// This file wires the pieces together and routes requests; each piece owns one concern.
//
//   SessionRegistry  which plans have a review, persisted across restarts
//   PollHub          the agent's waiting long polls, and presence
//   EventHub         live updates to open pages over WebSocket
//   PlanWatcher      re-rendering when the agent saves a plan
//   ReviewService    the review operations the routes call

import { mkdir } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { ReviewStore } from "../review-store.ts";
import { agentRoutes } from "./agent-routes.ts";
import type { App, Route } from "./app.ts";
import { browserRoutes } from "./browser-routes.ts";
import { EventHub } from "./events.ts";
import { hostAllowed, HttpError, originAllowed, sendJson } from "./http.ts";
import { PollHub } from "./polls.ts";
import { ReviewService } from "./review-service.ts";
import { SessionRegistry } from "./sessions.ts";
import { PlanWatcher } from "./watcher.ts";

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  stateDir: string;
  /** Reported by /health, so the CLI can replace a server running older code. */
  buildId: string;
  /** Shut down after this long with no agent waiting, no page open and no requests. 0 never. */
  idleMs?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
  /** Called after the server shuts itself down: on /shutdown, or when idle. */
  onShutdown(callback: () => void): void;
}

export async function startServer({
  port,
  host = "127.0.0.1",
  stateDir,
  buildId,
  idleMs = 30 * 60_000,
  log = () => {},
}: ServerOptions): Promise<RunningServer> {
  await mkdir(stateDir, { recursive: true });
  const sessions = await SessionRegistry.load(stateDir);
  const events = new EventHub(log);
  const polls = new PollHub((key) => reviews.broadcastPresence(key));
  const reviews = new ReviewService({ store: new ReviewStore(), sessions, polls, events });
  const watcher = new PlanWatcher(log);
  let actualPort = port;
  let lastActivity = Date.now();
  let onShutdown = () => {};

  const app: App = {
    sessions,
    reviews,
    polls,
    events,
    buildId,
    watch: (session) => watcher.watch(session.file, () => reviews.planChanged(session)),
    planUrl: (key) => `http://127.0.0.1:${actualPort}/plan/${key}`,
    shutdown: () => setImmediate(() => void close().then(() => onShutdown())),
  };
  const routes = [...agentRoutes(app), ...browserRoutes(app)];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    lastActivity = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostAllowed(req, actualPort)) return sendJson(res, 403, { error: "host not allowed" });
    const found = findRoute(routes, req.method ?? "", url.pathname);
    if (!found) return sendJson(res, 404, { error: "not found" });
    const { route, params } = found;
    // A page on another site can send a GET with no Origin at all (an image), so GET routes change
    // nothing; every other request carries one, and it must be ours.
    if (route.method !== "GET" && !originAllowed(req, { required: route.caller === "browser" })) {
      return sendJson(res, 403, { error: "cross-origin request rejected" });
    }
    await route.handle({ req, res, url, params });
  };

  const server = http.createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    handle(req, res).catch((error: Error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.status, error.body);
        return;
      }
      log(`${req.method} ${req.url}: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  server.requestTimeout = 0; // polls are long-lived by design
  server.headersTimeout = 60_000;

  server.on("upgrade", (req, socket, head) => {
    const key = /^\/events\/([0-9a-f]{16})$/.exec(req.url ?? "")?.[1];
    const session = key ? sessions.get(key) : undefined;
    if (!session || !hostAllowed(req, actualPort) || !originAllowed(req, { required: true })) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    lastActivity = Date.now();
    events.accept(req, socket, head, session.key, () => reviews.hello(session));
  });

  const idleTimer =
    idleMs > 0
      ? setInterval(
          () => {
            const busy = polls.anyWaiting() || events.anyConnected();
            if (!busy && Date.now() - lastActivity > idleMs) {
              log("idle; shutting down");
              void close().then(() => onShutdown());
            }
          },
          Math.min(60_000, idleMs),
        )
      : null;
  idleTimer?.unref();

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise((resolve) => {
      if (idleTimer) clearInterval(idleTimer);
      watcher.closeAll();
      polls.closeAll();
      events.closeAll();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : port;
  log(`listening on http://${host}:${actualPort}`);

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close,
    onShutdown(callback) {
      onShutdown = callback;
    },
  };
}

function findRoute(routes: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}
