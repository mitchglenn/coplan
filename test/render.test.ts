import assert from "node:assert/strict";
import { test } from "node:test";
import { readingTime } from "../src/plan/metrics.ts";
import { deriveStage, type ReviewCheckpoints, type Stage } from "../src/plan/stage.ts";
import type { ReviewBootstrap, TaskRecord } from "../src/protocol.ts";
import { renderPlanHtml } from "../src/render/page.ts";
import { renderSequence } from "../src/render/sequence.ts";
import { decisionsOnlyPlan, examplePlan, planWithPerformance, SLICES, submittedReview, validPlan } from "./helpers.ts";

function render(
  planJson: unknown,
  {
    review,
    served,
    stageOverride,
    tasks,
  }: {
    review?: ReviewCheckpoints;
    served?: { bootstrap: ReviewBootstrap };
    stageOverride?: Partial<Stage>;
    tasks?: Record<string, TaskRecord>;
  } = {},
) {
  const plan = validPlan(planJson);
  const record = review ?? submittedReview(plan);
  return renderPlanHtml({
    plan,
    stage: { ...deriveStage(plan, record), ...stageOverride },
    reading: readingTime(plan),
    answers: record.decisions?.answers ?? {},
    file: "/tmp/plan.json",
    tasks,
    review: served ?? null,
  });
}

test("the decisions stage renders a questionnaire and nothing else", () => {
  const html = render(decisionsOnlyPlan(), { review: { approvals: {} } });
  assert.match(html, /data-tab="decisions"/);
  assert.doesNotMatch(html, /data-tab="overview"/);
  assert.match(html, /<input type="checkbox" name="sp-d-D2" value="member" disabled>/);
  assert.match(html, /<input type="radio" name="sp-d-D1" value="admins" disabled>/);
  assert.equal((html.match(/data-sp-other/g) || []).length, 10, "every decision offers a free-text answer");
  assert.match(html, /10 decisions · all optional/);
});

