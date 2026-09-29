// The pieces a route can use, and what a route is.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventHub } from "./events.ts";
import type { PollHub } from "./polls.ts";
import type { ReviewService } from "./review-service.ts";
import type { Session, SessionRegistry } from "./sessions.ts";

export interface App {
  sessions: SessionRegistry;
  reviews: ReviewService;
  polls: PollHub;
  events: EventHub;
  buildId: string;
  /** Starts watching a session's plan file so its pages update when the agent saves it. */
  watch(session: Session): void;
  planUrl(key: string): string;
  /** Stops the server after the current response. */
  shutdown(): void;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The route pattern's capture groups. */
  params: string[];
}

export interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /**
   * Who calls the route. Browser routes must carry our own Origin; agent routes are called by the
   * CLI, which sends none, so an Origin is accepted there only when it is ours.
   */
  caller: "agent" | "browser";
  handle(context: RouteContext): Promise<void> | void;
}
