// The review panel: the conversation with the agent, the reviewer's unsent notes, and the
// controls to send, approve or end. `renderPanel` redraws it from state on every change; the
// buttons are wired in actions.ts.

import type { ConversationItem, RenderedHistoryEntry } from "../protocol.ts";
import { openCard, targetNode } from "./comments.ts";
import { decisionCounts, inDecisions } from "./decisions.ts";
import { el, ICONS } from "./dom.ts";
import { answeredEarlier, completeAnswers } from "./questions.ts";
import { changed, load, review, save, state } from "./store.ts";

/** A history item. Skips were feedback items in earlier versions, and old histories still hold them. */
type HistoryItem = ConversationItem | { kind: "skip"; id: string; title: string; skipped: boolean };

const root = document.documentElement;

const STAGE_NOTES: Record<string, string> = {
  decisions: "Answer what you can, then submit. The agent writes the plan from your answers.",
  drafting: "Your decisions are in. The agent is writing the plan; this page updates when it is ready.",
  plan_review:
    "Read the plan, comment on anything you would change, and answer the open questions. Send feedback to iterate, or approve it as it stands.",
  slicing: "The plan is approved. The agent is breaking it into vertical slices and tasks.",
  slices_review: "Review how the work is sliced. Each slice should deliver something a user can see working.",
  approved: "The plan and its slices are approved and ready to build.",
};
const BUILD_NOW_NOTE = "The plan is approved. You chose to skip slicing, so the agent builds from the plan now.";

const PRESENCE = {
  listening: "Agent listening",
  working: "Agent working",
  away: "Agent not listening",
};

// --- elements ---

const nextOption = (next: string, title: string, detail: string) =>
  el("button", { class: "spr-next-option", type: "button", "data-next": next }, [
    el("strong", { text: title }),
    el("span", { text: detail }),
  ]);

export const ui = {
  presenceDot: el("span", { class: "spr-presence-dot" }),
  presenceText: el("span", { class: "spr-presence-text" }),
  stageNote: el("p", { class: "spr-stage-note" }),
  banner: el("div", { class: "spr-banner", role: "status", hidden: true }),
  history: el("div", { class: "spr-history" }),
  drafts: el("div", { class: "spr-drafts" }),
  draftCount: el("span", { class: "spr-draft-count" }),
  message: el("textarea", {
    class: "spr-message",
    name: "message",
    rows: "3",
    placeholder: "Anything else for the agent?",
  }),
  send: el("button", { class: "spr-button spr-button-primary", type: "button", text: "Send feedback" }),
  approve: el("button", { class: "spr-button spr-button-approve", type: "button", text: "Approve plan" }),
  sliceOption: nextOption(
    "slices",
    "Slice it first",
    "The agent breaks the plan into vertical slices and tasks for you to review before anything is built.",
  ),
  buildOption: nextOption(
    "build",
    "Build now",
    "Skip slicing. The review closes and the agent starts building from this plan.",
  ),
  cancelChoice: el("button", { class: "spr-link-button", type: "button", text: "Cancel" }),
  hint: el("p", { class: "spr-hint", role: "status" }),
  end: el("button", { class: "spr-link-button", type: "button", text: "End review" }),
  status: el("p", { class: "spr-status", role: "status", "aria-live": "polite" }),
  progressBar: el("span", { class: "spr-progress-fill" }),
  progressText: el("span", { class: "spr-progress-text" }),
  closing: el("div", { class: "spr-closing", hidden: true }),
  fabCount: el("span", { class: "spr-fab-count" }),
};

