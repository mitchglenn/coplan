// What happens to a review, independent of how it was asked for: feedback is queued and the agent
// woken, replies join the conversation, pages hear about every change. Routes translate HTTP into
// these calls; this class keeps the store, the waiting polls and the open pages in step.

import { randomUUID } from "node:crypto";
import { loadPlan, renderLoaded, type LoadResult } from "../engine.ts";
import { skippableRecords } from "../plan/metrics.ts";
import type {
  ApprovalPhase,
  DecisionAnswer,
  EndedBy,
  FeedbackItem,
  NextStep,
  HistoryContent,
  PollResponse,
  PollStage,
  RenderedHistoryEntry,
  ReviewRecord,
  ServerMessage,
} from "../protocol.ts";
import { md } from "../render/markdown.ts";
import { appendHistory, htmlPathFor, writeFileAtomic, type ReviewStore } from "../review-store.ts";
import type { EventHub } from "./events.ts";
import type { PollHub } from "./polls.ts";
import type { Session, SessionRegistry } from "./sessions.ts";

export class ReviewService {
  readonly #store: ReviewStore;
  readonly #sessions: SessionRegistry;
  readonly #polls: PollHub;
  readonly #events: EventHub;

  constructor(parts: { store: ReviewStore; sessions: SessionRegistry; polls: PollHub; events: EventHub }) {
    this.#store = parts.store;
    this.#sessions = parts.sessions;
    this.#polls = parts.polls;
    this.#events = parts.events;
  }

  /** The plan on disk with the latest review record. */
  async load(session: Session): Promise<LoadResult> {
    return loadPlan(session.file, { review: await this.#store.read(session.file) });
  }

  /**
   * Queues items for the agent, records the conversation, and wakes a waiting poll. Returns
   * whether the agent was listening when the items arrived.
   */
  async deliver(session: Session, items: FeedbackItem[], entry: HistoryContent): Promise<boolean> {
    const listening = this.#polls.isListening(session.key);
    await this.#store.update(session.file, (review) => {
      review.queue.push({ id: randomUUID(), at: new Date().toISOString(), items });
      appendHistory(review, entry);
    });
    await this.#broadcastHistory(session);
    void this.#polls.wake(session.key);
    return listening;
  }

