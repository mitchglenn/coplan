// `coplan poll`: wait for the reviewer, then tell the agent exactly what to do with what arrived.
// Most of how the agent behaves during a review is steered by the `next_step` texts in this file.

import { readFile } from "node:fs/promises";
import { POLL_WAIT_MINUTES } from "../guide.ts";
import type { FeedbackItem, PollRequest, PollResponse, PollStage } from "../protocol.ts";
import { plural } from "../render/parts.ts";
import { CliError, display, parseArgs, planArg } from "./args.ts";
import type { Output } from "./commands.ts";
import { ensureServer, request, type Response } from "./server-client.ts";

export async function poll(args: string[]): Promise<Output> {
  const { positional, flags } = parseArgs(args, ["reply", "reply-file", "timeout"]);
  const file = await planArg(positional, "poll");
  const waitMs = waitFor(flags.timeout);
  const reply = await readReply(flags);
  const url = await ensureServer();
  if (reply !== null) {
    if (!reply.trim()) throw new CliError("the reply is empty");
    const { status } = await request("POST", `${url}/api/reply`, { body: { file, text: reply } });
    if (status === 404)
      throw new CliError("no review is open for this plan", [`Run \`coplan open ${display(file)}\` first`]);
  }

  process.stderr.write(
    `[coplan] Waiting up to ${formatWait(waitMs)} for the reviewer on ${display(file)}. Leave it running: it returns with their feedback, or with "waiting" if they need longer.\n`,
  );
  const onSignal = (signal: NodeJS.Signals) => {
    process.stderr.write(
      `\n[coplan] Poll interrupted. Run \`coplan poll ${display(file)}\` again; feedback waits until delivered.\n`,
    );
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const pollRequest: PollRequest = { file, wait_ms: waitMs };
  let result: Response<PollResponse>;
  try {
    // The server answers by `waitMs`; the extra minute only catches a server that never does.
    result = await request<PollResponse>("POST", `${url}/api/poll`, { body: pollRequest, timeoutMs: waitMs + 60_000 });
  } catch {
    // The connection dropped: the server stopped or was replaced. Nothing queued is lost.
    result = { status: 200, json: { status: "server_stopped" } };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const body = result.json;
  if (result.status === 404 || body.status === "missing") {
    throw new CliError("no review is open for this plan", [`Run \`coplan open ${display(file)}\` first`]);
  }
  switch (body.status) {
    case "waiting":
      return {
        file: display(file),
        status: "waiting",
        next_step: `The reviewer has not sent anything yet; a review often takes 10-15 minutes. Run \`coplan poll ${display(file)}\` again now, the same way, and keep waiting. Do not message the user in the meantime.`,
      };
    case "feedback":
      // Acknowledge only after the whole response is in hand: if this process dies first, the same
      // feedback is delivered again on the next poll instead of being lost.
      await request("POST", `${url}/api/ack`, { body: { file, batch_ids: body.batch_ids }, timeoutMs: 5000 }).catch(
        () => {},
      );
      return feedbackOutput(file, body.items, body.stage);
    case "ended":
      return {
        file: display(file),
        status: "ended",
        ended_by: body.ended_by,
        next_step: endedStep(file, body.ended_by, body.stage),
      };
    case "replaced":
      return {
        file: display(file),
        status: "replaced",
        next_step: "Another poll took over this review. Stop this one.",
      };
    default:
      return {
        file: display(file),
        status: body.status,
        next_step: `The server stopped before feedback arrived. Run \`coplan poll ${display(file)}\` again; nothing was lost.`,
      };
  }
}

/** How long this poll waits: `--timeout <seconds>`, or the wait the guidance promises agents. */
function waitFor(timeout: string | true | undefined): number {
  if (timeout === undefined) return POLL_WAIT_MINUTES * 60_000;
  const seconds = Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new CliError("--timeout takes a whole number of seconds, from 1 to 3600");
  }
  return seconds * 1000;
}

const formatWait = (ms: number) => (ms % 60_000 ? plural(ms / 1000, "second") : plural(ms / 60_000, "minute"));

async function readReply(flags: Record<string, string | true>): Promise<string | null> {
  if (flags.reply !== undefined && flags["reply-file"] !== undefined)
    throw new CliError("use --reply or --reply-file, not both");
  if (flags.reply !== undefined) return String(flags.reply);
  const source = flags["reply-file"];
  if (source === undefined) return null;
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(String(source), "utf8");
}

function endedStep(file: string, endedBy: string | null, stage: PollStage): string {
  if (endedBy === "approval") {
    return "slices_skipped" in stage && stage.slices_skipped
      ? `The review is complete: the reviewer approved the plan and chose to build now, without slices. Stop polling and build from the approved plan in ${display(file)}.`
      : "The review is complete: the plan and its slices are approved. Stop polling. Tell the user in chat, and start building only when they ask, slice by slice in wave order.";
  }
  if (endedBy === "user") {
    return `The reviewer ended the review. Stop polling and continue in chat. Only reopen with \`coplan open ${display(file)} --reopen\` if they ask.`;
  }
  return "This review has ended. Stop polling and continue in chat.";
}

/** The feedback, restated with instructions that depend on what the reviewer sent. */
function feedbackOutput(file: string, items: FeedbackItem[], stage: PollStage): Output {
  const f = display(file);
  const skipped = "skipped" in stage ? stage.skipped : [];
  const out: Output = {
    file: f,
    status: "feedback",
    stage: stage.stage,
    items,
    ...(skipped.length ? { skipped } : {}),
  };
  const others = items.filter((item) => item.kind !== "approval" && item.kind !== "decisions");
  // Skips are plan state the reviewer set directly on the page, not feedback: restate them on every
  // response so a skip made at any time reaches whatever the agent writes next.
  const skippedIds = skipped.map((s) => s.id).join(", ");
  const skipNote = skipped.length
    ? `The reviewer skipped ${skippedIds} (see \`skipped\`): the plan does not need to address ${skipped.length === 1 ? "it" : "them"}. Leave skipped items in ${f} exactly as they are - Coplan marks them on the page - and plan no work for them anywhere, including slices.`
    : "";
  const replyStep = `run \`coplan render ${f}\`, fix any errors, then run \`coplan poll ${f} --reply "<one or two sentences on what changed>"\` in the foreground. Use --reply-file for a longer Markdown reply.`;
  const sentences = (...parts: (string | false)[]) => parts.filter(Boolean).join(" ");

  const decisions = items.find((item) => item.kind === "decisions");
  if (decisions) {
    const total = decisions.answered.length + decisions.unanswered.length;
    out.next_step = sentences(
      `The reviewer submitted the key decisions: ${decisions.answered.length} of ${total} answered.`,
      `Now write the plan: read \`coplan guide plan\` and \`coplan guide tabs\`, then add \`tabs\` to ${f}. Do not change \`decisions\` - that re-opens them for the reviewer.`,
      decisions.answered.length > 0 &&
        "Every answered decision is a requirement, free-text answers included; the plan must follow them.",
      decisions.unanswered.length > 0 &&
        `For each unanswered decision (${decisions.unanswered.map((d) => d.decision).join(", ")}), make the call yourself - the recommended option is listed where there was one - and state what you assumed where it matters, in the tab it affects.`,
      others.length > 0 && "Also apply the comments that came with the submission.",
      "Add `questions` only for something genuinely new that the decisions did not settle.",
      `Then ${replyStep}`,
    );
    return out;
  }

  const approval = items.find((item) => item.kind === "approval");
  if (approval?.phase === "slices") {
    out.next_step =
      "The reviewer approved the slices. The plan is complete and the review is closed. Stop polling. Summarize the approved plan and its slice order for the user in chat, and start building only when they ask, one slice at a time in wave order.";
    return out;
  }
  if (approval?.phase === "plan" && approval.next === "build") {
    out.next_step = sentences(
      "The reviewer approved the plan and chose to skip slicing: start building now. The review is closed; stop polling.",
      `Tell the user in one line that you are starting, then implement the approved plan in ${f}. Do not add \`slices\` - the reviewer chose to go without them. Work in thin end-to-end steps anyway, starting with the simplest path through the whole feature.`,
      "Every submitted decision is a requirement, and the plan's out_of_scope list is binding.",
      others.length > 0 && "Also apply the notes that came with the approval as you build.",
      skipped.length > 0 && `The reviewer skipped ${skippedIds} (see \`skipped\`): build nothing for them.`,
    );
    return out;
  }
  if (approval?.phase === "plan") {
    out.next_step = sentences(
      "The reviewer approved the plan as it stands.",
      others.length > 0 && "Apply the notes that came with it to the slices, not the approved plan.",
      `Now break it into vertical slices: read \`coplan guide slices\`, then add \`slices\` to ${f} without changing any other part - editing the approved plan re-opens its review.`,
      skipNote,
      `When they are written, ${replyStep}`,
    );
    return out;
  }

  const answers = others.filter((item) => item.kind === "answer");
  out.next_step = sentences(
    `Apply this feedback to ${f}.`,
    "Each comment's target.path is the JSON path of the item the reviewer pointed at, in the version they reviewed; target.id names the record when it has one, and quote is text they selected.",
    answers.length > 0 &&
      `Fold each answer into the plan (update the content to reflect the decision) and delete the answered question${answers.length === 1 ? "" : "s"} (${answers.map((a) => a.question).join(", ")}) from \`questions\` in the same edit.`,
    skipNote,
    (stage.stage === "slices_review" || stage.stage === "slicing") &&
      "The plan itself is approved: change only `slices` and `questions` unless a comment explicitly asks to revise the plan, which re-opens its approval.",
    stage.stage === "invalid" && "The plan on disk does not validate right now; fix that first.",
    `Then ${replyStep}`,
  );
  return out;
}
