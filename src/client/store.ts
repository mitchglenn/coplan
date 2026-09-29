// The review page's state. Everything that changes lives in `state`; whatever changes it calls
// `changed()`, which re-renders the panel and re-syncs every wired control. Unsent work (drafts,
// answers, the message) is kept in localStorage so a reload or a closed tab never loses it.

import type {
  CommentTarget,
  DecisionAnswer,
  EndedBy,
  InvalidBootstrap,
  Presence,
  RenderedHistoryEntry,
  ReviewBootstrap,
} from "../protocol.ts";

export const boot = JSON.parse(document.getElementById("sp-bootstrap")?.textContent || "{}") as
  ReviewBootstrap | InvalidBootstrap;

export const isInvalidPage = (b: ReviewBootstrap | InvalidBootstrap): b is InvalidBootstrap => "invalid" in b;

// --- persistence ---

export const storageKey = (name: string) => `coplan:${name}:${boot.key}`;

export function load<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(name));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Saves a value, or removes it when `value` is undefined. */
export function save(name: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(storageKey(name));
    else localStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private windows); drafts then live only as long as the page.
  }
}

// --- state ---

export interface Draft {
  id: string;
  kind: "comment";
  target: CommentTarget;
  quote?: string;
  text: string;
}

/** An unsent answer to an open question: a chosen option with an optional note, or free text. */
export type QuestionAnswer = { choice: string; note: string } | { choice: null; other: string };

/** An unsent decision answer; `otherOn` keeps the free-text box open while it is still empty. */
export interface DecisionDraft extends DecisionAnswer {
  otherOn?: boolean;
}

export interface State {
  drafts: Draft[];
  /** By question id. */
  answers: Record<string, QuestionAnswer>;
  /** By decision id. */
  decisionAnswers: Record<string, DecisionDraft>;
  ended: boolean;
  endedBy: EndedBy | null;
  presence: Presence;
  history: RenderedHistoryEntry[];
  sending: boolean;
  /** Approving the plan asks what comes next: slices to review, or building straight away. */
  choosingNext: boolean;
  /** The plan changed while a comment was half-written; reload once the card closes. */
  pendingReload: boolean;
  /** Ending the review takes a second click within this deadline. */
  endArmedUntil: number;
}

/** The page's review data. Only meaningful on a plan page, not the invalid-plan page. */
export const review = boot as ReviewBootstrap;

export const state: State = {
  // Skips were drafts in earlier versions; they are plan state now.
  drafts: load<(Draft | { kind: "skip" })[]>("drafts", []).filter((d): d is Draft => d.kind === "comment"),
  answers: load("answers", {}),
  // Unsent answers win; otherwise start from what the reviewer submitted last time (the decisions
  // re-open when the agent changes them after submission).
  decisionAnswers: load<Record<string, DecisionDraft> | null>("decisions", null) ?? review.answers ?? {},
  ended: boot.ended,
  endedBy: boot.ended_by,
  presence: boot.presence,
  history: boot.history,
  sending: false,
  choosingNext: false,
  pendingReload: false,
  endArmedUntil: 0,
};

// Drop answers for questions the agent has since resolved.
for (const id of Object.keys(state.answers)) {
  if (!review.questions?.includes(id)) delete state.answers[id];
}

// --- change notification ---

const listeners: (() => void)[] = [];

/** Runs `listener` on every change, in the order listeners were added. */
export function onChange(listener: () => void): void {
  listeners.push(listener);
}

export function changed(): void {
  for (const listener of listeners) listener();
}

export function endReview(by: EndedBy | null): void {
  state.ended = true;
  state.endedBy = by;
  changed();
}
