import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetWarnings, readingTime, sliceWaves } from "../src/plan/metrics.ts";
import {
  checkPhaseRules,
  decisionsHash,
  deriveStage,
  planPartHash,
  slicesHash,
  type ReviewCheckpoints,
} from "../src/plan/stage.ts";
import { decisionsOnlyPlan, examplePlan, SLICES, validPlan as valid } from "./helpers.ts";

test("stage moves through decisions, both approvals, and re-opens when signed-off content changes", () => {
  const start = valid(decisionsOnlyPlan());
  const review: ReviewCheckpoints = { approvals: {} };
  assert.equal(deriveStage(start, review).stage, "decisions");
  assert.equal(deriveStage(start, review).phase, "decisions");

  review.decisions = { hash: decisionsHash(start), at: "2026-09-23T00:00:00Z", answers: {} };
  assert.equal(deriveStage(start, review).stage, "drafting");

  const plan = valid(examplePlan());
  assert.equal(decisionsHash(plan), decisionsHash(start), "the fixture and the example share their decisions");
  assert.equal(deriveStage(plan, review).stage, "plan_review");

  review.approvals.plan = { hash: planPartHash(plan), at: "2026-09-23T00:00:00Z" };
  assert.equal(deriveStage(plan, review).stage, "slicing");

  const sliced = valid({ ...examplePlan(), slices: structuredClone(SLICES) });
  assert.equal(deriveStage(sliced, review).stage, "slices_review", "adding slices keeps the plan approval");

  review.approvals.slices = { hash: slicesHash(sliced), at: "2026-09-23T00:00:00Z" };
  assert.equal(deriveStage(sliced, review).stage, "approved");

  const edited = valid({ ...examplePlan(), slices: structuredClone(SLICES), title: "Renamed" });
  const stage = deriveStage(edited, review);
  assert.equal(stage.stage, "plan_review");
  assert.equal(stage.planApprovalStale, true);

  const redecided = examplePlan();
  redecided.decisions[0].question = "Something else entirely?";
  const reopened = deriveStage(valid(redecided), review);
  assert.equal(reopened.stage, "decisions", "changing submitted decisions re-opens them");
  assert.equal(reopened.decisionsStale, true);
});

test("approving the plan to build now skips slicing, and slices are then refused", () => {
  const plan = valid(examplePlan());
  const review: ReviewCheckpoints = {
    decisions: { hash: decisionsHash(plan), at: "2026-09-23T00:00:00Z", answers: {} },
    approvals: { plan: { hash: planPartHash(plan), at: "2026-09-23T00:00:00Z", next: "build" } },
  };
  const stage = deriveStage(plan, review);
  assert.equal(stage.stage, "approved");
  assert.equal(stage.slicesSkipped, true);

  const sliced = valid({ ...examplePlan(), slices: structuredClone(SLICES) });
  assert.deepEqual(
    checkPhaseRules(sliced, review).map((e) => e.path),
    ["slices"],
  );

  const edited = deriveStage(valid({ ...examplePlan(), title: "Renamed" }), review);
  assert.equal(edited.stage, "plan_review", "editing the plan re-opens it, whatever came next");
  assert.equal(edited.slicesSkipped, false);
});

test("questions and decisions do not affect the plan approval hash", () => {
  const plan = valid(examplePlan());
  const trimmed = examplePlan();
  trimmed.questions = [];
  trimmed.decisions = trimmed.decisions.slice(0, 3);
  assert.equal(planPartHash(plan), planPartHash(valid(trimmed)));
});

test("tabs need submitted decisions and slices need an approved plan", () => {
  const plan = valid({ ...examplePlan(), slices: structuredClone(SLICES) });
  assert.deepEqual(
    checkPhaseRules(plan, { approvals: {} }).map((e) => e.path),
    ["tabs", "slices"],
  );
  const submitted: ReviewCheckpoints = {
    decisions: { hash: "old", at: "", answers: {} },
    approvals: { plan: { hash: "old", at: "" } },
  };
  assert.deepEqual(checkPhaseRules(plan, submitted), []);
});

test("waves group slices that can be built in parallel", () => {
  const plan = valid({ ...examplePlan(), slices: structuredClone(SLICES) });
  assert.deepEqual(sliceWaves(plan.slices ?? []), [["S1"], ["S2", "S3"]]);
});

test("reading time is reported and budgets warn only once a plan exists", () => {
  const plan = valid(examplePlan());
  const reading = readingTime(plan);
  assert.ok(reading.plan_minutes >= 4 && reading.plan_minutes <= 10, `got ${reading.plan_minutes}`);
  assert.equal(reading.decisions, 10);
  assert.deepEqual(budgetWarnings(plan), []);
  assert.equal(budgetWarnings({ ...plan, budget: "small" as const }).length, 1);
  assert.deepEqual(budgetWarnings({ ...valid(decisionsOnlyPlan()), budget: "small" as const }), []);
});