test("a static plan render has tabs, targets, the decisions summary, and no review client", () => {
  const plan = examplePlan();
  const html = render(plan, {
    review: submittedReview(validPlan(plan), {
      D1: { choices: ["permission"] },
      D9: { choices: [], other: "Only the inviter, by email" },
    }),
  });
  for (const tab of [
    "overview",
    "flows",
    "concepts",
    "edge-cases",
    "security",
    "data",
    "gaps",
    "decisions",
    "questions",
  ]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
  assert.match(html, /data-default-tab="overview"/);
  assert.match(html, /data-sp-target="tabs\[4\]\.cases\[0\]" data-sp-kind="edge_case"/);
  assert.match(html, /data-sp-target="tabs\[1\]\.flows\[0\]\.steps\[2\]"/);
  assert.match(html, /<input type="radio" name="sp-q-Q1" value="7d" disabled>/);
  assert.match(html, /2 of 10 answered/);
  assert.match(html, /Admins plus members with an invite permission/);
  assert.match(html, /Only the inviter, by email/);
  assert.match(html, /Left to the agent/);
  assert.doesNotMatch(html, /review\.js/);
  assert.doesNotMatch(html, /data-tab="slices"/);
});

test("skipped items stay visible, marked, and leave the priority count", () => {
  const valid = validPlan(examplePlan());
  const html = renderPlanHtml({
    plan: valid,
    stage: deriveStage(valid, submittedReview(valid)),
    reading: readingTime(valid),
    skips: { E1: { at: "2026-09-23T00:00:00Z" } },
    file: "/tmp/plan.json",
  });
  assert.match(
    html,
    /sp-skipped"[^>]*data-sp-id="E1"[^>]*data-sp-skipped><header[^>]*>.*?<span class="sp-skip-pill">Skipped<\/span>/s,
  );
  assert.match(html, /High<span class="sp-count">1<\/span><span class="sp-count-skipped">1 skipped<\/span>/);
  assert.match(
    html,
    /data-sp-id="E1"[^>]*data-sp-skipped>.*?<div class="sp-item-body"><div class="sp-md"><p>Two tabs/s,
  );
});

test("performance concerns render by priority with their category, approach and trade-offs, and can be skipped", () => {
  const valid = validPlan(planWithPerformance());
  const html = renderPlanHtml({
    plan: valid,
    stage: deriveStage(valid, submittedReview(valid)),
    reading: readingTime(valid),
    skips: { P2: { at: "2026-09-23T00:00:00Z" } },
    file: "/tmp/plan.json",
  });
  assert.match(html, /data-tab="performance"[^>]*><span>Performance<\/span><span class="sp-tab-count">1<\/span>/);
  const panel = /<section class="sp-panel sp-panel-performance".*?<\/section>\n/s.exec(html)?.[0] ?? "";
  assert.match(
    panel,
    /data-sp-target="tabs\[6\]\.concerns\[0\]" data-sp-kind="concern"[^>]*data-sp-skippable="P1">.*?<span class="sp-category">Concurrency<\/span>/s,
  );
  assert.match(panel, /<div class="sp-approach"><span class="sp-eyebrow">Approach<\/span>.*?<code>UPDATE/s);
  assert.match(
    panel,
    /<div class="sp-tradeoffs"><span class="sp-eyebrow">Trade-offs<\/span><ul><li>A failed reservation/,
  );
  assert.match(panel, /Low<span class="sp-count">0<\/span><span class="sp-count-skipped">1 skipped<\/span>/);
  assert.doesNotMatch(
    /data-sp-id="P2".*?<\/article>/s.exec(panel)?.[0] ?? "",
    /sp-tradeoffs/,
    "a concern without trade-offs shows none",
  );
});

test("served renders embed the bootstrap safely", () => {
  // Only the escaping matters here, so the bootstrap is a stand-in carrying hostile text.
  const bootstrap = { key: "k", note: "</script><b>" } as unknown as ReviewBootstrap;
  const html = render(examplePlan(), { served: { bootstrap } });
  assert.match(html, /<script type="module" src="\/client\/review\.js"><\/script>/);
  assert.doesNotMatch(html, /<\/script><b>/);
});

test("html blocks render as written, scripts included, for interactive mocks", () => {
  const plan = examplePlan();
  const mock =
    '<style>.mock button{color:red}</style><div class="mock"><button onclick="flip()">Before</button></div><script>function flip() {}</script>';
  plan.tabs[3].blocks.push({ type: "html", html: mock });
  assert.ok(render(plan).includes(`<div class="sp-html-body">${mock}</div>`));
});

test("slices render on the Execution tab, grouped into phases, and it opens once they are in review", () => {
  const html = render(
    { ...examplePlan(), questions: [], slices: structuredClone(SLICES) },
    { stageOverride: { stage: "slices_review", phase: "slices" } },
  );
  assert.match(html, /data-default-tab="slices"/);
  assert.match(html, /data-tab="slices"[^>]*><span>Execution<\/span>/);
  assert.match(html, /Phase 2<\/span><span class="sp-phase-items">.*S2.*S3/s);
  assert.match(html, /data-sp-target="slices\[0\]\.tasks\[1\]" data-sp-kind="task"/);
});

test("a lightweight plan says so in the header, and its slices may go without a demo", () => {
  const slices = structuredClone(SLICES).map(({ demo: _demo, ...slice }) => slice);
  const html = render(
    { ...examplePlan(), lightweight: true, questions: [], slices },
    { stageOverride: { stage: "slices_review", phase: "slices" } },
  );
  assert.match(html, /<span class="sp-reading">Lightweight · \d+(\.5)? min plan · \d+(\.5)? min slices<\/span>/);
  assert.doesNotMatch(html, /class="sp-demo"/);
  assert.doesNotMatch(render(examplePlan()), /Lightweight/);
});

test("sequence notes do not take a step number", () => {
  const svg = renderSequence(
    {
      title: "t",
      participants: [
        { id: "a", label: "A", kind: "system" },
        { id: "b", label: "B", kind: "system" },
      ],
      steps: [
        { from: "a", to: "b", label: "first", reply: false },
        { note: "between", over: ["a", "b"] },
        { from: "b", to: "a", label: "second", reply: true },
      ],
    },
    "tabs[1].flows[0]",
  ).toString();
  assert.match(
    svg,
    /data-sp-target="tabs\[1\]\.flows\[0\]\.steps\[2\]" data-sp-kind="step" data-sp-label="Step 2: second"/,
  );
  assert.match(svg, />2\. second</);
});

const approvedSlices = { stage: "approved", phase: null, slicesApproved: true } as const;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 12, minute)).toISOString();

