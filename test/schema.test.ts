import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePlan, type ValidationResult } from "../src/plan/validate.ts";
import { examplePlan, planWithPerformance, SLICES } from "./helpers.ts";

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

test("a performance tab is optional, and its concerns are typed and share the id namespace", () => {
  const without = validatePlan(examplePlan());
  assert.equal(without.ok, true);
  assert.ok(!without.warnings.some((w) => /performance/i.test(w.message)), "leaving it out is not a warning");

  const plan = planWithPerformance();
  assert.deepEqual(validatePlan(plan).errors, []);

  plan.tabs[6].concerns[0].category = "speed";
  assert.deepEqual(paths(validatePlan(plan)), ["tabs[6].concerns[0].category"]);
  plan.tabs[6].concerns[0].category = "concurrency";

  plan.tabs[6].concerns[1].id = "E1";
  assert.match(validatePlan(plan).errors[0]?.message ?? "", /duplicate id "E1"/);
});

test("a plan needs an overview tab and warns without gaps", () => {
  const plan = examplePlan();
  plan.tabs = plan.tabs.filter((t: { kind: string }) => t.kind !== "overview" && t.kind !== "gaps");
  const result = validatePlan(plan);
  assert.ok(result.errors.some((e) => e.path === "tabs" && /overview/.test(e.message)));
  assert.ok(result.warnings.some((w) => /gaps/.test(w.message)));
});

test("a lightweight plan asks 3-5 decisions, needs no gaps tab, and keeps its slices light", () => {
  const plan = examplePlan();
  plan.lightweight = true;
  plan.tabs = plan.tabs.filter((t: { kind: string }) => t.kind !== "gaps");
  let result = validatePlan(plan);
  assert.deepEqual(
    result.warnings.map((w) => w.path),
    ["decisions"],
    "ten decisions are too many, and no gaps tab is fine",
  );
  assert.match(result.warnings[0].message, /has 10; a lightweight plan asks 3-5/);

  plan.decisions = plan.decisions.slice(0, 4);
  plan.slices = structuredClone(SLICES).map(({ demo: _demo, ...slice }) => slice);
  result = validatePlan(plan);
  assert.deepEqual(result.errors, [], "a lightweight slice needs no demo");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(paths(validatePlan({ ...plan, lightweight: undefined })), [
    "slices[0].demo",
    "slices[1].demo",
    "slices[2].demo",
  ]);

  plan.slices.push(
    ...[4, 5].map((n) => ({
      id: `S${n}`,
      title: "More",
      goal: "More.",
      acceptance: ["More"],
      tasks: [{ id: `S${n}.T1`, title: "More" }],
    })),
  );
  plan.slices[0].tasks.push(...[3, 4, 5].map((n) => ({ id: `S1.T${n}`, title: "More" })));
  assert.deepEqual(
    validatePlan(plan).warnings.map((w) => w.path),
    ["slices[0].tasks", "slices"],
  );
});

test("a lightweight plan may carry a short performance tab", () => {
  const plan = planWithPerformance();
  plan.lightweight = true;
  plan.decisions = plan.decisions.slice(0, 4);
  assert.deepEqual(validatePlan(plan).warnings, [], "two concerns fit a lightweight plan");

  const concern = plan.tabs[6].concerns[0];
  plan.tabs[6].concerns.push({ ...concern, id: "P3" }, { ...concern, id: "P4" });
  assert.deepEqual(
    validatePlan(plan).warnings.map((w) => [w.path, w.message]),
    [
      [
        "tabs[6].concerns",
        "has 4; a lightweight plan keeps 3 performance concerns at most, the ones that change the build",
      ],
    ],
  );
  assert.deepEqual(
    validatePlan({ ...plan, lightweight: undefined }).warnings.map((w) => w.path),
    ["decisions"],
  );
});

test("placeholders left by `coplan new` are errors", () => {
  const plan = examplePlan();
  plan.tabs[0].goals[0].detail = "TODO: one sentence";
  const result = validatePlan(plan);
  assert.deepEqual(paths(result), ["tabs[0].goals[0].detail"]);
});

test("slices: references and cycles", () => {
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
