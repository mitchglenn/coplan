import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePlan, type ValidationResult } from "../src/plan/validate.ts";
import { examplePlan, SLICES } from "./helpers.ts";

const paths = (result: ValidationResult) => result.errors.map((e) => e.path);

test("unknown fields are errors that name their path and the allowed keys", () => {
  const plan = examplePlan();
  plan.tabs[4].cases[0].severity = "high";
  const result = validatePlan(plan);
  assert.equal(result.ok, false);
  const error = result.errors.find((e) => e.path === "tabs[4].cases[0].severity");
  assert.ok(error);
  assert.match(error.message, /allowed: id, title, priority, detail/);
});

test("flow steps must reference declared participants", () => {
  const plan = examplePlan();
  plan.tabs[1].flows[0].steps[1].to = "gateway";
  const result = validatePlan(plan);
  assert.deepEqual(paths(result), ["tabs[1].flows[0].steps[1].to"]);
  assert.match(result.errors[0].message, /declared: admin, web, api, db, mail/);
});

test("ids share one namespace across the plan", () => {
  const plan = examplePlan();
  plan.tabs[5].risks[0].id = "E1";
  const result = validatePlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /duplicate id "E1"; also used at tabs\[4\]\.cases\[0\]\.id/);
});

test("a plan needs an overview tab and warns without gaps", () => {
  const plan = examplePlan();
  plan.tabs = plan.tabs.filter((t: { kind: string }) => t.kind !== "overview" && t.kind !== "gaps");
  const result = validatePlan(plan);
  assert.ok(result.errors.some((e) => e.path === "tabs" && /overview/.test(e.message)));
  assert.ok(result.warnings.some((w) => /gaps/.test(w.message)));
});

test("placeholders left by `coplan new` are errors", () => {
  const plan = examplePlan();
  plan.tabs[0].goals[0].detail = "TODO: one sentence";
  const result = validatePlan(plan);
  assert.deepEqual(paths(result), ["tabs[0].goals[0].detail"]);
});

test("slices: references, cycles and horizontal-slice warnings", () => {
  const plan = examplePlan();
  plan.slices = structuredClone(SLICES);
  assert.equal(validatePlan(plan).ok, true);

  plan.slices[0].depends_on = ["S2"];
  assert.match(
    validatePlan(plan)
      .errors.map((e) => e.message)
      .join("\n"),
    /dependency cycle: S1 -> S2 -> S1/,
  );

  plan.slices[0].depends_on = ["S9"];
  assert.deepEqual(paths(validatePlan(plan)), ["slices[0].depends_on[0]"]);

  plan.slices[0].depends_on = [];
  plan.slices[2].layers = ["db"];
  assert.ok(validatePlan(plan).warnings.some((w) => w.path === "slices[2].layers"));
});

test("reserved tab ids and a second tab of one kind are refused", () => {
  const plan = examplePlan();
  plan.tabs[1].id = "slices";
  plan.tabs.push({ ...structuredClone(plan.tabs[4]), id: "more-edge-cases" });
  const messages = validatePlan(plan)
    .errors.map((e) => e.message)
    .join("\n");
  assert.match(messages, /reserved/);
  assert.match(messages, /only one edge_cases tab/);
});
