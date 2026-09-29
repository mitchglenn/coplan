import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { canonicalPlanPath, sessionKey } from "../src/paths.ts";
import { startServer, type RunningServer } from "../src/server/index.ts";
import type { FeedbackItem } from "../src/protocol.ts";
import { decisionsOnlyPlan, examplePlan, SLICES, submittedReview, validPlan } from "./helpers.ts";

let dir: string;
let server: RunningServer;
let file: string;
let key: string;

interface Reply {
  status: number;
  text: string;
  // Responses are checked field by field against the protocol; the tests read them loosely.
  json: any;
}

function request(
  method: "GET" | "POST",
  path: string,
  { body, origin }: { body?: unknown; origin?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string | number> = {};
    if (payload) Object.assign(headers, { "content-type": "application/json", "content-length": payload.length });
    if (origin) headers.origin = origin;
    const req = http.request(`${server.url}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve({ status: res.statusCode ?? 0, text, json: parseJson(text) });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const own = () => `http://127.0.0.1:${server.port}`;
const browser = (path: string, body: unknown) => request("POST", path, { body, origin: own() });
const poll = (waitMs = 60_000) => request("POST", "/api/poll", { body: { file, wait_ms: waitMs } });
const ack = (batchIds: string[]) => request("POST", "/api/ack", { body: { file, batch_ids: batchIds } });
const writePlan = (plan: unknown) => writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
const recordedSkips = async () => Object.keys(JSON.parse(await readFile(join(dir, "plan.review.json"), "utf8")).skips);
/** The JSON bootstrap a served page embeds for the review client. */
function bootstrapIn(page: string): any {
  const match = /id="sp-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(page);
  assert.ok(match?.[1], "the page embeds a bootstrap");
  return JSON.parse(match[1]);
}
const bootstrapOf = async () => {
  const page = await request("GET", `/plan/${key}`);
  return bootstrapIn(page.text);
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "coplan-test-"));
  const raw = join(dir, "plan.json");
  await writeFile(raw, JSON.stringify(decisionsOnlyPlan()));
  file = await canonicalPlanPath(raw);
  key = sessionKey(file);
  server = await startServer({ port: 0, stateDir: join(dir, "state"), buildId: "test", idleMs: 0 });
  const opened = await request("POST", "/api/sessions", { body: { file } });
  assert.equal(opened.json.key, key);
});

after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("the review client is served as JavaScript, whatever it is written in", async () => {
  const script = await request("GET", "/client/review.js");
  assert.equal(script.status, 200);
  assert.match(script.text, /from "\.\/store\.(ts|js)"/, "the entry module imports its siblings");
  assert.doesNotMatch(script.text, /^import type |\): void \{/m, "types are stripped before the browser sees them");
  assert.match((await request("GET", "/client/store.ts")).text, /sp-bootstrap/);
  assert.equal((await request("GET", "/client/review.css")).status, 200);
  assert.equal((await request("GET", "/client/../paths.js")).status, 404);
});

