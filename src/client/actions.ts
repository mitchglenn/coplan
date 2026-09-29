// What the panel's buttons do: send feedback, submit decisions, approve, end the review.

import type { ApproveRequest, DraftItem, NextStep } from "../protocol.ts";
import { reloadPreservingView } from "./connection.ts";
import { decisionPayload, inDecisions } from "./decisions.ts";
import { post } from "./dom.ts";
import { nextChoice, setStatus, ui } from "./panel.ts";
import { completeAnswers } from "./questions.ts";
import { changed, endReview, review, save, state } from "./store.ts";

/** An approve or submit whose page is out of date reloads after the reviewer reads why. */
const STALE_RELOAD_MS = 1200;
/** How long a first click on End review waits for the confirming second one. */
const END_CONFIRM_MS = 4000;

/** The comments and message the reviewer has written, as feedback items. */
function writtenItems(): DraftItem[] {
  const text = ui.message.value.trim();
  return [
    ...state.drafts.map((d): DraftItem => ({
      kind: "comment",
      target: d.target,
      ...(d.quote ? { quote: d.quote } : {}),
      text: d.text,
    })),
    ...(text ? [{ kind: "message" as const, text }] : []),
  ];
}

function clearWritten(): void {
  state.drafts = [];
  ui.message.value = "";
  save("drafts", state.drafts);
  save("message", "");
}

/** Runs one request with the send controls disabled, re-rendering however it ends. */
async function whileSending(request: () => Promise<void>): Promise<void> {
  state.sending = true;
  changed();
  try {
    await request();
  } finally {
    state.sending = false;
    changed();
  }
}

async function submitDecisions(): Promise<void> {
  setStatus("Submitting…");
  await whileSending(async () => {
    try {
      const result = await post(`/api/${review.key}/decisions`, {
        hash: review.stage.decisionsHash,
        answers: decisionPayload(),
        items: writtenItems(),
      });
      if (result.ok) {
        clearWritten();
        save("decisions", undefined);
        setStatus("Submitted. The agent is writing the plan.", "ok");
        reloadPreservingView();
        return;
      }
      setStatus(result.data.error ?? "Could not submit. Your answers are kept.", "error");
      if (result.data.reload) setTimeout(reloadPreservingView, STALE_RELOAD_MS);
    } catch {
      setStatus("Could not reach Coplan. Your answers are kept; try again.", "error");
    }
  });
}

async function send(): Promise<void> {
  if (state.sending || state.ended) return;
  if (inDecisions) return submitDecisions();
  const items = [...writtenItems(), ...completeAnswers()];
  if (!items.length) return;
  setStatus("Sending…");
  await whileSending(async () => {
    try {
      const result = await post(`/api/${review.key}/feedback`, { items });
      if (result.ok) {
        clearWritten();
        state.answers = {};
        save("answers", state.answers);
        setStatus(
          result.data.delivered_to_listener
            ? "Sent. The agent has it."
            : "Sent. The agent picks it up when it next checks in.",
          "ok",
        );
      } else if (result.status === 409) {
        setStatus("This review has ended; your notes were not sent.", "error");
        endReview(state.endedBy);
      } else {
        setStatus(result.data.error ?? "Could not send. Your notes are kept.", "error");
      }
    } catch {
      setStatus("Could not reach Coplan. Your notes are kept; try again.", "error");
    }
  });
}

async function approve(body: ApproveRequest): Promise<void> {
  await whileSending(async () => {
    try {
      const result = await post(`/api/${review.key}/approve`, body);
      if (result.ok) {
        setStatus("Approved.", "ok");
        reloadPreservingView();
        return;
      }
      state.choosingNext = false;
      setStatus(result.data.error ?? "Could not approve.", "error");
      if (result.data.reload) setTimeout(reloadPreservingView, STALE_RELOAD_MS);
    } catch {
      state.choosingNext = false;
      setStatus("Could not reach Coplan.", "error");
    }
  });
}

/** Ending takes two clicks: the first arms the button for a few seconds. */
async function end(): Promise<void> {
  if (Date.now() >= state.endArmedUntil) {
    state.endArmedUntil = Date.now() + END_CONFIRM_MS;
    changed();
    setTimeout(changed, END_CONFIRM_MS + 100);
    return;
  }
  state.endArmedUntil = 0;
  try {
    const result = await post(`/api/${review.key}/end`);
    if (result.ok || result.status === 409) endReview("user");
    else setStatus(result.data.error ?? "Could not end the review.", "error");
  } catch {
    setStatus("Could not reach Coplan; the review is still open.", "error");
  }
  changed();
}

export function wireActions(): void {
  ui.message.addEventListener("input", () => {
    save("message", ui.message.value);
    changed();
  });
  ui.message.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  });
  ui.send.addEventListener("click", () => void send());

  // Approving the plan asks what comes next; approving slices is final at once.
  ui.approve.addEventListener("click", () => {
    if (ui.approve.disabled) return;
    if (review.stage.phase === "plan") {
      state.choosingNext = true;
      changed();
      ui.sliceOption.focus();
    } else if (review.stage.phase === "slices" && review.stage.slicesHash) {
      void approve({ phase: "slices", hash: review.stage.slicesHash });
    }
  });
  for (const option of [ui.sliceOption, ui.buildOption]) {
    option.addEventListener("click", () => {
      if (!option.disabled)
        void approve({ phase: "plan", hash: review.stage.planHash, next: option.dataset.next as NextStep });
    });
  }
  const closeChoice = () => {
    state.choosingNext = false;
    changed();
    ui.approve.focus();
  };
  ui.cancelChoice.addEventListener("click", closeChoice);
  nextChoice.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeChoice();
  });

  ui.end.addEventListener("click", () => void end());
}
