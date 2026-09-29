/* The review client. The server serves it only with a page opened for review; a saved plan.html
 * never loads it, so the document itself stays a static, portable file.
 *
 * The page's markup comes from the server-rendered plan. This module layers the review on top:
 *
 *   store.ts       state, persistence, and change notification
 *   panel.ts       the review panel, redrawn from state on every change
 *   actions.ts     send, approve, end
 *   comments.ts    commenting on any part of the plan
 *   decisions.ts   the key-decisions questionnaire
 *   questions.ts   open questions
 *   skips.ts       skipping edge cases, risks and gaps
 *   connection.ts  live updates from the server
 */

import type { ServerMessage } from "../protocol.ts";
import { wireActions } from "./actions.ts";
import { cardHasText, wireComments } from "./comments.ts";
import { reloadPreservingView, restoreScroll, connect } from "./connection.ts";
import { wireDecisions } from "./decisions.ts";
import { mountPanel, panelScroll, renderHistory, renderPanel, showBanner, ui } from "./panel.ts";
import { wireQuestions } from "./questions.ts";
import { applySkips, wireSkips } from "./skips.ts";
import { boot, changed, endReview, isInvalidPage, onChange, state } from "./store.ts";

if (isInvalidPage(boot)) {
  // The plan does not validate yet; this page only waits for the agent to fix it.
  connect({
    onMessage(message) {
      if (message.type === "reload" || (message.type === "hello" && message.signature !== boot.signature))
        reloadPreservingView();
    },
  });
} else {
  start();
}

function start(): void {
  mountPanel();
  onChange(renderPanel);
  wireComments();
  wireQuestions();
  wireDecisions();
  wireSkips();
  wireActions();
  renderHistory();
  changed();
  restoreScroll();
  panelScroll.scrollTop = panelScroll.scrollHeight;
  document.addEventListener("sp:tab", changed);
  if (!state.ended) connect({ onMessage: handle, onConnected, onDisconnected });
}

/** The plan changed. Reload, unless the reviewer is halfway through a comment. */
function reloadForUpdate(): void {
  if (cardHasText()) {
    showBanner("The agent updated the plan. Add or cancel your comment, and the page will refresh.", "info");
    state.pendingReload = true;
    return;
  }
  reloadPreservingView();
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "reload":
      return reloadForUpdate();
    case "hello":
      if (message.signature !== boot.signature) return reloadForUpdate();
      return updateSession(message);
    case "presence":
      return updateSession(message);
    case "history":
      state.history = message.history;
      renderHistory();
      changed();
      panelScroll.scrollTop = panelScroll.scrollHeight;
      return;
    case "skips":
      return applySkips(message.skips);
    case "invalid":
      return showBanner(
        [
          "The agent's latest edit does not validate yet, so you are looking at the previous version.",
          ...message.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
        ],
        "warn",
      );
    case "ended":
      return endReview(message.ended_by);
  }
}

function updateSession(message: Extract<ServerMessage, { type: "hello" | "presence" }>): void {
  state.presence = message.presence;
  if ("history" in message) {
    state.history = message.history;
    renderHistory();
  }
  if ("ended" in message && message.ended) endReview(message.ended_by);
  else changed();
}

function onConnected(): void {
  if (ui.banner.dataset.kind === "offline") showBanner(null);
}

function onDisconnected(): void {
  showBanner(
    "Lost the connection to Coplan. Your notes are kept; this page reconnects when it can.",
    "warn",
    "offline",
  );
}
