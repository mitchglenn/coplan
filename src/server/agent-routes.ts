// Routes the CLI calls on the agent's behalf.

import { loadPlan } from "../engine.ts";
import { TaskError } from "../plan/build.ts";
import { APP, VERSION } from "../paths.ts";
import type { TaskResponse, TaskUpdate } from "../protocol.ts";
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

  /** A session for a plan the registry does not know, allowed only once its slices are approved. */
  const registerApproved = async (file: string): Promise<Session> => {
    const loaded = await loadPlan(file);
    if (!loaded.ok || !loaded.stage.slicesApproved) {
      throw new TaskError(`${file} has no review with approved slices; open it with \`coplan open\` first`);
    }
    return app.sessions.forApprovedPlan(file);
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
      // `coplan task`: the agent reports a step of building the approved slices.
      method: "POST",
      pattern: /^\/api\/task$/,
      caller: "agent",
      handle: async ({ req, res }) => {
        const body = await readJson(req);
        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (!task) throw new HttpError(400, { ok: false, error: "task is required" });
        const update = taskUpdate(body);
        const file = String(body.file ?? "");
        try {
          const session = app.sessions.forFile(file) ?? (await registerApproved(file));
          app.watch(session);
          const result = await app.reviews.recordTask(session, task, update);
          sendJson(res, 200, { ok: true, task, ...result } satisfies TaskResponse);
        } catch (error) {
          if (!(error instanceof TaskError)) throw error;
          sendJson(res, 409, { ok: false, error: error.message } satisfies TaskResponse);
        }
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

/** The report a `coplan task` request carries, or a 400 when it is malformed. */
function taskUpdate(body: Record<string, unknown>): TaskUpdate {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  switch (body.action) {
    case "start":
      return { action: "start" };
    case "built":
      return { action: "built" };
    case "commit": {
      const sha = text(body.sha);
      if (!sha) throw new HttpError(400, { ok: false, error: "commit needs a sha" });
      return { action: "commit", sha, remove: body.remove === true, pr: text(body.pr) };
    }
    case "link":
      return { action: "link", pr: text(body.pr), jira: text(body.jira) };
    default:
      throw new HttpError(400, { ok: false, error: 'action must be "start", "built", "commit" or "link"' });
  }
}
