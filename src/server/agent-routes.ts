// Routes the CLI calls on the agent's behalf.

import { APP, VERSION } from "../paths.ts";
import type { App, Route } from "./app.ts";
import { HttpError, readJson, sendJson } from "./http.ts";
import type { Session } from "./sessions.ts";

const MAX_WAIT_MS = 60 * 60_000;

export function agentRoutes(app: App): Route[] {
  /** The session for the plan file a request names, or 404. */
  const sessionFor = (file: unknown): Session => {
    const session = app.sessions.forFile(String(file ?? ""));
    if (!session) throw new HttpError(404, { status: "missing" });
    return session;
  };

  return [
    {
      method: "GET",
      pattern: /^\/health$/,
      caller: "agent",
      handle: ({ res }) =>
        sendJson(res, 200, { ok: true, app: APP, version: VERSION, build: app.buildId, pid: process.pid }),
    },
    {
      method: "POST",
      pattern: /^\/shutdown$/,
      caller: "agent",
      handle: ({ res }) => {
        sendJson(res, 200, { ok: true });
        app.shutdown();
      },
    },
    {
      // `coplan open`: start or resume a review.
      method: "POST",
      pattern: /^\/api\/sessions$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const body = await readJson(req);
        const opened = await app.sessions.open(String(body.file ?? ""), { reopen: Boolean(body.reopen) });
        if ("userEnded" in opened) {
          return sendJson(res, 200, { status: "user-ended", key: opened.key, url: app.planUrl(opened.key) });
        }
        const { session } = opened;
        app.watch(session);
        sendJson(res, 200, {
          status: session.status,
          key: session.key,
          url: app.planUrl(session.key),
          clients: app.events.clientCount(session.key),
        });
      },
    },
    {
      // `coplan poll`: wait for feedback, for up to `wait_ms`. Answered immediately if some is
      // queued. A POST because waiting replaces the agent's current poll, and only GET routes skip
      // the Origin check.
      method: "POST",
      pattern: /^\/api\/poll$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const body = await readJson(req);
        const waitMs = body.wait_ms;
        if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > MAX_WAIT_MS) {
          throw new HttpError(400, { error: "wait_ms must be a whole number of milliseconds, up to an hour" });
        }
        const session = sessionFor(body.file);
        await app.polls.wait(session.key, res, () => app.reviews.pollResult(session), waitMs);
      },
    },
    {
      // Sent after the CLI has read a poll response in full; only then does feedback leave the queue.
      method: "POST",
      pattern: /^\/api\/ack$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const body = await readJson(req);
        const session = sessionFor(body.file);
        const ids = Array.isArray(body.batch_ids) ? body.batch_ids.map(String) : [];
        sendJson(res, 200, { ok: true, remaining: await app.reviews.acknowledge(session, ids) });
      },
    },
    {
      // `coplan poll --reply`: the agent's message to the reviewer.
      method: "POST",
      pattern: /^\/api\/reply$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const body = await readJson(req);
        const session = sessionFor(body.file);
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 20000) : "";
        if (!text) throw new HttpError(400, { error: "reply text is empty" });
        await app.reviews.reply(session, text);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      // `coplan end`
      method: "POST",
      pattern: /^\/api\/end$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const session = sessionFor((await readJson(req)).file);
        await app.reviews.end(session, "agent");
        sendJson(res, 200, { ok: true, status: "ended" });
      },
    },
  ];
}