export const nextChoice = el(
  "div",
  { class: "spr-next", role: "group", "aria-label": "After approving the plan", hidden: true },
  [
    el("div", { class: "spr-section-head" }, [el("span", { text: "Approve the plan, then" }), ui.cancelChoice]),
    ui.sliceOption,
    ui.buildOption,
  ],
);
const draftSection = el("section", { class: "spr-draft-section" }, [
  el("div", { class: "spr-section-head" }, [el("span", { text: "Your review" }), ui.draftCount]),
  ui.drafts,
]);
const progress = el("section", { class: "spr-progress", hidden: true }, [
  el("div", { class: "spr-section-head" }, [el("span", { text: "Key decisions" })]),
  el("div", { class: "spr-progress-track" }, [ui.progressBar]),
  ui.progressText,
]);
const actions = el("div", { class: "spr-actions" }, [ui.approve, ui.send]);
const composer = el("div", { class: "spr-composer" }, [
  nextChoice,
  ui.message,
  actions,
  ui.hint,
  el("div", { class: "spr-foot" }, [ui.status, ui.end]),
]);
export const panelScroll = el("div", { class: "spr-panel-scroll" }, [
  ui.stageNote,
  ui.banner,
  progress,
  ui.history,
  draftSection,
]);
const fab = el("button", { class: "spr-fab", type: "button", onclick: () => root.classList.add("spr-panel-open") }, [
  el("span", { html: ICONS.comment }),
  el("span", { text: "Review" }),
  ui.fabCount,
]);

export function mountPanel(): void {
  root.classList.add("sp-review");
  ui.message.value = load("message", "");
  const panel = el("aside", { class: "spr-panel", "aria-label": "Review" }, [
    el("header", { class: "spr-panel-head" }, [
      el("h2", { class: "spr-panel-title", text: "Review" }),
      el("span", { class: "spr-presence" }, [ui.presenceDot, ui.presenceText]),
      el("button", {
        class: "spr-icon-button spr-panel-close",
        type: "button",
        "aria-label": "Close review panel",
        html: ICONS.close,
        onclick: () => root.classList.remove("spr-panel-open"),
      }),
    ]),
    panelScroll,
    composer,
    ui.closing,
  ]);
  const scrim = el("div", { class: "spr-scrim", onclick: () => root.classList.remove("spr-panel-open") });
  document.body.append(scrim, panel, fab);
}

// --- status and banner ---

export function setStatus(text: string, tone?: "ok" | "error"): void {
  ui.status.textContent = text;
  ui.status.className = `spr-status${tone ? ` spr-status-${tone}` : ""}`;
}

/**
 * Shows a banner above the conversation, or hides it for null. `kind` names the condition it
 * reports (such as "offline"), so it can be cleared when that condition ends.
 */
export function showBanner(text: string | string[] | null, tone?: "info" | "warn", kind?: string): void {
  ui.banner.replaceChildren(...(text === null ? [] : [text].flat().map((line) => el("div", { text: line }))));
  ui.banner.hidden = text === null;
  ui.banner.className = `spr-banner${tone ? ` spr-banner-${tone}` : ""}`;
  ui.banner.toggleAttribute("data-kind", Boolean(kind));
  if (kind) ui.banner.dataset.kind = kind;
}

// --- rendering ---

/** Why the reviewer cannot approve yet, or null. The server enforces the same rules. */
function approvalBlocker(pending: number): string | null {
  if (state.ended) return "This review has ended.";
  if (!review.stage?.phase) return null;
  const open = review.questions;
  if (open.length && open.every(answeredEarlier)) {
    return "Your answers are with the agent. Approve once it has folded them into the plan.";
  }
  if (open.length === 1) {
    return "One open question remains. Answer it and send; the agent folds your answer into the plan before you approve.";
  }
  if (open.length) {
    return `${open.length} open questions remain. Answer them and send; the agent folds your answers into the plan before you approve.`;
  }
  if (pending)
    return "Send or remove your pending notes before approving. Approval means the plan is right as it stands.";
  return null;
}

