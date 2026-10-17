import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTaskUpdate, buildProgress, TaskError } from "../src/plan/build.ts";
import type { Slice } from "../src/plan/schema.ts";
import type { TaskRecord, TaskUpdate } from "../src/protocol.ts";
import { examplePlan, SLICES, validPlan } from "./helpers.ts";

// S1 (T1, then T2 after T1); S2 and S3 each depend on S1 and have one task.
const slices = (): Slice[] =>
  validPlan({ ...examplePlan(), questions: [], slices: structuredClone(SLICES) }).slices ?? [];

let minute = 0;

/** Applies reports in order, each a minute after the last, and returns the records. */
function report(steps: [string, TaskUpdate][], records: Record<string, TaskRecord> = {}): Record<string, TaskRecord> {
  for (const [task, update] of steps) {
    applyTaskUpdate(slices(), records, task, update, new Date(Date.UTC(2026, 9, 16, 12, minute++)).toISOString());
  }
  return records;
}

const statuses = (records: Record<string, TaskRecord>) =>
  Object.fromEntries([...buildProgress(slices(), records).tasks].map(([id, t]) => [id, t.status]));

test("before any report, tasks are ready or waiting on what they depend on", () => {
  const progress = buildProgress(slices());
  assert.equal(progress.started, false);
  assert.deepEqual(statuses({}), { "S1.T1": "ready", "S1.T2": "waiting", "S2.T1": "waiting", "S3.T1": "waiting" });
  assert.deepEqual(progress.tasks.get("S1.T2")?.blockedBy, ["S1.T1"], "a task in the same slice is named");
  assert.deepEqual(progress.tasks.get("S2.T1")?.blockedBy, ["S1"], "a slice it waits on is named by the slice");
  assert.deepEqual(Object.fromEntries(progress.slices), { S1: "ready", S2: "waiting", S3: "waiting" });
  assert.deepEqual(progress.summary, {
    committed: 0,
    total: 4,
    in_progress: [],
    awaiting_review: [],
    next: ["S1.T1"],
    orphaned: [],
  });
});

test("a task goes from in progress to built to committed, and frees what waits on it", () => {
  const records = report([["S1.T1", { action: "start" }]]);
  assert.equal(statuses(records)["S1.T1"], "in_progress");

  report([["S1.T1", { action: "built" }]], records);
  assert.equal(statuses(records)["S1.T1"], "built");
  assert.deepEqual(buildProgress(slices(), records).summary.awaiting_review, ["S1.T1"]);

  report([["S1.T1", { action: "commit", sha: "ABC1234DEF", pr: "https://github.com/acme/app/pull/7" }]], records);
  const progress = buildProgress(slices(), records);
  assert.equal(progress.tasks.get("S1.T1")?.status, "committed");
  assert.equal(records["S1.T1"]?.commits?.[0]?.sha, "abc1234def", "SHAs are stored lowercase");
  assert.equal(records["S1.T1"]?.pr?.url, "https://github.com/acme/app/pull/7");
  assert.equal(progress.tasks.get("S1.T2")?.status, "ready");
  assert.equal(progress.slices.get("S1"), "building");
  assert.equal(progress.started, true);
  assert.equal(progress.summary.committed, 1);
});

test("steps out of order are refused with what to do instead", () => {
  const refused = (records: Record<string, TaskRecord>, task: string, update: TaskUpdate, pattern: RegExp) =>
    assert.throws(
      () => applyTaskUpdate(slices(), records, task, update, "2026-10-16T12:00:00.000Z"),
      (error) => {
        assert.ok(error instanceof TaskError);
        assert.match(error.message, pattern);
        return true;
      },
    );
  const untouched: Record<string, TaskRecord> = {};
  refused(untouched, "S9.T1", { action: "start" }, /not a task of the approved slices/);
  refused(untouched, "S1.T1", { action: "built" }, /is ready; start it before reporting it built/);
  assert.deepEqual(untouched, {}, "a refused report leaves no record behind");

  const started = report([["S1.T1", { action: "start" }]]);
  refused(started, "S1.T1", { action: "commit", sha: "abc1234" }, /report it built and have the user review it/);

  const built = report([["S1.T1", { action: "built" }]], started);
  const before = structuredClone(built);
  refused(built, "S1.T1", { action: "commit", sha: "not-a-sha" }, /is not a commit SHA/);
  refused(built, "S1.T1", { action: "commit", sha: "abc1234", pr: "pull 7" }, /--pr needs a full URL/);
  refused(built, "S1.T1", { action: "link" }, /needs --pr or --jira/);
  refused(built, "S1.T1", { action: "link", pr: "https://github.com/a/b/pull/1", jira: "INV-1" }, /--jira/);
  assert.deepEqual(built, before, "a refused report changes nothing, even when part of it was valid");
});

