import assert from "node:assert/strict";
import { test } from "node:test";
import { readingTime } from "../src/plan/metrics.ts";
import { deriveStage, type ReviewCheckpoints, type Stage } from "../src/plan/stage.ts";
import type { ReviewBootstrap } from "../src/protocol.ts";
import { renderPlanHtml } from "../src/render/page.ts";
import { renderSequence } from "../src/render/sequence.ts";
import { decisionsOnlyPlan, examplePlan, SLICES, submittedReview, validPlan } from "./helpers.ts";

function render(
  planJson: unknown,
  {
    review,
    served,
    stageOverride,
  }: { review?: ReviewCheckpoints; served?: { bootstrap: ReviewBootstrap }; stageOverride?: Partial<Stage> } = {},
) {
  const plan = validPlan(planJson);
  const record = review ?? submittedReview(plan);
  return renderPlanHtml({
    plan,
    stage: { ...deriveStage(plan, record), ...stageOverride },
    reading: readingTime(plan),
    answers: record.decisions?.answers ?? {},
    file: "/tmp/plan.json",
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

test("slices render with waves and default to the slices tab once in review", () => {
  const html = render(
    { ...examplePlan(), questions: [], slices: structuredClone(SLICES) },
    { stageOverride: { stage: "slices_review", phase: "slices" } },
  );
  assert.match(html, /data-default-tab="slices"/);
  assert.match(html, /Wave 2<\/span><span class="sp-wave-items">.*S2.*S3/s);
  assert.match(html, /data-sp-target="slices\[0\]\.tasks\[1\]" data-sp-kind="task"/);
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
