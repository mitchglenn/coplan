// Which plans have a review, and whether each is still open. Persisted to `sessions.json` in the
// state directory, so a restarted server still knows which reviews the reviewer ended.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionKey } from "../paths.ts";
import type { EndedBy } from "../protocol.ts";
import { writeFileAtomic } from "../review-store.ts";

export interface Session {
  /** A hash of the plan's canonical path; the page URL is `/plan/<key>`. */
  key: string;
  file: string;
  status: "open" | "ended";
  ended_by: EndedBy | null;
  opened_at: string;
}

export type OpenResult = { session: Session } | { userEnded: true; key: string };

export class SessionRegistry {
  readonly #file: string;
  readonly #sessions: Map<string, Session>;

  private constructor(file: string, sessions: Map<string, Session>) {
    this.#file = file;
    this.#sessions = sessions;
  }

  static async load(stateDir: string): Promise<SessionRegistry> {
    const file = join(stateDir, "sessions.json");
    const sessions = new Map<string, Session>();
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { sessions?: Record<string, Session> };
      for (const session of Object.values(saved.sessions ?? {})) sessions.set(session.key, session);
    } catch {
      // First run, or an unreadable registry: sessions are re-registered by the next `coplan open`.
    }
    return new SessionRegistry(file, sessions);
  }

  get(key: string): Session | undefined {
    return this.#sessions.get(key);
  }

  forFile(file: string): Session | undefined {
    return this.#sessions.get(sessionKey(file));
  }

  /**
   * Opens a review for a plan, or resumes the open one. A review the reviewer ended stays ended
   * unless `reopen` is set: the agent should not bring back a review the human closed.
   */
  async open(file: string, { reopen }: { reopen: boolean }): Promise<OpenResult> {
    const key = sessionKey(file);
    const existing = this.#sessions.get(key);
    if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) return { userEnded: true, key };
    if (existing?.status === "open") return { session: existing };
    const session: Session = { key, file, status: "open", ended_by: null, opened_at: new Date().toISOString() };
    this.#sessions.set(key, session);
    await this.#save();
    return { session };
  }

  /** Marks a session ended. Returns false when it already was. */
  async end(session: Session, by: EndedBy): Promise<boolean> {
    if (session.status === "ended") return false;
    session.status = "ended";
    session.ended_by = by;
    await this.#save();
    return true;
  }

  #save(): Promise<void> {
    return writeFileAtomic(
      this.#file,
      `${JSON.stringify({ sessions: Object.fromEntries(this.#sessions) }, null, 2)}\n`,
    );
  }
}
