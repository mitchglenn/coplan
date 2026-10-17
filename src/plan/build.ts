// Build progress: what the agent reported about each task of the approved slices, and the status
// every task, slice and plan has as a result.
//
// Progress is declared by the agent through `coplan task`, recorded by the server in the review
// record, and never written into plan.json, where it would change the slices hash and void their
// approval. Statuses are derived from the records and the dependencies, never stored, so a record
// can never contradict the plan it belongs to.

import { slicePhases } from "./metrics.ts";
import type { Slice, Task } from "./schema.ts";
import type { BuildSummary, TaskRecord, TaskStatus, TaskUpdate } from "../protocol.ts";

export type SliceStatus = "waiting" | "ready" | "building" | "done";

export interface TaskProgress {
  task: Task;
  slice: Slice;
  status: TaskStatus;
  record: TaskRecord | null;
  /** Dependencies not committed yet: tasks in this slice by id, tasks in other slices by slice id. */
  blockedBy: string[];
}

export interface BuildProgress {
  /** Whether the agent reported anything for a task of these slices. */
  started: boolean;
  tasks: Map<string, TaskProgress>;
  slices: Map<string, SliceStatus>;
  summary: BuildSummary;
}

const SHA = /^[0-9a-f]{7,40}$/i;

/** The step a record ended on. On equal times the later step wins, so a commit beats its build. */
function latestStep(record: TaskRecord | undefined): "start" | "built" | "commit" | null {
  if (!record) return null;
  const steps: ["start" | "built" | "commit", string | undefined][] = [
    ["start", record.started_at],
    ["built", record.built_at],
    ["commit", record.commits?.at(-1)?.at],
  ];
  let latest: "start" | "built" | "commit" | null = null;
  let latestAt = "";
  for (const [step, at] of steps) {
    if (at && at >= latestAt) {
      latest = step;
      latestAt = at;
    }
  }
  return latest;
}

/** Every task a task waits for: its own dependencies, and every task of the slices its slice needs. */
function dependenciesOf(task: Task, slice: Slice, slices: Slice[]): string[] {
  const fromSlices = slices.filter((s) => slice.depends_on.includes(s.id)).flatMap((s) => s.tasks.map((t) => t.id));
  return [...new Set([...task.depends_on, ...fromSlices])];
}

export function buildProgress(slices: Slice[], records: Record<string, TaskRecord> = {}): BuildProgress {
  const sliceOf = new Map(slices.flatMap((slice) => slice.tasks.map((task) => [task.id, slice] as const)));
  const committed = new Set([...sliceOf.keys()].filter((id) => latestStep(records[id]) === "commit"));

  const tasks = new Map<string, TaskProgress>();
  for (const slice of slices) {
    for (const task of slice.tasks) {
      const record = records[task.id] ?? null;
      const missing = dependenciesOf(task, slice, slices).filter((id) => !committed.has(id));
      // Name a task in this slice, and the slice for one elsewhere, so a long wait reads short.
      const blockedBy = [
        ...new Set(missing.map((id) => (sliceOf.get(id) === slice ? id : (sliceOf.get(id)?.id ?? id)))),
      ];
      const step = latestStep(record ?? undefined);
      const status: TaskStatus =
        step === "commit"
          ? "committed"
          : step === "built"
            ? "built"
            : step === "start"
              ? "in_progress"
              : blockedBy.length
                ? "waiting"
                : "ready";
      tasks.set(task.id, { task, slice, status, record, blockedBy });
    }
  }

  const sliceStatuses = new Map<string, SliceStatus>();
  for (const slice of slices) {
    const statuses = slice.tasks.map((task) => tasks.get(task.id)?.status);
    sliceStatuses.set(
      slice.id,
      statuses.every((s) => s === "committed")
        ? "done"
        : statuses.some((s) => s !== "ready" && s !== "waiting")
          ? "building"
          : statuses.includes("ready")
            ? "ready"
            : "waiting",
    );
  }

  const byStatus = (status: TaskStatus) => [...tasks.values()].filter((t) => t.status === status).map((t) => t.task.id);
  const phaseOrder = slicePhases(slices).flat();
  const next = phaseOrder.flatMap(
    (id) =>
      slices
        .find((s) => s.id === id)
        ?.tasks.filter((t) => tasks.get(t.id)?.status === "ready")
        .map((t) => t.id) ?? [],
  );
  return {
    started: [...tasks.values()].some((t) => t.record),
    tasks,
    slices: sliceStatuses,
    summary: {
      committed: committed.size,
      total: tasks.size,
      in_progress: byStatus("in_progress"),
      awaiting_review: byStatus("built"),
      next,
      orphaned: Object.keys(records).filter((id) => !tasks.has(id)),
    },
  };
}

