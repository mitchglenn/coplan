import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { decisionsOnlyPlan } from "./helpers.ts";

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
