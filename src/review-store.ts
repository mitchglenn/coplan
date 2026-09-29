// `<name>.review.json` sits next to `<name>.json` and is written only by the Coplan server. It
// holds what the reviewer decided (decision answers, approvals, skips), what they sent that the
// agent has not acknowledged yet (the queue), and the conversation. Keeping it beside the plan means
// approvals travel with the plan through version control.

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HistoryContent, ReviewRecord } from "./protocol.ts";

/** The conversation is capped; the oldest entries go first. */
const MAX_HISTORY = 200;

/** `plan.json` → `plan`, the name its sibling files share. */
function stem(planFile: string): string {
  const name = basename(planFile);
  return name.toLowerCase().endsWith(".json") ? name.slice(0, -5) : name;
}

export function reviewPathFor(planFile: string): string {
  return join(dirname(planFile), `${stem(planFile)}.review.json`);
}

export function htmlPathFor(planFile: string): string {
  return join(dirname(planFile), `${stem(planFile)}.html`);
}

export function emptyReview(): ReviewRecord {
  return { version: 1, approvals: {}, skips: {}, queue: [], history: [] };
}

/**
 * Read a review record. A missing file is an empty review; an unreadable one is an error, never
 * silently reset, because resetting would throw away the reviewer's approvals.
 */
export async function readReview(planFile: string): Promise<ReviewRecord> {
  const path = reviewPathFor(planFile);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyReview();
    throw error;
  }
  let parsed: Partial<ReviewRecord>;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${(error as Error).message}). It is written by Coplan; restore it from version control or delete it to reset approvals.`,
      { cause: error },
    );
  }
  return {
    ...emptyReview(),
    ...parsed,
    approvals: isObject(parsed.approvals) ? parsed.approvals : {},
    skips: isObject(parsed.skips) ? parsed.skips : {},
    queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    history: Array.isArray(parsed.history) ? parsed.history : [],
  };
}

const isObject = <T>(value: T | undefined): value is T => Boolean(value) && typeof value === "object";

/** Write through a temporary file and a rename, so a crash never leaves half a file. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}

export function appendHistory(review: ReviewRecord, entry: HistoryContent): void {
  review.history.push({ id: randomUUID(), at: new Date().toISOString(), ...entry });
  if (review.history.length > MAX_HISTORY) review.history.splice(0, review.history.length - MAX_HISTORY);
}

/**
 * Serializes read-modify-write cycles per review file. The server is the only writer, but it
 * handles concurrent requests, and an unserialized update loses whichever write lands first.
 */
export class ReviewStore {
  readonly #locks = new Map<string, Promise<unknown>>();

  /** Read the record, let `mutate` change it, and write it back, after any pending update. */
  update<T>(planFile: string, mutate: (review: ReviewRecord) => T | Promise<T>): Promise<T> {
    const run = this.#after(planFile).then(async () => {
      const review = await readReview(planFile);
      const result = await mutate(review);
      await writeFileAtomic(reviewPathFor(planFile), `${JSON.stringify(review, null, 2)}\n`);
      return result;
    });
    const settled = run.catch(() => {});
    this.#locks.set(planFile, settled);
    void settled.then(() => {
      if (this.#locks.get(planFile) === settled) this.#locks.delete(planFile);
    });
    return run;
  }

  /** Read without writing, ordered after any pending update. */
  read(planFile: string): Promise<ReviewRecord> {
    return this.#after(planFile).then(() => readReview(planFile));
  }

  #after(planFile: string): Promise<unknown> {
    return this.#locks.get(planFile) ?? Promise.resolve();
  }
}
