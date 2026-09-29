# AGENTS.md

Guidance for agents working on Coplan itself.
README.md owns the user-facing contract; `src/guide.ts` owns everything agents are told while using Coplan.
This file owns the architecture and the invariants that are easy to break.

## Commands

```sh
npm run check      # lint (oxlint), format check, both typechecks, tests
node --test test/server.test.ts
npm run build      # compile to dist/ for publishing; a checkout never needs it
```

TypeScript on Node 24+.
A checkout runs the `.ts` source directly through Node's type stripping, so there is no build step while developing: `bin/coplan.js` runs `src/` when it exists and `dist/` in a published package.
Only syntax that erases cleanly is allowed (`erasableSyntaxOnly`): no enums, namespaces or constructor parameter properties.

There are two TypeScript programs.
`tsconfig.json` covers the Node code and tests; `tsconfig.client.json` covers the browser code against the DOM: the review client in `src/client/` and the tab script `src/render/tabs.ts`, which is inlined into every page as a classic script and must never import or export.
From a checkout the server strips the browser code's types as it serves it (`src/render/browser-code.ts`); a package serves the JavaScript `tsc` compiled.

## Layout

- `src/protocol.ts`: every type that crosses a process boundary: the review record, feedback items, browser requests, WebSocket messages, poll responses, the page bootstrap. Types only, because the browser imports it.
- `src/plan/`: the plan itself. `schema.ts` is the Zod schema and the `Plan` types derived from it; `validate.ts` turns Zod issues into path-and-message diagnostics and checks cross-references; `stage.ts` holds the content hashes and the stage machine; `metrics.ts` reading time, slice waves and tab counts.
- `src/engine.ts`: load, validate and render, shared by the CLI and the server so they never disagree.
- `src/review-store.ts`: `<name>.review.json`, written only by the server; `ReviewStore` serializes read-modify-write per file.
- `src/render/`: the static page. `html.ts` is the escaping template tag; `page.ts` assembles the page from `plan-tabs.ts` (tabs the agent writes) and `engine-tabs.ts` (decisions, questions, slices); `sequence.ts` draws flow diagrams.
- `src/server/`: `index.ts` wires the pieces and routes requests. `SessionRegistry` (which plans have reviews), `PollHub` (the agent's long polls and presence), `EventHub` (WebSocket pages), `PlanWatcher` (re-render on save) and `ReviewService` (the review operations the routes call). Routes are tables in `agent-routes.ts` and `browser-routes.ts`.
- `src/cli/`: the `coplan` command. `commands.ts` holds the short commands, `poll.ts` the poll and the `next_step` texts that steer the agent, `setup.ts` installing the skill for the agents on the machine, `server-client.ts` starting and reaching the server.
- `skills/coplan/SKILL.md`: the skill, a short pointer to the CLI. Only standard Agent Skills frontmatter, so every agent reads it the same way.
- `.claude-plugin/`: the repo is also a Claude Code plugin and its own marketplace. A plugin install runs from source, with `bin/coplan` on the PATH.
- `src/client/`: the review UI, loaded only when a plan is served for review. All mutable state lives in `store.ts`; whatever changes it calls `changed()`, which re-renders the panel and re-syncs every control the other modules wired.

## Invariants

- **Stage is derived, never declared.** It comes from the plan's content hashes and the approvals in the review record. Do not add a field that lets plan.json state its own stage or approval.
- **Checkpoints bind to content.** Hashes are taken over the validated plan, defaults included, so changing a default in `src/plan/schema.ts` changes every plan's hash. `decisionsHash` covers `decisions`; `planPartHash` excludes `decisions`, `slices`, `questions` and `$schema`; `slicesHash` covers `slices` only. Writing `tabs` before any decision submission, or `slices` before any plan approval, is a validation error. Changing what a hash covers invalidates every existing approval, so treat it as a migration.
- **Decision answers are engine-owned.** They live in the review record, are validated against the decisions the reviewer saw, and are rendered into the plan's Decisions tab; the agent never copies them into plan.json. Every decision offers a free-text answer, so the schema has no switch for it.
- **Skips are plan state, not feedback.** The reviewer's Skip saves immediately through `/api/<key>/skip`, is validated against the plan's edge cases, risks and gaps, and is recorded in the review record. It never enters the feedback queue, so it never blocks approval; instead every poll response restates the current skips. The agent never deletes a skipped item; the renderer dims and marks it.
- **Approval requires zero open questions.** The server enforces it; the client only explains it.
- **The plan approval chooses what comes next.** `approvals.plan.next` is `"slices"` (also what a record without it means) or `"build"`. A build-now approval makes the stage `approved` and ends the session; writing `slices` against it is a validation error.
- **Delivery is at-least-once.** A poll returns queued batches without removing them; the CLI acknowledges by batch id only after reading the full response. Never delete from the queue on send.
- **The newest poll wins.** A second poll replaces the first with `status: "replaced"`, so a restarted agent is never locked out by its own dead poll.
- **A poll always returns in time.** Agents' shells limit how long a command runs, so a poll answers `waiting` after the `wait_ms` the CLI sends, and the agent runs it again. The wait and the guidance that promises it come from one constant, `POLL_WAIT_MINUTES` in `src/guide.ts`; keep it under the 10 minutes agents' shells allow. After `waiting`, the agent still counts as listening while it starts the next poll.
- **Browser routes need our Origin; control routes need no foreign Origin.** `/api/<key>/*` requires an Origin matching the Host. CLI routes accept header-less requests but reject a foreign Origin. Every route checks the Host header against loopback names (DNS rebinding).
- **GET routes change nothing.** A page on another site can send a GET with no Origin at all (an image), so the Origin check skips GETs. Anything with an effect is a POST, including the poll, which replaces the agent's waiting one.
- **The static file stays static.** `plan.html` on disk never contains the review client. The server injects the bootstrap and `/client/review.js` only when serving `/plan/<key>`.
- **Markup escapes by default.** Build HTML with the `html` tag, never string concatenation: it escapes every interpolated value that is not already an `Html` fragment. `md()` output is trusted; `raw()` is only for our own assets and html blocks. Prettier's embedded formatting is off because whitespace inside these templates is output.
- **html blocks are trusted like the rest of the plan.** They render in the page as written, scripts included, so a block can be an interactive UI mock; the guide asks agents to scope their styles and scripts to the block. Anywhere else, plan content reaches the page only as escaped text or `md()` output.
- **Reconnects converge.** The WebSocket `hello` carries history, presence and a plan signature; a page whose signature differs reloads. Anything a disconnected page could miss must be in `hello`.
- **The server restarts itself on code changes.** `buildId()` fingerprints `bin/` and the code that is running (`src/` or `dist/`); the CLI replaces a server whose build differs. A waiting poll ends with `server_stopped` and tells the agent to re-run it.
- **The protocol is the contract.** A payload between the server, the CLI and the page is typed once in `src/protocol.ts` and imported by both ends. A field one side sends and the other never reads is dead code; delete it from the type.
- **Browser modules do no DOM work on import.** Every client module is loaded on the invalid-plan page too, which has no plan markup; queries belong in the `wire*` and `mount*` functions `review.ts` calls.
