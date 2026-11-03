import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Plan } from "../src/plan/schema.ts";
import { decisionsHash, type ReviewCheckpoints } from "../src/plan/stage.ts";
import { validatePlan } from "../src/plan/validate.ts";
import type { DecisionAnswer } from "../src/protocol.ts";

const FULL_PLAN = new URL("./fixtures/full-plan.json", import.meta.url);

/**
 * A fresh copy of a full plan (decisions and tabs), safe to mutate. It is raw JSON, typed loosely
 * on purpose: tests break it in ways the Plan type would not allow.
 */
export function examplePlan(): any {
  return JSON.parse(readFileSync(FULL_PLAN, "utf8"));
}

/** The same plan as it looks before the reviewer answered: title, summary and decisions only. */
export function decisionsOnlyPlan(): any {
  const { tabs: _tabs, questions: _questions, ...start } = examplePlan();
  return { ...start, questions: [] };
}

/** Validates plan JSON that must be valid, and returns the typed plan. */
export function validPlan(json: unknown): Plan {
  const result = validatePlan(json);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
  return result.plan;
}

/** A review record in which the reviewer submitted the plan's decisions. */
export function submittedReview(plan: Plan, answers: Record<string, DecisionAnswer> = {}): ReviewCheckpoints {
  return { decisions: { hash: decisionsHash(plan), at: "2026-09-23T00:00:00Z", answers }, approvals: {} };
}

/** A performance tab for the example plan; plans carry one only when scale matters, so the fixture has none. */
export const PERFORMANCE_TAB = {
  id: "performance",
  title: "Performance",
  kind: "performance",
  concerns: [
    {
      id: "P1",
      title: "Two admins fill the last seat at once",
      priority: "high",
      category: "concurrency",
      issue: "Both requests read one free seat and both insert an invitation.",
      approach:
        "Reserve the seat with a conditional `UPDATE ... WHERE seats_used < seat_limit` in the same transaction.",
      tradeoffs: ["A failed reservation surfaces as a seat-limit error, not a retry"],
    },
    {
      id: "P2",
      title: "Pending invitations list scans the whole table",
      priority: "low",
      category: "queries",
      issue: "The members page filters invitations by workspace and status on every load.",
      approach: "Add an index on `(workspace_id, status)`.",
    },
  ],
};

/** The example plan with the performance tab, placed before gaps as the guide orders it. */
export function planWithPerformance(): any {
  const plan = examplePlan();
  plan.tabs.splice(plan.tabs.length - 1, 0, structuredClone(PERFORMANCE_TAB));
  return plan;
}

export const SLICES = [
  {
    id: "S1",
    title: "Thinnest invite",
    goal: "An admin invites and the invitee joins.",
    demo: "Invite, accept, land in the workspace.",
    acceptance: ["Membership exists with the invited role"],
    tasks: [
      { id: "S1.T1", title: "Table", layer: "db", size: "S" },
      { id: "S1.T2", title: "Endpoint", layer: "api", size: "M", depends_on: ["S1.T1"] },
    ],
  },
  {
    id: "S2",
    title: "Revoke",
    goal: "Admins revoke pending invites.",
    demo: "Revoke and watch the link die.",
    depends_on: ["S1"],
    acceptance: ["Revoked links refuse"],
    tasks: [{ id: "S2.T1", title: "Revoke endpoint" }],
  },
  {
    id: "S3",
    title: "Guard rails",
    goal: "Seats and expiry.",
    demo: "Fill the workspace and try again.",
    depends_on: ["S1"],
    acceptance: ["Seats are reserved"],
    tasks: [{ id: "S3.T1", title: "Seat reservation" }],
  },
];
