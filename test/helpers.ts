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

export const SLICES = [
  {
    id: "S1",
    title: "Thinnest invite",
    goal: "An admin invites and the invitee joins.",
    demo: "Invite, accept, land in the workspace.",
    layers: ["db", "api", "ui"],
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
    layers: ["api", "ui"],
    depends_on: ["S1"],
    acceptance: ["Revoked links refuse"],
    tasks: [{ id: "S2.T1", title: "Revoke endpoint" }],
  },
  {
    id: "S3",
    title: "Guard rails",
    goal: "Seats and expiry.",
    demo: "Fill the workspace and try again.",
    layers: ["db", "api"],
    depends_on: ["S1"],
    acceptance: ["Seats are reserved"],
    tasks: [{ id: "S3.T1", title: "Seat reservation" }],
  },
];
