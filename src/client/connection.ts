// The live connection to the server, and reloading without losing your place.

import type { ServerMessage } from "../protocol.ts";
import { boot, storageKey } from "./store.ts";

/** A reload remembers the scroll position this long, so the page comes back where it was. */
const SCROLL_MEMORY_MS = 15_000;

export function reloadPreservingView(): void {
  try {
    sessionStorage.setItem(storageKey("scroll"), JSON.stringify({ y: window.scrollY, at: Date.now() }));
  } catch {
    // Best effort only.
  }
  location.reload();
}

export function restoreScroll(): void {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey("scroll")) ?? "null") as {
      y: number;
      at: number;
    } | null;
    sessionStorage.removeItem(storageKey("scroll"));
    if (saved && Date.now() - saved.at < SCROLL_MEMORY_MS) window.scrollTo(0, saved.y);
  } catch {
    // Nothing to restore.
  }
}

export interface ConnectionHandlers {
  onMessage(message: ServerMessage): void;
  onConnected?(): void;
  /** Called once the connection has failed a few times in a row. */
  onDisconnected?(): void;
}

/**
 * Keeps a WebSocket open to the server, reconnecting with backoff. Every (re)connect starts with a
 * `hello` carrying the full current state, so a page that missed messages converges.
 */
export function connect(handlers: ConnectionHandlers): void {
  let failures = 0;
  const open = () => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events/${boot.key}`,
    );
    socket.addEventListener("open", () => {
      failures = 0;
      handlers.onConnected?.();
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      handlers.onMessage(message);
    });
    socket.addEventListener("close", () => {
      failures += 1;
      if (failures >= 3) handlers.onDisconnected?.();
      setTimeout(open, Math.min(5000, 400 * failures));
    });
  };
  open();
}