test("starting a task that still waits is allowed, with a warning", () => {
  const warnings = applyTaskUpdate(slices(), {}, "S2.T1", { action: "start" }, "2026-10-16T12:00:00.000Z");
  assert.deepEqual(warnings, ["S2.T1 depends on S1, not committed yet"]);
});

test("rework re-opens a committed task, and its next commit is appended", () => {
  const records = report([
    ["S1.T1", { action: "start" }],
    ["S1.T1", { action: "built" }],
    ["S1.T1", { action: "commit", sha: "aaaaaaa" }],
    ["S1.T1", { action: "start" }],
  ]);
  assert.equal(statuses(records)["S1.T1"], "in_progress");
  report([["S1.T1", { action: "built" }]], records);
  assert.throws(
    () => applyTaskUpdate(slices(), records, "S1.T1", { action: "commit", sha: "aaaaaaa" }, "2026-10-16T13:00:00.000Z"),
    /already recorded for S1.T1; commit the rework/,
  );
  report([["S1.T1", { action: "commit", sha: "bbbbbbb" }]], records);
  assert.deepEqual(
    records["S1.T1"]?.commits?.map((c) => c.sha),
    ["aaaaaaa", "bbbbbbb"],
  );
  assert.equal(statuses(records)["S1.T1"], "committed");
});

test("a mistaken SHA can be taken back, and links replace earlier ones", () => {
  const records = report([
    ["S1.T1", { action: "start" }],
    ["S1.T1", { action: "built" }],
    ["S1.T1", { action: "commit", sha: "aaaaaaa" }],
    ["S1.T1", { action: "commit", sha: "bbbbbbb" }],
    ["S1.T1", { action: "commit", sha: "aaaaaaa", remove: true }],
    ["S1.T1", { action: "link", jira: "https://acme.atlassian.net/browse/INV-1" }],
    ["S1.T1", { action: "link", jira: "https://acme.atlassian.net/browse/INV-2" }],
  ]);
  assert.deepEqual(
    records["S1.T1"]?.commits?.map((c) => c.sha),
    ["bbbbbbb"],
  );
  assert.equal(records["S1.T1"]?.jira?.url, "https://acme.atlassian.net/browse/INV-2");
  assert.throws(
    () => applyTaskUpdate(slices(), records, "S1.T1", { action: "commit", sha: "ccccccc", remove: true }, "x"),
    /ccccccc is not recorded for S1.T1/,
  );
});

test("next follows epic order, a finished slice is done, and stray records are reported", () => {
  const records = report([
    ["S1.T1", { action: "start" }],
    ["S1.T1", { action: "built" }],
    ["S1.T1", { action: "commit", sha: "1111111" }],
    ["S1.T2", { action: "start" }],
    ["S1.T2", { action: "built" }],
    ["S1.T2", { action: "commit", sha: "2222222" }],
  ]);
  records["S7.T1"] = { started_at: "2026-10-16T12:00:00.000Z" };
  const progress = buildProgress(slices(), records);
  assert.equal(progress.slices.get("S1"), "done");
  assert.deepEqual(progress.summary.next, ["S2.T1", "S3.T1"]);
  assert.deepEqual(progress.summary.orphaned, ["S7.T1"]);
});