export function renderPanel(): void {
  const { ended, sending } = state;
  const stage = review.stage;
  const drafts = renderDrafts();
  const pending = drafts + (ui.message.value.trim() ? 1 : 0);
  ui.fabCount.textContent = pending ? String(pending) : "";
  fab.classList.toggle("spr-fab-active", pending > 0);

  ui.presenceDot.className = `spr-presence-dot spr-presence-${ended ? "ended" : state.presence}`;
  ui.presenceText.textContent = ended ? "Review ended" : PRESENCE[state.presence];

  ui.stageNote.textContent = ended
    ? ""
    : (stage?.slicesSkipped && BUILD_NOW_NOTE) || STAGE_NOTES[stage?.stage ?? ""] || "";
  ui.stageNote.hidden = !ui.stageNote.textContent;

  const counts = decisionCounts();
  if (inDecisions) {
    ui.send.disabled = ended || sending;
    ui.send.textContent = `Submit decisions · ${counts.answered} of ${counts.total}`;
  } else {
    ui.send.disabled = ended || sending || pending === 0;
    ui.send.textContent = pending ? `Send feedback · ${pending}` : "Send feedback";
  }
  ui.message.disabled = ended;

  const phase = stage?.phase ?? null;
  const blocker = approvalBlocker(pending);
  ui.approve.hidden = !phase || phase === "decisions" || ended;
  ui.approve.disabled = Boolean(blocker) || sending;
  ui.approve.textContent = phase === "slices" ? "Approve slices" : "Approve plan";
  if (blocker || phase !== "plan") state.choosingNext = false;
  nextChoice.hidden = !state.choosingNext;
  ui.message.hidden = state.choosingNext;
  actions.hidden = state.choosingNext;
  ui.sliceOption.disabled = ui.buildOption.disabled = sending;

  if (inDecisions) {
    ui.hint.textContent = counts.answered
      ? "Unanswered decisions are left to the agent."
      : "Every decision is optional. Submitting with none answered leaves them all to the agent.";
  } else {
    ui.hint.textContent = (phase && blocker) || "";
  }
  ui.hint.hidden = !ui.hint.textContent || state.choosingNext;

  ui.end.hidden = ended;
  ui.end.textContent = Date.now() < state.endArmedUntil ? "Click again to end the review" : "End review";
  root.classList.toggle("spr-ended", ended);
  composer.hidden = ended;
  ui.closing.hidden = !ended;
  if (ended) renderClosing();
  draftSection.hidden = (ended || inDecisions) && drafts === 0;

  progress.hidden = !inDecisions;
  if (inDecisions) {
    ui.progressBar.style.width = `${counts.total ? (100 * counts.answered) / counts.total : 0}%`;
    ui.progressText.textContent = `${counts.answered} of ${counts.total} answered${counts.answered < counts.total ? " · the rest are the agent's call" : ""}`;
  }
}

function renderClosing(): void {
  const approved = state.endedBy === "approval";
  const [title, detail] = !approved
    ? ["Review ended", "Return to your agent to continue. Comments you had not sent are kept on this page."]
    : review.stage?.slicesSkipped
      ? ["Approved · building now", "The plan is approved without slices. The agent is building it now."]
      : ["Approved · ready to build", "The plan and its slices are approved. The agent takes it from here."];
  ui.closing.replaceChildren(el("strong", { text: title }), el("span", { text: detail }));
  ui.closing.classList.toggle("spr-closing-approved", approved);
}

// --- the conversation ---

export function renderHistory(): void {
  ui.history.replaceChildren(...state.history.flatMap(historyEntry));
  ui.history.hidden = state.history.length === 0;
}

function historyEntry(entry: RenderedHistoryEntry): HTMLElement[] {
  if (entry.role === "agent") {
    return [
      el("article", { class: "spr-bubble spr-bubble-agent" }, [
        el("span", { class: "spr-bubble-who", text: "Agent" }),
        el("div", { class: "spr-bubble-body sp-md", html: entry.html ?? "" }),
      ]),
    ];
  }
  if (entry.kind === "approval") {
    const text =
      entry.phase === "slices"
        ? "You approved the slices"
        : entry.next === "build"
          ? "You approved the plan · build now"
          : "You approved the plan";
    return [el("div", { class: "spr-event", text })];
  }
  const nodes: HTMLElement[] = [];
  if (entry.kind === "decisions") {
    nodes.push(
      el("div", {
        class: "spr-event",
        text: `You submitted key decisions · ${entry.answered} of ${entry.total} answered`,
      }),
    );
    if (!entry.items.length) return nodes;
  }
  const items: HistoryItem[] = entry.items;
  nodes.push(
    el("article", { class: "spr-bubble spr-bubble-you" }, [
      el("span", { class: "spr-bubble-who", text: `You · ${items.length} item${items.length === 1 ? "" : "s"}` }),
      el(
        "ul",
        { class: "spr-bubble-items" },
        items.map((item) => el("li", { text: historyItemText(item) })),
      ),
    ]),
  );
  return nodes;
}

