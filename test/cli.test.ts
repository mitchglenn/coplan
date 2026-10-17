import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { decisionsHash, planPartHash, slicesHash } from "../src/plan/stage.ts";
import { decisionsOnlyPlan, examplePlan, SLICES, validPlan } from "./helpers.ts";

// The `coplan` command as an agent runs it: a real process, in a home directory of its own, with
// a server of its own on a free port.

const BIN = new URL("../bin/coplan.js", import.meta.url).pathname;
const SKILL = readFileSync(new URL("../skills/coplan/SKILL.md", import.meta.url), "utf8");

let home: string;
let env: NodeJS.ProcessEnv;

async function coplan(...args: string[]): Promise<any> {
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: home, env });
  return JSON.parse(stdout);
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "coplan-cli-"));
  env = {
    ...process.env,
    HOME: home,
    COPLAN_STATE_DIR: join(home, "state"),
    COPLAN_PORT: String(await freePort()),
    COPLAN_NO_OPEN: "1",
  };
});

after(async () => {
  await coplan("stop");
  await rm(home, { recursive: true, force: true });
});

test("output is compact JSON on one line, for the agent to read", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, "guide", "tabs"], { cwd: home, env });
  assert.equal(stdout, `${JSON.stringify(JSON.parse(stdout))}\n`);
});

test("setup installs the skill for each agent present, refreshes it, and removes it", async () => {
  const claude = join(home, ".claude/skills/coplan/SKILL.md");
  const shared = join(home, ".agents/skills/coplan/SKILL.md");

  let result = await coplan("setup");
  assert.deepEqual(
    result.skill.map((s: { status: string }) => s.status),
    ["skipped: no ~/.claude", "installed"],
  );
  assert.equal(await readFile(shared, "utf8"), SKILL);

  await mkdir(join(home, ".claude"));
  await writeFile(shared, "an older version");
  result = await coplan("setup");
  assert.deepEqual(
    result.skill.map((s: { status: string }) => s.status),
    ["installed", "updated"],
  );
  assert.equal(await readFile(claude, "utf8"), SKILL);
  assert.equal((await coplan("setup")).skill[0].status, "up to date");

  result = await coplan("setup", "--remove");
  assert.deepEqual(
    result.skill.map((s: { status: string }) => s.status),
    ["removed", "removed"],
  );
  assert.ok(!existsSync(join(home, ".claude/skills/coplan")) && !existsSync(join(home, ".agents/skills/coplan")));
});

test("setup leaves a skill that is linked from elsewhere alone", async () => {
  const elsewhere = join(home, "my-skills/coplan");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "SKILL.md"), "mine");
  await mkdir(join(home, ".claude/skills"), { recursive: true });
  symlinkSync(elsewhere, join(home, ".claude/skills/coplan"));
  const result = await coplan("setup");
  assert.equal(result.skill[0].status, "left as is: a link you manage");
  assert.equal(await readFile(join(elsewhere, "SKILL.md"), "utf8"), "mine");
});

test("a poll with nothing to hand over returns in time and tells the agent to poll again", async () => {
  const dir = join(home, "project/.coplan/demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.json"), JSON.stringify(decisionsOnlyPlan()));
  const plan = ".coplan/demo/plan.json";
  const opened = await promisify(execFile)(process.execPath, [BIN, "open", plan], { cwd: join(home, "project"), env });
  assert.match(JSON.parse(opened.stdout).next_step, /shell timeout of at least 10 minutes/);

  const { stdout } = await promisify(execFile)(process.execPath, [BIN, "poll", plan, "--timeout", "1"], {
    cwd: join(home, "project"),
    env,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "waiting");
  assert.match(result.next_step, /Run `coplan poll \.coplan\/demo\/plan\.json` again now/);
});

