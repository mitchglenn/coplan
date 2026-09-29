// Where a plan is in its review, derived from the plan on disk and what the reviewer recorded.
//
// A plan moves through up to three human checkpoints: the reviewer submits key decisions, approves
// the plan, then approves its slices - unless they approved the plan to build straight away, which
// skips slicing and closes the review. The stage is never declared by the agent, so an agent cannot
// talk its way past a review, and editing something the reviewer signed off quietly re-opens it:
// each checkpoint records a hash of exactly the part it covers.

import { createHash } from "node:crypto";
import type { Diagnostic } from "./validate.ts";
import type { Plan } from "./schema.ts";
import type { NextStep, Phase, ReviewRecord, Stage, StageName } from "../protocol.ts";

export type { Stage, StageName } from "../protocol.ts";

const STAGE_LABELS: Record<StageName, string> = {
  decisions: "Key decisions",
  drafting: "Decisions in · drafting plan",
  plan_review: "Plan in review",
  slicing: "Plan approved · slicing",
  slices_review: "Slices in review",
  approved: "Approved · ready to build",
};

const PHASES: Partial<Record<StageName, Phase>> = {
  decisions: "decisions",
  plan_review: "plan",
  slices_review: "slices",
};

/** The part of a review record the stage depends on. */
export type ReviewCheckpoints = Pick<ReviewRecord, "approvals"> & Partial<Pick<ReviewRecord, "decisions">>;

// --- content hashes ---

/** JSON with sorted keys and no undefined values, so equal content always hashes equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

export function decisionsHash(plan: Plan): string {
  return digest(plan.decisions);
}

/**
 * Everything the plan approval covers. Decisions have their own hash; questions belong to
 * whichever phase is under review, and approval needs none open; `$schema` is editor metadata.
 */
export function planPartHash(plan: Plan): string {
  const { slices: _slices, questions: _questions, decisions: _decisions, $schema: _schema, ...rest } = plan;
  return digest(rest);
}

export function slicesHash(plan: Plan): string {
  return digest(plan.slices ?? []);
}

export function hasTabs(plan: Plan): plan is Plan & { tabs: NonNullable<Plan["tabs"]> } {
  return Boolean(plan.tabs?.length);
}

export function hasSlices(plan: Plan): plan is Plan & { slices: NonNullable<Plan["slices"]> } {
  return Boolean(plan.slices?.length);
}

/** What the reviewer chose after approving the plan. Approvals from before the choice existed mean slices. */
export function planApprovalNext(review: ReviewCheckpoints | null | undefined): NextStep {
  return review?.approvals?.plan?.next === "build" ? "build" : "slices";
}

// --- the stage machine ---

export function deriveStage(plan: Plan, review: ReviewCheckpoints | null | undefined): Stage {
  const decisionHash = decisionsHash(plan);
  const planHash = planPartHash(plan);
  const sliceHash = hasSlices(plan) ? slicesHash(plan) : null;
  const submission = review?.decisions ?? null;
  const planApproval = review?.approvals?.plan ?? null;
  const slicesApproval = review?.approvals?.slices ?? null;

  const decisionsSubmitted = submission?.hash === decisionHash;
  const planApproved = decisionsSubmitted && hasTabs(plan) && planApproval?.hash === planHash;
  const slicesApproved = planApproved && sliceHash !== null && slicesApproval?.hash === sliceHash;
  // Slices written against a build-now approval are a validation error, so this never has any.
  const slicesSkipped = planApproved && planApprovalNext(review) === "build";

  let stage: StageName = "decisions";
  if (decisionsSubmitted && !hasTabs(plan)) stage = "drafting";
  else if (decisionsSubmitted && !planApproved) stage = "plan_review";
  else if (slicesSkipped) stage = "approved";
  else if (planApproved && !sliceHash) stage = "slicing";
  else if (planApproved && !slicesApproved) stage = "slices_review";
  else if (slicesApproved) stage = "approved";

  return {
    stage,
    label: STAGE_LABELS[stage],
    phase: PHASES[stage] ?? null,
    decisionsHash: decisionHash,
    planHash,
    slicesHash: sliceHash,
    decisionsSubmitted,
    decisionsStale: Boolean(submission && !decisionsSubmitted),
    decisionsSubmittedAt: decisionsSubmitted ? submission.at : null,
    planApproved,
    planApprovalStale: Boolean(planApproval && decisionsSubmitted && !planApproved),
    planApprovedAt: planApproved ? planApproval.at : null,
    slicesSkipped,
    slicesApproved,
    slicesApprovalStale: Boolean(slicesApproval && sliceHash && !slicesApproved && planApproved),
    slicesApprovedAt: slicesApproved ? slicesApproval.at : null,
  };
}

/** Rules that need the review record, not just the plan, reported as validation errors. */
export function checkPhaseRules(plan: Plan, review: ReviewCheckpoints | null | undefined): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (hasTabs(plan) && !review?.decisions) {
    errors.push({
      path: "tabs",
      message:
        "the plan comes after the reviewer submits the key decisions. Remove `tabs` for now; once the decisions are in, `coplan poll` returns the answers and tells you to write the plan",
    });
  }
  if (hasSlices(plan) && !review?.approvals?.plan) {
    errors.push({
      path: "slices",
      message:
        "slices come after the reviewer approves the plan. Remove `slices` for now; once the plan is approved, `coplan poll` tells you to add them",
    });
  } else if (hasSlices(plan) && planApprovalNext(review) === "build") {
    errors.push({
      path: "slices",
      message:
        "the reviewer approved the plan to build now, without slices. Remove `slices` and build from the approved plan",
    });
  }
  return errors;
}
