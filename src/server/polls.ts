// The agent's long polls. An agent can only run commands, so `coplan poll` blocks on one HTTP
// request until there is something to hand over, or until its wait runs out and it answers
// `waiting`: agents' shells limit how long a command may run, so a poll returns in time to be run
// again. Each session has at most one waiting poll; the newest wins, so an agent that restarted is
// never locked out by its own dead request.
//
// Presence comes from here too. A waiting poll means the agent is listening, and so does a poll
// that just answered `waiting`, for as long as the agent takes to start the next one. Feedback
// delivered more recently than its last reply means it is working on it.

import type { ServerResponse } from "node:http";
import type { Presence, PollResponse } from "../protocol.ts";

/** A space every 20 seconds keeps the waiting request from looking idle to anything in between. */
const HEARTBEAT_MS = 20_000;
/** How long an agent whose poll answered `waiting` still counts as listening. */
const NEXT_POLL_GRACE_MS = 60_000;

/** What a poll should answer right now, or null to keep waiting. */
export type PollCheck = () => Promise<PollResponse | null>;

interface WaitingPoll {
  res: ServerResponse;
  check: PollCheck;
  done: boolean;
}

interface Agent {
  poll: WaitingPoll | null;
  deliveredAt: number;
  repliedAt: number;
  /** Set when a poll answers `waiting`: the agent is about to poll again. */
  listeningUntil: number;
  graceTimer: NodeJS.Timeout | null;
}

export class PollHub {
  readonly #agents = new Map<string, Agent>();
  readonly #onPresenceChange: (key: string) => void;

  constructor(onPresenceChange: (key: string) => void) {
    this.#onPresenceChange = onPresenceChange;
  }

  presence(key: string): Presence {
    const agent = this.#agents.get(key);
    if (agent && (agent.poll || Date.now() < agent.listeningUntil)) return "listening";
    if (agent && agent.deliveredAt && agent.repliedAt < agent.deliveredAt) return "working";
    return "away";
  }

  isListening(key: string): boolean {
    return this.presence(key) === "listening";
  }

  anyWaiting(): boolean {
    return [...this.#agents.values()].some((agent) => agent.poll);
  }

  /** Holds the request open until `check` has something, or answers `waiting` after `waitMs`. */
  async wait(key: string, res: ServerResponse, check: PollCheck, waitMs: number): Promise<void> {
    const agent = this.#agent(key);
    if (agent.poll) this.#finish(key, agent.poll, { status: "replaced" });

    // Registered before the first check, so feedback that arrives during it still wakes this poll.
    const poll: WaitingPoll = { res, check, done: false };
    agent.poll = poll;
    agent.listeningUntil = 0;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.write(" ");
    const heartbeat = setInterval(() => res.write(" "), HEARTBEAT_MS);
    const timeout = setTimeout(() => this.#finish(key, poll, { status: "waiting" }), waitMs);
    heartbeat.unref();
    timeout.unref();
    res.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (poll.done) return;
      poll.done = true;
      if (agent.poll === poll) agent.poll = null;
      this.#onPresenceChange(key);
    });
    this.#onPresenceChange(key);

    const result = await check();
    if (result) this.#finish(key, poll, result);
  }

  /** Something changed for this session: let a waiting poll check again. */
  async wake(key: string): Promise<void> {
    const poll = this.#agents.get(key)?.poll;
    if (!poll || poll.done) return;
    const result = await poll.check();
    if (result) this.#finish(key, poll, result);
  }

  markReplied(key: string): void {
    this.#agent(key).repliedAt = Date.now();
  }

  /** Ends every waiting poll, telling each CLI to poll again once a server is back. */
  closeAll(): void {
    for (const [key, agent] of this.#agents) {
      if (agent.poll) this.#finish(key, agent.poll, { status: "server_stopped" });
      if (agent.graceTimer) clearTimeout(agent.graceTimer);
    }
  }

  #finish(key: string, poll: WaitingPoll, body: PollResponse): void {
    if (poll.done) return;
    poll.done = true;
    const agent = this.#agent(key);
    if (agent.poll === poll) agent.poll = null;
    if (body.status === "feedback") agent.deliveredAt = Date.now();
    agent.listeningUntil = body.status === "waiting" ? Date.now() + NEXT_POLL_GRACE_MS : 0;
    if (agent.listeningUntil) {
      // Tell open pages when the grace runs out without a new poll.
      if (agent.graceTimer) clearTimeout(agent.graceTimer);
      agent.graceTimer = setTimeout(() => this.#onPresenceChange(key), NEXT_POLL_GRACE_MS + 50);
      agent.graceTimer.unref();
    }
    // Headers went out when the poll started waiting; the body completes the response.
    if (!poll.res.writableEnded) poll.res.end(JSON.stringify(body));
    this.#onPresenceChange(key);
  }

  #agent(key: string): Agent {
    let agent = this.#agents.get(key);
    if (!agent) {
      agent = { poll: null, deliveredAt: 0, repliedAt: 0, listeningUntil: 0, graceTimer: null };
      this.#agents.set(key, agent);
    }
    return agent;
  }
}