test("a lightweight plan is scaffolded small, and its next steps point at the lightweight guide", async () => {
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const run = async (...args: string[]) =>
    JSON.parse((await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: project, env })).stdout);

  const created = await run("new", "quick-invites", "--lightweight", "--title", "Quick invites");
  assert.match(created.next_step, /Read `coplan guide lightweight`.* write 3-5 key decisions/);
  const plan = ".coplan/quick-invites/plan.json";
  const scaffold = JSON.parse(await readFile(join(project, plan), "utf8"));
  assert.equal(scaffold.lightweight, true);
  assert.equal("budget" in scaffold, false, "a lightweight plan has its own budget");

  const guide = await coplan("guide", "lightweight");
  assert.deepEqual(Object.keys(guide), ["purpose", "codebase", "decisions", "plan", "slices", "shape"]);

  const written = {
    ...scaffold,
    summary: "Admins invite teammates by email.",
    decisions: decisionsOnlyPlan().decisions.slice(0, 4),
  };
  await writeFile(join(project, plan), JSON.stringify(written));
  const opened = await run("open", plan);
  assert.equal(opened.ok, true);
  assert.equal(opened.warnings, undefined);

  // The reviewer submits the decisions from the page, answering none of them.
  const { origin, pathname } = new URL(opened.url);
  const key = pathname.split("/").pop();
  const submitted = await fetch(`${origin}/api/${key}/decisions`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ hash: decisionsHash(validPlan(written)), answers: {}, items: [] }),
  });
  assert.equal(submitted.status, 200);

  const polled = await run("poll", plan, "--timeout", "5");
  assert.equal(polled.status, "feedback");
  assert.match(polled.next_step, /Now write the lightweight plan `coplan guide lightweight` describes/);
  assert.doesNotMatch(polled.next_step, /guide plan/);
});

test("building approved slices: each `coplan task` report says what to do next, and status shows the build", async () => {
  const project = join(home, "builder");
  const dir = join(project, ".coplan/invites");
  await mkdir(dir, { recursive: true });
  const json = { ...examplePlan(), questions: [], slices: structuredClone(SLICES) };
  const plan = validPlan(json);
  const at = "2026-10-16T12:00:00.000Z";
  await writeFile(join(dir, "plan.json"), JSON.stringify(json));
  await writeFile(
    join(dir, "plan.review.json"),
    JSON.stringify({
      version: 1,
      decisions: { hash: decisionsHash(plan), at, answers: {} },
      approvals: { plan: { hash: planPartHash(plan), at, next: "slices" }, slices: { hash: slicesHash(plan), at } },
      skips: {},
      queue: [],
      history: [],
    }),
  );
  const file = ".coplan/invites/plan.json";
  const run = async (...args: string[]) =>
    JSON.parse((await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: project, env })).stdout);

  const guide = await coplan("guide", "build");
  assert.deepEqual(Object.keys(guide), ["purpose", "loop", "rules"]);
  assert.deepEqual((await run("status", file)).build.next, ["S1.T1"]);

  const started = await run("task", "start", file, "S1.T1");
  assert.equal(started.status, "in_progress");
  assert.match(started.next_step, /Build S1.T1 now.*coplan task built \.coplan\/invites\/plan\.json S1.T1`/);

  const built = await run("task", "built", file, "S1.T1");
  assert.equal(built.status, "built");
  assert.match(built.next_step, /ask the user in chat to review S1.T1.*Do not commit until they accept/);

  const committed = await run("task", "commit", file, "S1.T1", "abc1234");
  assert.equal(committed.status, "committed");
  assert.match(committed.next_step, /open a pull request for S1.T1 alone.*coplan task link .* S1.T1 --pr <url>/);

  const linked = await run("task", "link", file, "S1.T1", "--pr", "https://github.com/acme/app/pull/7");
  assert.match(linked.next_step, /Next ready task: S1.T2/);
  assert.deepEqual((await run("status", file)).build.next, ["S1.T2"]);

  // A refused report prints its error as JSON and exits non-zero.
  const fails = (...args: string[]) =>
    promisify(execFile)(process.execPath, [BIN, ...args], { cwd: project, env }).then(
      () => assert.fail("expected the command to fail"),
      (error: { code: number; stdout: string }) => {
        assert.equal(error.code, 1);
        return JSON.parse(error.stdout);
      },
    );
  assert.match(
    (await fails("task", "built", file, "S1.T2")).error,
    /S1.T2 is ready; start it before reporting it built/,
  );
  assert.match(
    (await fails("task", "finish", file, "S1.T2")).error,
    /task needs an action: start, built, commit, link/,
  );
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}