function historyItemText(item: HistoryItem): string {
  switch (item.kind) {
    case "comment":
      return (item.target ? `${item.target.label}: ` : "") + item.text;
    case "answer":
      return `${item.question}: ${item.choice_label ?? item.other ?? item.choice ?? ""}${item.note ? ` (${item.note})` : ""}`;
    case "message":
      return item.text;
    case "skip":
      return `${item.skipped ? "Skipped" : "Restored"} ${item.id}: ${item.title}`;
  }
}

// --- unsent notes ---

/** Redraws the pending comments and answers, and marks commented targets. Returns how many. */
function renderDrafts(): number {
  const comments = state.drafts.map((draft) => {
    const node = targetNode(draft.target.path);
    return draftCard({
      target: draft.target.label,
      orphan: !node,
      quote: draft.quote,
      text: draft.text,
      onOpen() {
        if (!node) return;
        revealTarget(node);
        openCard({ target: draft.target, anchor: node, draft });
      },
      onRemove() {
        state.drafts = state.drafts.filter((d) => d !== draft);
        save("drafts", state.drafts);
        changed();
      },
    });
  });
  const answers = completeAnswers().map((answer) => {
    const article = document.querySelector(`.sp-question[data-sp-question="${CSS.escape(answer.question)}"]`);
    const choice = answer.choice === null ? (answer.other ?? "") : optionLabel(article, answer.choice);
    return draftCard({
      target: `${answer.question} answer`,
      text: choice + (answer.note ? ` · ${answer.note}` : ""),
      onOpen() {
        if (article) revealTarget(article);
      },
    });
  });
  const pieces = [...comments, ...answers];
  const touch = window.matchMedia("(hover: none)").matches;
  const empty = el("p", {
    class: "spr-empty",
    text: state.ended
      ? "This review has ended."
      : `${touch ? "Tap" : "Hover over"} any part of the plan and choose Comment, or select text to quote it.`,
  });
  ui.drafts.replaceChildren(...(pieces.length ? pieces : [empty]));
  ui.draftCount.textContent = pieces.length ? String(pieces.length) : "";
  for (const node of document.querySelectorAll(".spr-has-draft")) node.classList.remove("spr-has-draft");
  for (const draft of state.drafts) targetNode(draft.target.path)?.classList.add("spr-has-draft");
  return pieces.length;
}

/** A pending comment (removable) or answer in the panel. */
function draftCard(options: {
  target: string;
  text: string;
  onOpen: () => void;
  onRemove?: () => void;
  quote?: string;
  orphan?: boolean;
}): HTMLElement {
  const { target, text, onOpen, onRemove, quote, orphan } = options;
  return el(
    "article",
    { class: `spr-draft${orphan ? " spr-draft-orphan" : ""}${onRemove ? "" : " spr-draft-answer"}` },
    [
      el("div", { class: "spr-draft-head" }, [
        el("button", {
          class: "spr-draft-target",
          type: "button",
          text: target,
          title: orphan ? "This part of the plan changed since you wrote the comment" : "Show in plan",
          onclick: onOpen,
        }),
        onRemove &&
          el("button", {
            class: "spr-icon-button",
            type: "button",
            "aria-label": "Remove comment",
            html: ICONS.close,
            onclick: onRemove,
          }),
      ]),
      quote ? el("blockquote", { class: "spr-quote", text: quote }) : null,
      el("p", { class: "spr-draft-text", text }),
    ],
  );
}

/** An option's label as the reviewer saw it, without the Recommended pill. */
function optionLabel(article: Element | null, choice: string): string {
  const input = article?.querySelector(`input[type="radio"][value="${CSS.escape(choice)}"]`);
  const label = input?.closest(".sp-option")?.querySelector(".sp-option-label");
  if (!label) return choice;
  const copy = label.cloneNode(true) as Element;
  for (const pill of copy.querySelectorAll(".sp-rec")) pill.remove();
  return copy.textContent?.trim() ?? choice;
}

function revealTarget(node: Element): void {
  const panelNode = node.closest<HTMLElement>(".sp-panel");
  if (panelNode?.dataset.panel) window.coplan?.selectTab(panelNode.dataset.panel, { updateHash: true });
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  root.classList.remove("spr-panel-open");
}