test("an invalid plan is served as an escaped error page that keeps the review client", async () => {
  await writePlan({ ...decisionsOnlyPlan(), "<b>bogus</b>": true });
  const page = await request("GET", `/plan/${key}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /does not validate yet/);
  assert.match(page.text, /&lt;b&gt;bogus&lt;\/b&gt;/);
  assert.doesNotMatch(page.text, /<b>bogus/);
  assert.equal((await bootstrapOf()).invalid, true);
  await writePlan(decisionsOnlyPlan());
});

test("browser routes refuse missing or foreign origins", async () => {
  const items = [{ kind: "message", text: "hi" }];
  assert.equal((await request("POST", `/api/${key}/feedback`, { body: { items } })).status, 403);
  assert.equal(
    (await request("POST", `/api/${key}/feedback`, { body: { items }, origin: "http://evil.test" })).status,
    403,
  );
  assert.equal(
    (await request("POST", "/api/reply", { body: { file, text: "x" }, origin: "http://evil.test" })).status,
    403,
  );
});

test("key decisions: validated against what the reviewer saw, then recorded and delivered", async () => {
  let boot = await bootstrapOf();
  assert.equal(boot.stage.stage, "decisions");
  const hash = boot.stage.decisionsHash;
  const post = (body: unknown) => browser(`/api/${key}/decisions`, body);

  assert.equal((await post({ hash: "stale", answers: {} })).status, 409);
  assert.equal(
    (await post({ hash, answers: { D1: { choices: ["admins", "anyone"] } } })).status,
    400,
    "single-select takes one",
  );
  assert.equal((await post({ hash, answers: { D1: { choices: ["nope"] } } })).status, 400);
  assert.equal((await post({ hash, answers: { D99: { choices: [] } } })).status, 400);

  const ok = await post({
    hash,
    answers: {
      D1: { choices: ["permission"] },
      D2: { choices: ["member", "guest"] },
      D9: { choices: [], other: "Only the inviter, by email" },
    },
    items: [{ kind: "message", text: "Keep v1 small." }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stage, "drafting");
  assert.equal((await post({ hash, answers: {} })).status, 409, "submitting twice is refused");

  const delivered = await poll();
  const [decisions, message] = delivered.json.items;
  assert.equal(decisions.kind, "decisions");
  assert.deepEqual(
    decisions.answered.map((a: { decision: string }) => a.decision),
    ["D1", "D2", "D9"],
  );
  assert.deepEqual(
    decisions.answered[1].choices.map((c: { label: string }) => c.label),
    ["Member", "Guest (read-only)"],
  );
  assert.equal(decisions.answered[2].other, "Only the inviter, by email");
  assert.equal(decisions.unanswered.length, 7);
  assert.equal(decisions.unanswered[0].decision, "D3");
  assert.deepEqual(decisions.unanswered[0].recommended, ["Sign up from the invite link"]);
  assert.equal(message.text, "Keep v1 small.");
  assert.equal(delivered.json.stage.stage, "drafting");
  await ack(delivered.json.batch_ids);

  await writePlan(examplePlan());
  boot = await bootstrapOf();
  assert.equal(boot.stage.stage, "plan_review");
  assert.deepEqual(boot.answers.D1, { choices: ["permission"] });
});

test("feedback waits in the queue until acknowledged, and is enriched for the agent", async () => {
  const sent = await browser(`/api/${key}/feedback`, {
    items: [
      {
        kind: "comment",
        target: { path: "tabs[4].cases[2]", kind: "edge_case", label: "E3", id: "E3" },
        quote: "Re-check",
        text: "Reserve instead",
      },
      { kind: "answer", question: "Q1", choice: "7d" },
      { kind: "answer", question: "Q2", choice: null, other: "Recruiters too" },
    ],
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.delivered_to_listener, false);

  const first = await poll();
  assert.equal(first.json.status, "feedback");
  assert.equal(first.json.items.length, 3);
  assert.equal(first.json.items[1].choice_label, "7 days");
  assert.equal(first.json.items[1].question_text, "How long should an invitation stay valid?");

  const again = await poll();
  assert.deepEqual(again.json.batch_ids, first.json.batch_ids, "unacknowledged feedback is delivered again");

  assert.equal((await ack(first.json.batch_ids)).json.remaining, 0);
});

test("a waiting poll wakes when feedback arrives", async () => {
  const waiting = poll();
  await new Promise((r) => setTimeout(r, 100));
  const sent = await browser(`/api/${key}/feedback`, { items: [{ kind: "message", text: "Looks good" }] });
  assert.equal(sent.json.delivered_to_listener, true);
  const result = await waiting;
  assert.equal(result.json.status, "feedback");
  assert.equal(result.json.items[0].text, "Looks good");
  await ack(result.json.batch_ids);
});

test("a poll answers `waiting` when its wait runs out, and the agent still counts as listening", async () => {
  const result = await poll(50);
  assert.equal(result.json.status, "waiting");
  // The agent is about to poll again; the page should not show it as gone in between.
  assert.equal((await bootstrapOf()).presence, "listening");
});

test("another site cannot take over the agent's poll", { timeout: 5000 }, async () => {
  const waiting = poll();
  await new Promise((r) => setTimeout(r, 100));
  // An image on another site sends a GET with no Origin; a request with a body always carries one.
  assert.equal((await request("GET", `/api/poll?${new URLSearchParams({ file })}`)).status, 404);
  assert.equal(
    (await request("POST", "/api/poll", { body: { file, wait_ms: 60_000 }, origin: "http://evil.test" })).status,
    403,
  );
  await browser(`/api/${key}/feedback`, { items: [{ kind: "message", text: "Still yours" }] });
  const result = await waiting;
  assert.equal(result.json.status, "feedback");
  await ack(result.json.batch_ids);
});

test("skips are saved on the plan at once, never queued as feedback, and restated on every poll", async () => {
  const skip = (id: string, value: unknown) => browser(`/api/${key}/skip`, { id, skip: value });
  assert.equal((await skip("F1", true)).status, 400, "flows cannot be skipped");
  assert.equal((await skip("E4", "yes")).status, 400);

  assert.deepEqual((await skip("E4", true)).json.skips, ["E4"]);
  assert.deepEqual((await skip("R3", true)).json.skips, ["E4", "R3"]);
  const review = JSON.parse(await readFile(join(dir, "plan.review.json"), "utf8"));
  assert.deepEqual(review.queue, [], "a skip is not feedback");

  const html = await readFile(join(dir, "plan.html"), "utf8");
  assert.match(html, /class="sp-item sp-skippable sp-skipped"[^>]*data-sp-id="E4"/);
  assert.match(html, /1 skipped/);
  assert.deepEqual(await recordedSkips(), ["E4", "R3"]);

  assert.deepEqual((await skip("G2", true)).json.skips, ["E4", "R3", "G2"], "gaps can be skipped too");
  await skip("G2", false);
  await skip("R3", false);
  assert.deepEqual(await recordedSkips(), ["E4"]);

  await browser(`/api/${key}/feedback`, { items: [{ kind: "message", text: "One note" }] });
  const delivered = await poll();
  assert.deepEqual(delivered.json.stage.skipped, [{ id: "E4", title: "Inviting someone who is already a member" }]);
  await ack(delivered.json.batch_ids);
});

test("approval requires the current hash and no open questions", async () => {
  let result = await browser(`/api/${key}/approve`, { phase: "plan", hash: "stale" });
  assert.equal(result.status, 409);

  const bootstrap = await bootstrapOf();
  result = await browser(`/api/${key}/approve`, { phase: "plan", hash: bootstrap.stage.planHash, next: "ship" });
  assert.equal(result.status, 400, "the plan approval says what comes next: slices or build");

  result = await browser(`/api/${key}/approve`, { phase: "plan", hash: bootstrap.stage.planHash });
  assert.equal(result.status, 409);
  assert.match(result.json.error, /open questions/);
});

test("the full two-phase approval", async () => {
  await writePlan({ ...examplePlan(), questions: [] });
  let page = await request("GET", `/plan/${key}`);
  let bootstrap = bootstrapIn(page.text);
  let result = await browser(`/api/${key}/approve`, { phase: "plan", hash: bootstrap.stage.planHash });
  assert.equal(result.status, 200);
  assert.equal(result.json.stage, "slicing");

  const approval = await poll();
  assert.deepEqual(
    approval.json.items.map((i: FeedbackItem) => [
      i.kind,
      "phase" in i ? i.phase : undefined,
      "next" in i ? i.next : undefined,
    ]),
    [["approval", "plan", "slices"]],
    "slicing is what comes next unless the reviewer chose to build now",
  );
  assert.equal(approval.json.stage.stage, "slicing");
  await ack(approval.json.batch_ids);

  await writePlan({ ...examplePlan(), questions: [], slices: SLICES });
  page = await request("GET", `/plan/${key}`);
  bootstrap = bootstrapIn(page.text);
  assert.equal(bootstrap.stage.stage, "slices_review");
  result = await browser(`/api/${key}/approve`, { phase: "slices", hash: bootstrap.stage.slicesHash });
  assert.equal(result.json.stage, "approved");

  const final = await poll();
  assert.equal(final.json.items[0].phase, "slices");
  await ack(final.json.batch_ids);
  const ended = await poll();
  assert.equal(ended.json.status, "ended");
  assert.equal(ended.json.ended_by, "approval");
  assert.equal(ended.json.stage.slices_skipped, false);

  const review = JSON.parse(await readFile(join(dir, "plan.review.json"), "utf8"));
  assert.ok(review.approvals.plan && review.approvals.slices);
  const html = await readFile(join(dir, "plan.html"), "utf8");
  assert.match(html, /Approved · ready to build/);
});

test("after the end, the browser cannot queue more feedback", async () => {
  const result = await browser(`/api/${key}/feedback`, { items: [{ kind: "message", text: "late" }] });
  assert.equal(result.status, 409);
});

test("approving the plan to build now skips slicing and closes the review", async () => {
  const plan = { ...examplePlan(), questions: [] };
  await writeFile(join(dir, "build.json"), JSON.stringify(plan));
  const buildFile = await canonicalPlanPath(join(dir, "build.json"));
  await writeFile(join(dir, "build.review.json"), JSON.stringify(submittedReview(validPlan(plan))));
  const buildKey = (await request("POST", "/api/sessions", { body: { file: buildFile } })).json.key;
  const page = await request("GET", `/plan/${buildKey}`);
  const bootstrap = bootstrapIn(page.text);
  assert.equal(bootstrap.stage.stage, "plan_review");

  const result = await browser(`/api/${buildKey}/approve`, {
    phase: "plan",
    hash: bootstrap.stage.planHash,
    next: "build",
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.stage, "approved");

  const buildPoll = () => request("POST", "/api/poll", { body: { file: buildFile, wait_ms: 60_000 } });
  const approval = await buildPoll();
  assert.deepEqual(
    approval.json.items.map((i: FeedbackItem) => [
      i.kind,
      "phase" in i ? i.phase : undefined,
      "next" in i ? i.next : undefined,
    ]),
    [["approval", "plan", "build"]],
  );
  assert.equal(approval.json.stage.stage, "approved");
  assert.equal(approval.json.stage.slices_skipped, true);
  await request("POST", "/api/ack", { body: { file: buildFile, batch_ids: approval.json.batch_ids } });
  const ended = await buildPoll();
  assert.equal(ended.json.ended_by, "approval");
  assert.equal(ended.json.stage.slices_skipped, true);

  const review = JSON.parse(await readFile(join(dir, "build.review.json"), "utf8"));
  assert.equal(review.approvals.plan.next, "build");
  assert.equal(review.approvals.slices, undefined);
  const html = await readFile(join(dir, "build.html"), "utf8");
  assert.match(html, /building without slices/);
  assert.match(html, /id="tab-overview"[^>]*aria-selected="true"/, "with no slices the overview is the default tab");
});