test("a slice under review lists its tasks without their files", () => {
  const slices: any[] = structuredClone(SLICES);
  slices[0].tasks[0].files = ["db/migrate/add_invites.rb"];
  const html = render(
    { ...examplePlan(), questions: [], slices },
    { stageOverride: { stage: "slices_review", phase: "slices" } },
  );
  const card = /<article class="sp-card sp-slice" id="slice-S1".*?<\/article>/s.exec(html)?.[0] ?? "";
  assert.match(card, /<li class="sp-task"[^>]*data-sp-id="S1.T1">/);
  assert.doesNotMatch(card, /add_invites\.rb|class="sp-refs"/, "tasks list no files");
  assert.match(card, /<span class="sp-layer">db<\/span>/, "a task still shows its own layer");
  assert.doesNotMatch(html, /class="sp-build"|class="sp-node/, "no progress before the slices are approved");
});

test("once building, the tab tracks every task and the header counts what is committed", () => {
  const tasks: Record<string, TaskRecord> = {
    "S1.T1": {
      started_at: at(0),
      built_at: at(5),
      commits: [{ sha: "abc1234def", at: at(9) }],
      pr: { url: "https://github.com/acme/app/pull/7", at: at(10) },
      jira: { url: "https://acme.atlassian.net/browse/INV-12", at: at(10) },
    },
    "S1.T2": { started_at: at(11), built_at: at(20) },
    "S2.T1": { started_at: at(21) },
  };
  const html = render(
    { ...examplePlan(), questions: [], slices: structuredClone(SLICES) },
    { stageOverride: approvedSlices, tasks },
  );
  assert.match(html, /<span class="sp-stage sp-stage-building">Building · 1 of 4 committed<\/span>/);
  assert.match(html, /<p class="sp-build-count"><strong>1<\/strong> of 4 tasks committed<\/p>/);
  assert.match(html, /<b class="sp-build-review">1 waiting for your review<\/b> · <span>1 in progress<\/span>/);
  assert.match(html, /<li class="sp-task sp-task-committed"[^>]*data-sp-id="S1.T1">/);
  assert.match(html, /<code class="sp-commit" title="abc1234def">.*abc1234<\/code>/);
  assert.match(html, /href="https:\/\/github.com\/acme\/app\/pull\/7"[^>]*>.*#7<\/a>/);
  assert.match(html, /<span class="sp-link-kind">Jira<\/span>INV-12<\/a>/);
  assert.match(html, /<li class="sp-task sp-task-built"[^>]*data-sp-id="S1.T2">.*?waiting for your review/s);
  assert.match(html, /<li class="sp-task sp-task-in_progress"[^>]*data-sp-id="S2.T1">.*Agent is building this/s);
  assert.match(html, /<li class="sp-task sp-task-waiting"[^>]*data-sp-id="S3.T1">.*Waiting on <code>S1<\/code>/s);
  assert.match(html, /<a class="sp-dep" href="#slice-S1"/, "S1 is not done, so its dependents show no check");
});

test("a finished slice folds away, and a finished build says so", () => {
  const done = (minute: number, sha: string): TaskRecord => ({
    started_at: at(minute),
    built_at: at(minute + 1),
    commits: [{ sha, at: at(minute + 2) }],
  });
  const tasks = { "S1.T1": done(0, "aaaaaaa"), "S1.T2": done(3, "bbbbbbb") };
  const plan = { ...examplePlan(), questions: [], slices: structuredClone(SLICES) };
  const partial = render(plan, { stageOverride: approvedSlices, tasks });
  assert.match(
    partial,
    /<details class="sp-slice-fold"><summary class="sp-slice-state"><span class="sp-slice-pill sp-slice-pill-done">Done<\/span>/,
  );
  assert.match(partial, /<a class="sp-dep sp-dep-done" href="#slice-S1"/);

  // With S1 done, S2.T1 is ready: its node says so, and it has no status line.
  const ready = /<li class="sp-task sp-task-ready"[^>]*data-sp-id="S2.T1">.*?<\/li>/s.exec(partial)?.[0] ?? "";
  assert.match(ready, /<span class="sp-node sp-st-ready"/);
  assert.doesNotMatch(ready, /sp-task-status|Ready ·/);

  const all = render(plan, {
    stageOverride: approvedSlices,
    tasks: { ...tasks, "S2.T1": done(6, "ccccccc"), "S3.T1": done(9, "ddddddd") },
  });
  assert.match(all, /<span class="sp-stage sp-stage-built">Built · all 4 tasks committed<\/span>/);
});

test("records wait while the slices' approval is stale", () => {
  const html = render(
    { ...examplePlan(), questions: [], slices: structuredClone(SLICES) },
    {
      stageOverride: { stage: "slices_review", phase: "slices", slicesApproved: false },
      tasks: { "S1.T1": { started_at: at(0) } },
    },
  );
  assert.doesNotMatch(html, /class="sp-stage sp-stage-building"|class="sp-task sp-task-in_progress"/);
});