/** A report the plan's state does not allow, worded for the agent. */
export class TaskError extends Error {}

/**
 * Applies one report to the records and returns any warnings. Throws `TaskError` when the report
 * does not fit: an unknown task, a step out of order, a malformed SHA or link. A refused report
 * changes nothing: the task's record is rebuilt on a copy and stored only once the report fits.
 */
export function applyTaskUpdate(
  slices: Slice[],
  records: Record<string, TaskRecord>,
  taskId: string,
  update: TaskUpdate,
  now: string,
): string[] {
  const progress = buildProgress(slices, records).tasks.get(taskId);
  if (!progress) {
    throw new TaskError(`${taskId} is not a task of the approved slices`);
  }
  const record: TaskRecord = structuredClone(records[taskId] ?? {});
  const warnings: string[] = [];

  switch (update.action) {
    case "start":
      record.started_at = now;
      if (progress.status === "waiting") {
        warnings.push(`${taskId} depends on ${progress.blockedBy.join(", ")}, not committed yet`);
      }
      break;

    case "built":
      if (progress.status !== "in_progress") {
        throw new TaskError(`${taskId} is ${statusText(progress.status)}; start it before reporting it built`);
      }
      record.built_at = now;
      break;

    case "commit": {
      const sha = update.sha.trim().toLowerCase();
      if (!SHA.test(sha)) throw new TaskError(`"${update.sha}" is not a commit SHA (7-40 hex characters)`);
      const commits = record.commits ?? [];
      if (update.remove) {
        if (!commits.some((c) => c.sha === sha)) throw new TaskError(`${sha} is not recorded for ${taskId}`);
        record.commits = commits.filter((c) => c.sha !== sha);
        if (!record.commits.length) delete record.commits;
        break;
      }
      if (progress.status !== "built" && progress.status !== "committed") {
        throw new TaskError(
          `${taskId} is ${statusText(progress.status)}; report it built and have the user review it before committing`,
        );
      }
      const known = commits.some((c) => c.sha === sha);
      if (known && progress.status === "built") {
        throw new TaskError(`${sha} is already recorded for ${taskId}; commit the rework and report its new SHA`);
      }
      const pr = update.pr === undefined ? undefined : checkedUrl(update.pr, "--pr");
      if (!known) record.commits = [...commits, { sha, at: now }];
      if (pr !== undefined) record.pr = { url: pr, at: now };
      break;
    }

    case "link": {
      if (update.pr === undefined && update.jira === undefined) throw new TaskError("link needs --pr or --jira");
      const pr = update.pr === undefined ? undefined : checkedUrl(update.pr, "--pr");
      const jira = update.jira === undefined ? undefined : checkedUrl(update.jira, "--jira");
      if (pr !== undefined) record.pr = { url: pr, at: now };
      if (jira !== undefined) record.jira = { url: jira, at: now };
      break;
    }
  }
  records[taskId] = record;
  return warnings;
}

function checkedUrl(value: string, flag: string): string {
  const url = value.trim();
  if (!URL.canParse(url)) throw new TaskError(`${flag} needs a full URL, got "${value}"`);
  return url;
}

export function statusText(status: TaskStatus): string {
  return { waiting: "waiting", ready: "ready", in_progress: "in progress", built: "built", committed: "committed" }[
    status
  ];
}
