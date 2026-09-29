// Everything that crosses a process boundary, typed once: what the review page sends the server,
// what the server pushes to the page, what a poll hands the CLI, and what the review record on
// disk holds. The server, the CLI and the browser client all import these types, so a field one
// side sends and the other never reads shows up as a type error instead of silent drift.
//
// Types only: the browser client imports this file too, and must not pull in runtime code.

export type StageName = "decisions" | "drafting" | "plan_review" | "slicing" | "slices_review" | "approved";
/** The checkpoint currently open for the reviewer, if any. */
export type Phase = "decisions" | "plan" | "slices";

/** Where a plan is in its review; derived by `deriveStage`, never declared by the plan. */
export interface Stage {
  stage: StageName;
  label: string;
  phase: Phase | null;
  decisionsHash: string;
  planHash: string;
  /** Null until the plan has slices. */
  slicesHash: string | null;
  decisionsSubmitted: boolean;
  /** The decisions changed after the reviewer answered them. */
  decisionsStale: boolean;
  decisionsSubmittedAt: string | null;
  planApproved: boolean;
  /** The plan changed after the reviewer approved it. */
  planApprovalStale: boolean;
  planApprovedAt: string | null;
  /** The reviewer approved the plan to build now, without slices. */
  slicesSkipped: boolean;
  slicesApproved: boolean;
  slicesApprovalStale: boolean;
  slicesApprovedAt: string | null;
}

export type Presence = "listening" | "working" | "away";
export type EndedBy = "user" | "agent" | "approval";
export type ApprovalPhase = "plan" | "slices";
/** What the reviewer chose to do after approving the plan. */
export type NextStep = "slices" | "build";

/** A reviewer's answer to one key decision: any chosen option ids, plus optional free text. */
export interface DecisionAnswer {
  choices: string[];
  other?: string;
}

/** The part of the plan a comment points at. `path` is a JSON path into plan.json. */
export interface CommentTarget {
  path: string;
  kind: string;
  label: string;
  id?: string;
}

// --- feedback items: what the agent receives ---

export interface CommentItem {
  kind: "comment";
  target: CommentTarget | null;
  quote?: string;
  text: string;
}

export interface AnswerItem {
  kind: "answer";
  question: string;
  question_text: string;
  choice?: string;
  choice_label?: string;
  other?: string;
  note?: string;
}

export interface MessageItem {
  kind: "message";
  text: string;
}

export interface AnsweredDecision {
  decision: string;
  question: string;
  aspect: string;
  select: "single" | "multiple";
  choices: { id: string; label: string }[];
  other?: string;
}

export interface UnansweredDecision {
  decision: string;
  question: string;
  aspect: string;
  select: "single" | "multiple";
  recommended?: string[];
}

export interface DecisionsItem {
  kind: "decisions";
  answered: AnsweredDecision[];
  unanswered: UnansweredDecision[];
}

export interface ApprovalItem {
  kind: "approval";
  phase: ApprovalPhase;
  hash: string;
  next?: NextStep;
}

/** What the reviewer said in the conversation: comments, question answers, a free-text message. */
export type ConversationItem = CommentItem | AnswerItem | MessageItem;
export type FeedbackItem = ConversationItem | DecisionsItem | ApprovalItem;

// --- the review record: `<plan>.review.json`, written only by the server ---

export interface HistoryBase {
  id: string;
  at: string;
}

/** What a history entry says; the store adds its id and timestamp. */
export type HistoryContent =
  | { role: "agent"; kind: "reply"; text: string }
  | { role: "reviewer"; kind: "feedback"; items: ConversationItem[] }
  | { role: "reviewer"; kind: "decisions"; answered: number; total: number; items: ConversationItem[] }
  | { role: "reviewer"; kind: "approval"; phase: ApprovalPhase; next?: NextStep };

export type HistoryEntry = HistoryBase & HistoryContent;

/** A history entry as the page receives it: agent replies carry their Markdown rendered to HTML. */
export type RenderedHistoryEntry = HistoryEntry & { html?: string };

/** Feedback the agent has not acknowledged yet. Delivery is at-least-once, by batch. */
export interface FeedbackBatch {
  id: string;
  at: string;
  items: FeedbackItem[];
}

export interface Approval {
  hash: string;
  at: string;
}

export interface ReviewRecord {
  version: 1;
  /** The reviewer's decision answers, bound to the decisions they were given against. */
  decisions?: Approval & { answers: Record<string, DecisionAnswer> };
  approvals: {
    plan?: Approval & { next?: NextStep };
    slices?: Approval;
  };
  /** Edge cases, risks and gaps the reviewer skipped, by id. */
  skips: Record<string, { at: string }>;
  queue: FeedbackBatch[];
  history: HistoryEntry[];
}

// --- browser → server ---

/** A comment or answer as the page sends it, before the server validates and enriches it. */
export type DraftItem =
  | { kind: "comment"; target: CommentTarget | null; quote?: string; text: string }
  | { kind: "answer"; question: string; choice: string | null; note?: string; other?: string }
  | { kind: "message"; text: string };

export interface FeedbackRequest {
  items: DraftItem[];
}

export interface DecisionsRequest {
  hash: string;
  answers: Record<string, DecisionAnswer>;
  items: DraftItem[];
}

export interface SkipRequest {
  id: string;
  skip: boolean;
}

export interface ApproveRequest {
  phase: ApprovalPhase;
  hash: string;
  next?: NextStep;
}

// --- server → browser ---

/** Everything a page needs at load, embedded in the served HTML. */
export interface Bootstrap {
  key: string;
  ended: boolean;
  ended_by: EndedBy | null;
  presence: Presence;
  history: RenderedHistoryEntry[];
  /** Identifies the plan version the page shows; see `planSignature`. */
  signature: string;
}

export interface ReviewBootstrap extends Bootstrap {
  stage: Stage;
  /** Ids of the questions still open in the plan. */
  questions: string[];
  /** Ids of the plan's key decisions. */
  decisions: string[];
  answers: Record<string, DecisionAnswer>;
}

export type InvalidBootstrap = Bootstrap & { invalid: true };

export type ServerMessage =
  | {
      type: "hello";
      presence: Presence;
      ended: boolean;
      ended_by: EndedBy | null;
      history: RenderedHistoryEntry[];
      signature: string;
    }
  | { type: "reload" }
  | { type: "presence"; presence: Presence }
  | { type: "history"; history: RenderedHistoryEntry[] }
  | { type: "skips"; skips: string[] }
  | { type: "invalid"; errors: { path: string; message: string }[] }
  | { type: "ended"; ended_by: EndedBy };

// --- server → CLI ---

/** The plan state a poll reports alongside feedback: what the CLI needs to write its next step. */
export type PollStage =
  | { stage: Stage["stage"]; slices_skipped: boolean; skipped: { id: string; title: string | null }[] }
  | { stage: "invalid"; errors: { path: string; message: string }[] };

/** What `coplan poll` sends: the plan, and how long to wait before answering `waiting`. */
export interface PollRequest {
  file: string;
  wait_ms: number;
}

export type PollResponse =
  | { status: "feedback"; batch_ids: string[]; items: (FeedbackItem & { sent_at: string })[]; stage: PollStage }
  | { status: "ended"; ended_by: EndedBy | null; stage: PollStage }
  | { status: "waiting" | "replaced" | "server_stopped" | "missing" };
