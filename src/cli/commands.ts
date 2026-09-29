// The CLI's commands, apart from `poll`. Each returns an object the CLI prints as JSON; most carry a
// `next_step` telling the agent exactly what to do next.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderToDisk } from "../engine.ts";
import { DESCRIPTION, guideTopic, guideTopics, HOW_TO_POLL, RULES, WORKFLOW } from "../guide.ts";
import { APP, buildId, serverPort, stateDir } from "../paths.ts";
import { PLACEHOLDER } from "../plan/validate.ts";
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
    rules: RULES,
    ...(openReviews.length ? { open_reviews: openReviews } : {}),
    commands: {
      "coplan setup [--remove]": "Install the skill for Claude Code, Codex and other agents on this machine",
      "coplan guide [topic]": "Authoring guidance: workflow, decisions, plan, tabs, slices",
      "coplan new <slug> [--title <title>] [--dir <dir>]": "Scaffold .coplan/<slug>/plan.json",
      "coplan render <plan.json>":
        "Validate and write the portable plan.html; reports errors, warnings and reading time",
      "coplan open <plan.json> [--no-open] [--reopen]": "Start or resume the review in the browser",
      "coplan poll <plan.json> [--reply <text> | --reply-file <path|->] [--timeout <seconds>]":
        "Wait for the reviewer's feedback or approval; answers `waiting` if none comes in time",
      "coplan status <plan.json>": "Stage, approvals, and undelivered feedback",
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

/** Scaffolds a plan with only a title, summary and one example decision, full of placeholders. */
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
  const todo = (text: string) => `${PLACEHOLDER} ${text}`;
  const skeleton = {
    version: 1,
    title: typeof flags.title === "string" ? flags.title : todo("feature title"),
    summary: todo("one short paragraph: who can do what after this ships, and why it matters"),
    budget: "standard",
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
  return {
    created: display(file),
    next_step: `Read \`coplan guide decisions\`, then replace the "${PLACEHOLDER}" values in ${display(file)} and write 8-12 key decisions, most impactful first. Do not write the plan yet - it comes after the reviewer answers. Run \`coplan render ${display(file)}\`, then \`coplan open ${display(file)}\`.`,
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
  return {
    ...renderSummary(file, result),
    approvals: review.approvals,
    undelivered_feedback: review.queue.reduce((sum, batch) => sum + batch.items.length, 0),
  };
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
