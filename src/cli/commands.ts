// The CLI's commands, apart from `poll`. Each returns an object the CLI prints as JSON; most carry a
// `next_step` telling the agent exactly what to do next.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderToDisk } from "../engine.ts";
import { buildProgress } from "../plan/build.ts";
import { hasSlices } from "../plan/stage.ts";
import { DESCRIPTION, guideTopic, guideTopics, HOW_TO_POLL, LIGHTWEIGHT_WORKFLOW, RULES, WORKFLOW } from "../guide.ts";
import { APP, buildId, serverPort, stateDir } from "../paths.ts";
import { DECISIONS_MAX, DECISIONS_MIN, LIGHTWEIGHT } from "../plan/schema.ts";
import { PLACEHOLDER } from "../plan/validate.ts";
import type { BuildSummary, TaskResponse, TaskUpdate } from "../protocol.ts";
import { readReview } from "../review-store.ts";
import { CliError, display, parseArgs, planArg } from "./args.ts";
import { baseUrl, ensureServer, health, request } from "./server-client.ts";

export type Output = Record<string, unknown>;
type RenderResult = Awaited<ReturnType<typeof renderToDisk>>;

/** `coplan` with no command: the workflow, the rules, open reviews and the command list. */
export async function home(): Promise<Output> {
  const saved = (await readFile(join(stateDir(), "sessions.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}))) as { sessions?: Record<string, { key: string; file: string; status: string }> };
  const openReviews = Object.values(saved.sessions ?? {})
    .filter((session) => session.status === "open")
    .map((session) => ({ file: display(session.file), url: `${baseUrl()}/plan/${session.key}` }));
  return {
    description: DESCRIPTION,
    workflow: WORKFLOW,
    lightweight: LIGHTWEIGHT_WORKFLOW,
    rules: RULES,
    ...(openReviews.length ? { open_reviews: openReviews } : {}),
    commands: {
      "coplan setup [--remove]": "Install the skill for Claude Code, Codex and other agents on this machine",
      "coplan guide [topic]": "Guidance: workflow, decisions, plan, tabs, slices, build, lightweight",
      "coplan new <slug> [--title <title>] [--dir <dir>] [--lightweight]":
        "Scaffold .coplan/<slug>/plan.json; --lightweight for a plan reviewed in minutes",
      "coplan render <plan.json>":
        "Validate and write the portable plan.html; reports errors, warnings and reading time",
      "coplan open <plan.json> [--no-open] [--reopen]": "Start or resume the review in the browser",
      "coplan poll <plan.json> [--reply <text> | --reply-file <path|->] [--timeout <seconds>]":
        "Wait for the reviewer's feedback or approval; answers `waiting` if none comes in time",
      "coplan status <plan.json>": "Stage, approvals, undelivered feedback, and where the build stands",
      "coplan task start|built|commit|link <plan.json> <task>":
        "Report a step of building the approved slices; see `coplan guide build`",
      "coplan end <plan.json>": "End the review as the agent",
      "coplan stop": "Stop the background server",
    },
  };
}

export function guide(args: string[]): Output {
  const topic = args[0];
  if (!topic) return guideTopics();
  const body = guideTopic(topic);
  if (!body) throw new CliError(`unknown guide topic "${topic}"`, ["Run `coplan guide` to list topics"]);
  return body;
}

/**
 * Scaffolds a plan with only a title, summary and one example decision, full of placeholders.
 * `--lightweight` marks the plan lightweight, which scales every later step down.
 */
export async function newPlan(args: string[]): Promise<Output> {
  const { positional, flags } = parseArgs(args, ["title", "dir"]);
  const slug = positional[0];
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new CliError("new needs a kebab-case slug", [
      "Run `coplan new <slug>`, for example `coplan new team-invites`",
    ]);
  }
  const dir = resolve(typeof flags.dir === "string" ? flags.dir : join(".coplan", slug));
  const file = join(dir, "plan.json");
  if (existsSync(file)) throw new CliError(`${display(file)} already exists`, ["Edit it, then run `coplan render`"]);
  await mkdir(dir, { recursive: true });
  const lightweight = flags.lightweight === true;
  const todo = (text: string) => `${PLACEHOLDER} ${text}`;
  const skeleton = {
    version: 1,
    title: typeof flags.title === "string" ? flags.title : todo("feature title"),
    summary: todo(
      lightweight
        ? "two or three sentences: who can do what after this ships"
        : "one short paragraph: who can do what after this ships, and why it matters",
    ),
    ...(lightweight ? { lightweight: true } : { budget: "standard" }),
    decisions: [
      {
        id: "D1",
        question: todo("the most impactful open decision about this feature"),
        aspect: "scope",
        select: "single",
        context: todo("why it matters, in a sentence; delete this field if it is obvious"),
        options: [
          { id: "a", label: todo("a common choice"), recommended: true },
          { id: "b", label: todo("another common choice") },
        ],
      },
    ],
    questions: [],
  };
  await writeFile(file, `${JSON.stringify(skeleton, null, 2)}\n`);
  const [topic, count] = lightweight
    ? ["lightweight", `${LIGHTWEIGHT.decisionsMin}-${LIGHTWEIGHT.decisionsMax}`]
    : ["decisions", `${DECISIONS_MIN}-${DECISIONS_MAX}`];
  return {
    created: display(file),
    ...(lightweight ? { lightweight: true } : {}),
    next_step: `Read \`coplan guide ${topic}\`, then replace the "${PLACEHOLDER}" values in ${display(file)} and write ${count} key decisions, most impactful first. Do not write the plan yet - it comes after the reviewer answers. Run \`coplan render ${display(file)}\`, then \`coplan open ${display(file)}\`.`,
  };
}

export async function render(args: string[]): Promise<Output> {
  const file = await planArg(parseArgs(args).positional, "render");
  const result = await renderToDisk(file);
  const summary = renderSummary(file, result);
  if (result.ok) {
    summary.next_step = result.warnings.length
      ? `Rendered with warnings. Address them unless you have a reason not to, then ${reviewPointer(file)}`
      : `Rendered. ${reviewPointer(file)}`;
  }
  return summary;
}

export async function open(args: string[]): Promise<Output> {
  const { positional, flags } = parseArgs(args);
  const file = await planArg(positional, "open");
  const result = await renderToDisk(file);
  if (!result.ok) {
    const summary = renderSummary(file, result);
    summary.next_step = `The plan does not validate, so no review was opened. ${String(summary.next_step)} Then run \`coplan open ${display(file)}\`.`;
    return summary;
  }
  const url = await ensureServer();
  const { json } = await request<{ status: string; url: string; clients?: number }>("POST", `${url}/api/sessions`, {
    body: { file, reopen: Boolean(flags.reopen) },
  });
  if (json.status === "user-ended") {
    return {
      file: display(file),
      status: "user-ended",
      next_step:
        "The reviewer ended this review from the browser. Do not reopen it unless they ask; pass --reopen when they do.",
    };
  }
  const shouldOpen = !flags["no-open"] && process.env.COPLAN_NO_OPEN !== "1" && !json.clients;
  if (shouldOpen) openBrowser(json.url);
  return {
    ...renderSummary(file, result),
    url: json.url,
    browser: shouldOpen ? "opened" : json.clients ? "already open (reloaded)" : "not opened",
    next_step: `Do not respond to the user yet. Run \`coplan poll ${display(file)}\` in the foreground now and read what it returns. ${HOW_TO_POLL}`,
  };
}

export async function status(args: string[]): Promise<Output> {
  const file = await planArg(parseArgs(args).positional, "status");
  const result = await renderToDisk(file);
  const review = await readReview(file);
  const building = result.ok && result.stage.slicesApproved && hasSlices(result.plan);
  return {
    ...renderSummary(file, result),
    approvals: review.approvals,
    undelivered_feedback: review.queue.reduce((sum, batch) => sum + batch.items.length, 0),
    ...(building ? { build: buildProgress(result.plan.slices ?? [], review.build?.tasks).summary } : {}),
  };
}

const TASK_ACTIONS = ["start", "built", "commit", "link"] as const;
type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * `coplan task <action> <plan.json> <task>`: the agent reports a step of building the approved
 * slices. The server records it and refreshes the plan page; the reply says what to do next.
 */
export async function task(args: string[]): Promise<Output> {
  const { positional, flags } = parseArgs(args, ["pr", "jira", "remove"]);
  const [action, plan, taskId, sha] = positional;
  const usage = "Run `coplan task start|built|commit|link <plan.json> <task>`; `coplan guide build` explains each";
  if (!TASK_ACTIONS.includes(action as TaskAction)) {
    throw new CliError(`task needs an action: ${TASK_ACTIONS.join(", ")}`, [usage]);
  }
  const file = await planArg(plan ? [plan] : [], `task ${action}`);
  if (!taskId) throw new CliError(`task ${action} needs a task id, such as S1.T2`, [usage]);
  const update = taskUpdate(action as TaskAction, sha, flags);

  const url = await ensureServer();
  const { json } = await request<TaskResponse>("POST", `${url}/api/task`, {
    body: { file, task: taskId, ...update },
  });
  if (!json.ok) throw new CliError(json.error ?? "the server refused the report", [usage]);
  return {
    file: display(file),
    task: json.task,
    status: json.status,
    ...(json.warnings.length ? { warnings: json.warnings } : {}),
    build: json.build,
    next_step: taskNextStep(display(file), json.task, update, json.build),
  };
}

function taskUpdate(action: TaskAction, sha: string | undefined, flags: Record<string, string | true>): TaskUpdate {
  const value = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
  switch (action) {
    case "start":
      return { action };
    case "built":
      return { action };
    case "commit": {
      const removing = value("remove");
      const commit = removing ?? sha;
      if (!commit)
        throw new CliError("task commit needs the commit SHA", ["Run `coplan task commit <plan.json> <task> <sha>`"]);
      return { action, sha: commit, remove: removing !== undefined, pr: value("pr") };
    }
    case "link":
      if (value("pr") === undefined && value("jira") === undefined) {
        throw new CliError("task link needs --pr <url> or --jira <url>");
      }
      return { action, pr: value("pr"), jira: value("jira") };
  }
}

/** What the agent does after a report: the build loop of `coplan guide build`, one step at a time. */
function taskNextStep(f: string, id: string, update: TaskUpdate, build: BuildSummary): string {
  switch (update.action) {
    case "start":
      return `Build ${id} now - only this task - and run its tests. When it works, run \`coplan task built ${f} ${id}\`.`;
    case "built":
      return `Stop and ask the user in chat to review ${id}: say what changed and how to check it. Do not commit until they accept. If they ask for changes, run \`coplan task start ${f} ${id}\`, rework it and report it built again. Once they accept, commit this task's changes alone in one commit and run \`coplan task commit ${f} ${id} <sha>\`.`;
    case "commit":
      if (update.remove) return `Removed ${update.sha} from ${id}.`;
      if (!update.pr) {
        return `Push the branch and open a pull request for ${id} alone. If it depends on a task that is not merged yet, base its branch on that task's branch so the pull requests stack. Then run \`coplan task link ${f} ${id} --pr <url>\`.`;
      }
      return afterTask(f, build);
    case "link":
      return update.pr ? afterTask(f, build) : `Linked ${id}.`;
  }
}

function afterTask(f: string, build: BuildSummary): string {
  if (build.committed === build.total) return "Every task is committed. Tell the user the build is complete.";
  if (build.awaiting_review.length) {
    return `${build.awaiting_review.join(", ")} still ${build.awaiting_review.length === 1 ? "waits" : "wait"} for the user's review; ask them before going on.`;
  }
  if (build.in_progress.length) return `Carry on with ${build.in_progress[0]}, which is in progress.`;
  const next = build.next[0];
  return next
    ? `Next ready task: ${next}. If the user asked you to keep building, run \`coplan task start ${f} ${next}\`; otherwise tell them it is next.`
    : "No task is ready: the remaining ones wait on dependencies. Tell the user where the build stands.";
}

export async function end(args: string[]): Promise<Output> {
  const file = await planArg(parseArgs(args).positional, "end");
  if ((await health())?.app !== APP) return { file: display(file), status: "ended", note: "No server was running." };
  const response = await request("POST", `${baseUrl()}/api/end`, { body: { file } });
  return { file: display(file), status: response.status === 404 ? "not-open" : "ended" };
}

export async function stop(): Promise<Output> {
  if ((await health())?.app !== APP) return { status: "not-running" };
  await request("POST", `${baseUrl()}/shutdown`, { timeoutMs: 2000 }).catch(() => {});
  return { status: "stopped" };
}

/** `coplan server`: the background process `ensureServer` starts. Runs until shut down. */
export async function server(): Promise<never> {
  const { startServer } = await import("../server/index.ts");
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const running = await startServer({ port: serverPort(), stateDir: stateDir(), buildId: buildId(), log });
  running.onShutdown(() => process.exit(0));
  const stopServer = () => void running.close().then(() => process.exit(0));
  process.on("SIGINT", stopServer);
  process.on("SIGTERM", stopServer);
  return new Promise<never>(() => {});
}

// --- shared output ---

function renderSummary(file: string, result: RenderResult): Output {
  const base = { file: display(file) };
  if (!result.ok) {
    return {
      ...base,
      ok: false,
      errors: result.errors,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      next_step: `Fix every error in ${display(file)} and run \`coplan render ${display(file)}\` again. Paths point into the JSON.`,
    };
  }
  const warnings = result.warnings.length ? { warnings: result.warnings } : {};
  if (result.stage.stage === "decisions") {
    return {
      ...base,
      ok: true,
      html: display(result.htmlFile),
      stage: "decisions",
      decisions: result.plan.decisions.length,
      ...warnings,
    };
  }
  const { reading } = result;
  return {
    ...base,
    ok: true,
    html: display(result.htmlFile),
    stage: result.stage.stage,
    reading: `${reading.plan_minutes} min plan${reading.slices_minutes ? ` + ${reading.slices_minutes} min slices` : ""} (budget ${reading.budget}: ${reading.budget_minutes} min)`,
    ...warnings,
    ...(result.plan.questions.length ? { open_questions: result.plan.questions.map((q) => q.id) } : {}),
  };
}

function reviewPointer(file: string): string {
  return `If a review is open, the browser already reloaded: run \`coplan poll ${display(file)} --reply "<what changed>"\`. Otherwise run \`coplan open ${display(file)}\`.`;
}

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The URL is in the output; the user can open it by hand.
  }
}
