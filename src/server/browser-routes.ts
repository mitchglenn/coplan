// Routes the review page calls: the page itself, its client code, and the reviewer's actions.

import { readFile } from "node:fs/promises";
import { renderLoaded } from "../engine.ts";
import { skippableRecords } from "../plan/metrics.ts";
import type { ApprovalPhase, Bootstrap, NextStep } from "../protocol.ts";
import { browserCode } from "../render/browser-code.ts";
import type { App, Route, RouteContext } from "./app.ts";
import { normalizeDecisionAnswers, normalizeItems } from "./feedback.ts";
import { HttpError, readJson, sendHtml, sendJson, sendText } from "./http.ts";
import { invalidPlanPage, notFoundPage } from "./pages.ts";
import { planSignature, renderHistory } from "./review-service.ts";
import type { Session } from "./sessions.ts";

const KEY = "([0-9a-f]{16})";

export function browserRoutes(app: App): Route[] {
  /** The open session a reviewer action targets. Actions on an ended review are refused. */
  const openSession = (key: string | undefined): Session => {
    const session = app.sessions.get(key ?? "");
    if (!session) throw new HttpError(404, { error: "session not found" });
    if (session.status === "ended") throw new HttpError(409, { error: "session ended", ended_by: session.ended_by });
    return session;
  };

  /** The session's plan, which must validate for the reviewer to act on it. */
  const validPlan = async (session: Session) => {
    const loaded = await app.reviews.load(session);
    if (!loaded.ok) throw new HttpError(409, { error: "the plan on disk has validation errors" });
    return loaded;
  };

  const action = (
    name: string,
    handle: (session: Session, body: Record<string, unknown>, context: RouteContext) => Promise<void>,
  ): Route => ({
    method: "POST",
    pattern: new RegExp(`^/api/${KEY}/${name}$`),
    caller: "browser",
    handle: async (context) => {
      const session = openSession(context.params[0]);
      await handle(session, await readJson(context.req), context);
    },
  });

  return [
    {
      method: "GET",
      pattern: new RegExp(`^/plan/${KEY}$`),
      caller: "browser",
      handle: async ({ res, params }) => {
        const session = app.sessions.get(params[0] ?? "");
        if (!session) return sendHtml(res, 404, notFoundPage());
        app.watch(session);
        const loaded = await app.reviews.load(session);
        const review = loaded.review;
        const bootstrap: Bootstrap = {
          key: session.key,
          ended: session.status === "ended",
          ended_by: session.ended_by,
          presence: app.polls.presence(session.key),
          history: renderHistory(review?.history ?? []),
          signature: planSignature(loaded),
        };
        if (!loaded.ok)
          return sendHtml(res, 200, invalidPlanPage(session.file, loaded.errors, { ...bootstrap, invalid: true }));
        sendHtml(
          res,
          200,
          renderLoaded(loaded, session.file, {
            ...bootstrap,
            stage: loaded.stage,
            questions: loaded.plan.questions.map((q) => q.id),
            decisions: loaded.plan.decisions.map((d) => d.id),
            answers: loaded.review.decisions?.answers ?? {},
          }),
        );
      },
    },
    {
      // The review client, served only with a page under review; plan.html on disk never loads it.
      method: "GET",
      pattern: /^\/client\/([a-z-]+)\.(js|ts|css)$/,
      caller: "browser",
      handle: async ({ res, params: [name, extension] }) => {
        if (extension === "css") {
          return sendText(
            res,
            "text/css; charset=utf-8",
            await readFile(new URL(`../client/${name}.css`, import.meta.url), "utf8"),
          );
        }
        sendText(res, "text/javascript; charset=utf-8", await browserCode(`client/${name}`));
      },
    },

    action("feedback", async (session, body, { res }) => {
      const loaded = await app.reviews.load(session);
      const items = normalizeItems(body.items, loaded.ok ? loaded.plan : null);
      if (!items) throw new HttpError(400, { error: "feedback batch is empty or malformed" });
      const listening = await app.reviews.deliver(session, items, { role: "reviewer", kind: "feedback", items });
      sendJson(res, 200, { ok: true, delivered_to_listener: listening });
    }),

    // A skip marks the plan, not the conversation: it is saved at once, shown on the plan, and
    // reported to the agent as plan state on every poll rather than queued as feedback.
    action("skip", async (session, body, { res }) => {
      const loaded = await validPlan(session);
      const record = (loaded.plan.tabs ?? []).flatMap(skippableRecords).find((r) => r.id === body.id);
      if (!record || typeof body.skip !== "boolean") {
        throw new HttpError(400, { error: "only edge cases, security risks and gaps can be skipped" });
      }
      sendJson(res, 200, { ok: true, skips: await app.reviews.setSkip(session, record.id, body.skip) });
    }),

    action("decisions", async (session, body, { res }) => {
      const loaded = await validPlan(session);
      if (loaded.stage.stage !== "decisions") {
        throw new HttpError(409, { error: "the key decisions were already submitted", reload: true });
      }
      if (body.hash !== loaded.stage.decisionsHash) {
        throw new HttpError(409, {
          error: "the decisions changed since this page loaded; review them again",
          reload: true,
        });
      }
      const result = normalizeDecisionAnswers(body.answers, loaded.plan.decisions);
      const extra = Array.isArray(body.items) && body.items.length ? normalizeItems(body.items, loaded.plan) : [];
      if (!result || !extra) throw new HttpError(400, { error: "decision answers are malformed" });
      await app.reviews.recordDecisions(session, loaded.stage.decisionsHash, result.answers);
      await app.reviews.deliver(session, [result.item, ...extra], {
        role: "reviewer",
        kind: "decisions",
        answered: result.item.answered.length,
        total: loaded.plan.decisions.length,
        items: extra,
      });
      const after = await app.reviews.rewriteHtml(session);
      app.reviews.broadcast(session, { type: "reload" });
      sendJson(res, 200, { ok: true, stage: after.ok ? after.stage.stage : null });
    }),

    action("approve", async (session, body, { res }) => {
      const loaded = await validPlan(session);
      const phase = body.phase as ApprovalPhase;
      // Approving the plan also says what comes next: slices to review, or building straight away.
      const next = phase === "plan" ? ((body.next ?? "slices") as NextStep) : null;
      if (phase === "plan" && next !== "slices" && next !== "build") {
        throw new HttpError(400, { error: 'next must be "slices" or "build"' });
      }
      const expected = phase === "plan" ? loaded.stage.planHash : phase === "slices" ? loaded.stage.slicesHash : null;
      if (!expected || loaded.stage.phase !== phase) {
        throw new HttpError(409, {
          error: `nothing to approve for "${String(phase)}" at stage ${loaded.stage.stage}`,
          reload: true,
        });
      }
      // The reviewer approves exactly what they saw.
      if (body.hash !== expected) {
        throw new HttpError(409, {
          error: "the plan changed since this page loaded; review the new version",
          reload: true,
        });
      }
      if (loaded.plan.questions.length) {
        throw new HttpError(409, {
          error: "open questions remain; answer them and let the agent fold the answers in first",
        });
      }
      await app.reviews.recordApproval(session, phase, expected, next);
      await app.reviews.deliver(session, [{ kind: "approval", phase, hash: expected, ...(next ? { next } : {}) }], {
        role: "reviewer",
        kind: "approval",
        phase,
        ...(next ? { next } : {}),
      });
      const after = await app.reviews.rewriteHtml(session);
      // Nothing is left to review once the slices are approved, or the plan is approved to build now.
      if (phase === "slices" || next === "build") await app.reviews.end(session, "approval");
      app.reviews.broadcast(session, { type: "reload" });
      sendJson(res, 200, { ok: true, stage: after.ok ? after.stage.stage : null });
    }),

    action("end", async (session, _body, { res }) => {
      await app.reviews.end(session, "user");
      sendJson(res, 200, { ok: true });
    }),
  ];
}
