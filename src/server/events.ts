// Live updates to open review pages over WebSocket. Traffic is one-way, server to page; the page
// acts through HTTP routes. Every connection starts with a `hello` that carries everything a page
// that was disconnected may have missed, so a reconnect always converges on the current state.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "../protocol.ts";

/** A connection that misses a ping for this long is dropped. */
const PING_MS = 30_000;

export class EventHub {
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  readonly #clients = new Map<string, Set<WebSocket>>();
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  /** Accepts an upgrade for a session's page and sends it `hello` once connected. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, key: string, hello: () => Promise<ServerMessage>): void {
    this.#server.handleUpgrade(req, socket, head, (ws) => {
      this.#add(key, ws);
      hello()
        .then((message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message)))
        .catch((error: Error) => this.#log(`hello for ${key}: ${error.message}`));
    });
  }

  broadcast(key: string, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.#clients.get(key) ?? []) if (client.readyState === client.OPEN) client.send(payload);
  }

  clientCount(key: string): number {
    return this.#clients.get(key)?.size ?? 0;
  }

  anyConnected(): boolean {
    return [...this.#clients.values()].some((clients) => clients.size > 0);
  }

  closeAll(): void {
    for (const clients of this.#clients.values()) for (const client of clients) client.terminate();
    this.#server.close();
  }

  #add(key: string, ws: WebSocket): void {
    let clients = this.#clients.get(key);
    if (!clients) {
      clients = new Set();
      this.#clients.set(key, clients);
    }
    clients.add(ws);
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on("close", () => {
      clearInterval(ping);
      clients.delete(ws);
    });
  }
}