  /** Records the reviewer's decision answers against the decisions they saw. */
  async recordDecisions(session: Session, hash: string, answers: Record<string, DecisionAnswer>): Promise<void> {
    await this.#store.update(session.file, (review) => {
      review.decisions = { hash, at: new Date().toISOString(), answers };
    });
  }

  /** Records an approval of exactly the content with this hash. */
  async recordApproval(session: Session, phase: ApprovalPhase, hash: string, next: NextStep | null): Promise<void> {
    await this.#store.update(session.file, (review) => {
      const at = new Date().toISOString();
      if (phase === "plan") review.approvals.plan = { hash, at, ...(next ? { next } : {}) };
      else review.approvals.slices = { hash, at };
    });
  }

  /** Skips or restores an item, saved at once and shown on every open page. Returns the skipped ids. */
  async setSkip(session: Session, id: string, skip: boolean): Promise<string[]> {
    const skips = await this.#store.update(session.file, (review) => {
      if (skip) review.skips[id] = { at: new Date().toISOString() };
      else delete review.skips[id];
      return Object.keys(review.skips);
    });
    await this.rewriteHtml(session);
    this.#events.broadcast(session.key, { type: "skips", skips });
    return skips;
  }

  /** Removes the batches the agent has read. Returns how many remain. */
  acknowledge(session: Session, batchIds: string[]): Promise<number> {
    const ids = new Set(batchIds);
    return this.#store.update(session.file, (review) => {
      review.queue = review.queue.filter((batch) => !ids.has(batch.id));
      return review.queue.length;
    });
  }

  async reply(session: Session, text: string): Promise<void> {
    await this.#store.update(session.file, (review) => appendHistory(review, { role: "agent", kind: "reply", text }));
    this.#polls.markReplied(session.key);
    await this.#broadcastHistory(session);
    this.broadcastPresence(session.key);
  }

  async end(session: Session, by: EndedBy): Promise<void> {
    if (!(await this.#sessions.end(session, by))) return;
    this.#events.broadcast(session.key, { type: "ended", ended_by: by });
    void this.#polls.wake(session.key);
  }

  /** Writes the portable plan.html again after the plan or its review record changed. */
  async rewriteHtml(session: Session): Promise<LoadResult> {
    const loaded = await this.load(session);
    if (loaded.ok) await writeFileAtomic(htmlPathFor(session.file), renderLoaded(loaded, session.file));
    return loaded;
  }

  /** The agent saved the plan: re-render it and tell open pages to reload, or show why it is invalid. */
  async planChanged(session: Session): Promise<void> {
    const loaded = await this.rewriteHtml(session);
    if (loaded.ok) this.#events.broadcast(session.key, { type: "reload" });
    else this.#events.broadcast(session.key, { type: "invalid", errors: loaded.errors.slice(0, 20) });
  }

  broadcast(session: Session, message: ServerMessage): void {
    this.#events.broadcast(session.key, message);
  }

  broadcastPresence(key: string): void {
    this.#events.broadcast(key, { type: "presence", presence: this.#polls.presence(key) });
  }

  /** What a waiting poll should receive now: queued feedback, the end of the review, or nothing yet. */
  async pollResult(session: Session): Promise<PollResponse | null> {
    const review = await this.#store.read(session.file);
    if (review.queue.length) {
      const loaded = await loadPlan(session.file, { review });
      return {
        status: "feedback",
        batch_ids: review.queue.map((batch) => batch.id),
        items: review.queue.flatMap((batch) => batch.items.map((item) => ({ ...item, sent_at: batch.at }))),
        stage: pollStage(loaded),
      };
    }
    if (session.status === "ended") {
      return {
        status: "ended",
        ended_by: session.ended_by,
        stage: pollStage(await loadPlan(session.file, { review })),
      };
    }
    return null;
  }

  /** The first message on every page connection: everything a page that was away may have missed. */
  async hello(session: Session): Promise<ServerMessage> {
    const review = await this.#store.read(session.file);
    return {
      type: "hello",
      presence: this.#polls.presence(session.key),
      ended: session.status === "ended",
      ended_by: session.ended_by,
      history: renderHistory(review.history),
      signature: planSignature(await loadPlan(session.file, { review })),
    };
  }

  async #broadcastHistory(session: Session): Promise<void> {
    const review = await this.#store.read(session.file);
    this.#events.broadcast(session.key, { type: "history", history: renderHistory(review.history) });
  }
}

/** The plan state a poll reports alongside feedback. */
function pollStage(loaded: LoadResult): PollStage {
  if (!loaded.ok) return { stage: "invalid", errors: loaded.errors.slice(0, 10) };
  const titles = new Map((loaded.plan.tabs ?? []).flatMap(skippableRecords).map((record) => [record.id, record.title]));
  return {
    stage: loaded.stage.stage,
    slices_skipped: loaded.stage.slicesSkipped,
    skipped: Object.keys(loaded.review.skips).map((id) => ({ id, title: titles.get(id) ?? null })),
  };
}

/** Agent replies are Markdown; the page receives them rendered. */
export function renderHistory(history: ReviewRecord["history"]): RenderedHistoryEntry[] {
  return history.map((entry) => (entry.role === "agent" ? { ...entry, html: md(entry.text).toString() } : entry));
}

/** Identifies what a page is showing: a page whose signature differs from the server's is stale. */
export function planSignature(loaded: LoadResult): string {
  if (!loaded.ok) return "invalid";
  const skips = Object.keys(loaded.review.skips).toSorted().join(",");
  return `${loaded.stage.stage}:${loaded.stage.planHash}:${loaded.stage.slicesHash ?? "-"}:${skips}`;
}
