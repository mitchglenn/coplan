// Agent-facing guidance. The CLI is the single source of truth for how to write and review a plan;
// the installed skill only points here, so an installed copy never goes stale against the engine.

export const DESCRIPTION =
  "Coplan turns a feature request into a structured plan an engineer reviews in 10-15 minutes, then into vertical slices and tasks. You write plan.json; Coplan validates it, renders it as a tabbed HTML page, and runs the review loop in the browser. It moves through up to three human checkpoints: the reviewer answers key decisions, approves the plan, then approves the slices - unless, when approving the plan, they choose to skip slicing and build straight away.";

export const WORKFLOW = [
  "1. Read the codebase before planning against it: the schema, one feature built the way this one will be, the test convention, and how authorization works.",
  "2. Run `coplan guide decisions`, then `coplan new <slug>` to scaffold .coplan/<slug>/plan.json.",
  "3. Write the title, summary and 8-12 key decisions - nothing else yet. Run `coplan render <plan.json>` until it reports no errors.",
  "4. Run `coplan open <plan.json>`, then `coplan poll <plan.json>` in the foreground and wait. The reviewer answers the decisions they care about and submits.",
  '5. Write the plan from the answers: run `coplan guide plan` and `coplan guide tabs`, add `tabs`, render, then `coplan poll <plan.json> --reply "<what you wrote>"`.',
  "6. On feedback: edit plan.json, render, and poll with a reply. Repeat until the reviewer approves the plan.",
  "7. Approving the plan, the reviewer chooses what comes next, and the poll says which. To slice it: run `coplan guide slices`, add `slices` without touching the approved plan, render, and poll with a reply; iterate until the reviewer approves the slices. To build now: the review is closed, so start building from the approved plan - no slices.",
  "8. When the slices are approved the review is complete. Report back in chat; build only when the user asks, slice by slice in wave order.",
];

/** How long one `coplan poll` waits before answering `waiting`: inside the 10 minutes agents' shells allow. */
export const POLL_WAIT_MINUTES = 8;

/** How to run `coplan poll` so that any agent's shell waits for it. */
export const HOW_TO_POLL = `It returns within ${POLL_WAIT_MINUTES} minutes, with the reviewer's feedback or with \`waiting\`; on \`waiting\`, run it again. Give the command a shell timeout of at least 10 minutes, and if your shell hands back a session id while it is still running, keep waiting on that session instead of starting another poll.`;

export const RULES = [
  "Only the reviewer approves. Never write the .review.json file or call the approve endpoint yourself.",
  "An approval covers the exact content the reviewer saw. Editing an approved part re-opens its review, so after plan approval change only `slices` and `questions` unless feedback asks for more.",
  "Never change `decisions` after the reviewer submitted them; that re-opens them. Unanswered decisions are yours to make - state the assumption in the plan.",
  "Approval is impossible while questions remain. Fold each answer into the plan and delete the question in the same edit.",
  `Run \`coplan poll\` in the foreground and read what it returns before doing anything else. ${HOW_TO_POLL} If it is interrupted, run it again: feedback waits until delivered.`,
  "Do not respond to the user in chat while a review is open unless the poll returns ended or browser trouble; the review page is the conversation.",
];

const TOPICS: Record<string, () => Record<string, unknown>> = {
  workflow: () => ({ description: DESCRIPTION, workflow: WORKFLOW, rules: RULES }),

  decisions: () => ({
    purpose:
      "Before any plan exists, surface the 8-12 design decisions that most change what the plan should say, so the plan starts from the reviewer's requirements instead of your guesses. Answering is optional for the reviewer, so order them by impact: the first few should be the ones you most need.",
    each_decision: [
      "Focuses on one specific aspect, set in `aspect`: scope, requirements, constraints, or technical.",
      "Disambiguates an unclear requirement or fills in missing information. If the request, the codebase or an obvious default already answers it, do not ask it.",
      "Offers 2-5 options that represent the common choices, each a short label with an optional one-line detail. Mark the option you would pick as `recommended`.",
      'Sets `select`: "single" for mutually exclusive choices (deployment platform, primary database, where the feature lives); "multiple" when several can apply at once (supported browsers, authentication methods, notification channels).',
      "Needs no free-text option: Coplan always adds one, so the reviewer can describe an answer the options did not foresee.",
      "Uses `context` only when the trade-off is not obvious from the options - one or two sentences on what the choice changes.",
    ],
    good_topics: [
      "scope: which users, which surfaces, what is explicitly v1 versus later",
      "requirements: behaviours the request implies but does not pin down, such as limits, notifications or undo",
      "constraints: deadlines, compatibility, data residency, cost, existing contracts",
      "technical: where the logic lives, sync versus background, storage, reuse of an existing mechanism",
    ],
    after: [
      "Poll returns the answered decisions and the unanswered ones. Answered decisions are requirements. For unanswered ones, make the call and say what you assumed where it matters in the plan.",
      "Coplan shows the reviewer's answers in the plan's Decisions tab; do not restate them as a list in the plan.",
    ],
    shape: {
      decisions:
        "required, 1-12 (aim for 8-12): [{ id: 'D1', question, aspect: scope|requirements|constraints|technical, select: single|multiple, context?, options: [{ id, label, detail?, recommended? }] (2-5) }]",
    },
  }),

  plan: () => ({
    purpose:
      "A plan someone can argue with in one sitting: what it is, what it deliberately is not, how it flows, what the rules are, what breaks, and what is risky. It is reviewed before any code exists.",
    budget: [
      "Set `budget` to small (5 min), standard (10 min, the default) or large (15 min). `coplan render` reports reading time; 15 minutes is a hard ceiling.",
      "small: overview, one flow, edge cases; fold security into edge cases; skip concepts.",
      "standard: overview, two or three flows, concepts, edge cases and security grouped by priority, gaps.",
      "large: every tab the feature needs, every meaningful flow, and a serious gaps tab.",
      "A finished small plan beats an unfinished thorough one. Cut detail before raising the budget.",
    ],
    tabs: [
      "overview (required, first): the problem as it exists today, what the change introduces, goals as outcomes, and a specific, slightly generous out_of_scope list. findings cite the files that constrain the plan.",
      "flows: one per meaningful path, two or three is usually right; more than five means the scope is too big. Each has a trigger, a sequence of steps between real participants, and state changes split into creates, updates and reads. Naming what a flow only reads is what surfaces the authorization questions.",
      "concepts: one entity per concept the feature introduces or changes, with a one-sentence definition, rules (who owns it, when it exists, what it may do) and constraints (uniqueness, idempotency, cardinality - these become database constraints and tests).",
      "The reviewer can skip edge_cases, security and gaps items directly on the page. A skipped item stays in plan.json untouched and Coplan marks it; every poll lists current skips in `skipped`. Plan no work for them and do not delete them.",
      "edge_cases: grouped by priority. Each says what goes wrong and why it matters; a case with no consequence is trivia. Cover concurrent or repeated actions, stale data between decision and execution, deleted or inaccessible references, partial failure, and the empty and very large cases.",
      "security: grouped by risk level, each with the exposure and mitigation paths. Work through authorization at use time, data exposure, enumeration, input trust, and rate/abuse.",
      "gaps: the coverage check. What you set aside, what needs someone else's decision, what you are unsure about. A plan with no gaps is one nobody believes.",
      "Order tabs so each builds on the last: overview, flows, concepts, then a data-model custom tab if there is one, then edge_cases, security, any other custom tabs, and gaps last.",
      "custom: anything the shape of this feature needs - a data model table, an API contract, a UI mock or before/after toggle as an html block, a decision callout.",
    ],
    writing: [
      "Verify every claim against the codebase before stating it as fact; cite the file in findings or refs. Label inference as inference.",
      "Keep items short: a bold title and two or three sentences. Prose belongs in the overview; everything else is scannable items.",
      "Never invent a requirement the request did not contain - ask it as a question instead.",
      "Give every record a short stable id with a prefix: D decisions, F flows, C concepts, E edge cases, R risks, G gaps, Q questions, B blocks, S slices, S1.T1 tasks. Ids are one namespace across the plan, and feedback refers to them.",
      "Markdown fields accept emphasis, `code`, links and lists. Raw HTML in Markdown is shown as text; use a custom tab's html block for figures.",
    ],
    questions: [
      "The key decisions already settled the big unknowns. Use `questions` only for something new that came up while writing the plan.",
      "Ask only what you cannot resolve from the request, the code, the decisions, or a sensible default. Offer 2-6 concrete options, mark at most one recommended, and say in context what each choice costs.",
      "When answers arrive, update the plan to reflect the decision and delete the question in the same edit. The reviewer cannot approve while any question remains.",
    ],
  }),

  tabs: () => ({
    top_level: {
      version: "1 (required)",
      title: "required",
      summary: "required, Markdown, one short paragraph",
      budget: "small | standard | large (default standard)",
      decisions: "required; written first and answered before the plan exists - see `coplan guide decisions`",
      tabs: "1-10 tabs, the overview first; only after the reviewer submits the decisions",
      questions: "optional, open questions for the reviewer",
      slices: "only after the reviewer approves the plan; see `coplan guide slices`",
    },
    every_tab: {
      id: "required, kebab-case",
      title: "required",
      kind: "required",
      intro: "optional Markdown shown above the tab",
    },
    kinds: {
      overview: {
        problem: "required Markdown",
        change: "required Markdown",
        goals: "required [{ title, detail? }]",
        out_of_scope: "required [Markdown]",
        findings: "[{ note, refs?: [path] }]",
      },
      flows: {
        flows:
          "required [{ id, title, trigger, participants: [{ id, label, kind?: actor|system|external|store }], steps: [{ from, to, label, reply?: true } | { note, over: [participant ids, 1-2] }], state?: { creates?, updates?, reads? }, notes? }]",
      },
      concepts: { entities: "required [{ id, name, definition, rules?: [Markdown], constraints?: [Markdown] }]" },
      edge_cases: { cases: "required [{ id, title, priority: high|medium|low, detail }]" },
      security: { risks: "required [{ id, title, level: high|medium|low, exposure, mitigations: [Markdown] }]" },
      gaps: { gaps: "required [{ id, title, detail }]" },
      custom: {
        blocks:
          'required [{ type: "markdown", body } | { type: "callout", tone?: note|decision|warning|risk, title?, body } | { type: "table", caption?, columns: [..], rows: [[..]] } | { type: "code", code, path?, language?, caption? } | { type: "html", html, caption? }] - each may carry an id. An html block renders in the page as written: markup, SVG, <style>, <script> and event handlers all work, so it can be an interactive UI mock or a before/after toggle. It shares the page with the review UI, so prefix every selector with a class unique to the block, wrap scripts in a function, and touch nothing outside the block. Scripts, stylesheets and fonts do not load from the network.',
      },
    },
    question: "{ id, question, context?, options?: [{ id, label, detail?, recommended? }], allow_other?: true }",
    example_flow: {
      id: "F1",
      title: "Admin sends an invitation",
      trigger: "An admin opens **Members → Invite**.",
      participants: [
        { id: "admin", label: "Admin", kind: "actor" },
        { id: "api", label: "API" },
        { id: "db", label: "Postgres", kind: "store" },
      ],
      steps: [
        { from: "admin", to: "api", label: "POST /invitations" },
        { from: "api", to: "api", label: "Authorize manage_members?" },
        { from: "api", to: "db", label: "Insert invitation" },
        { from: "api", to: "admin", label: "201 Created", reply: true },
      ],
      state: { creates: ["invitations row"], reads: ["seat limit"] },
    },
  }),

  slices: () => ({
    purpose:
      "Break the approved plan into vertical slices: each one is a thin, end-to-end piece of behaviour a user can see working, cutting through every layer it needs (data, API, UI, jobs) rather than finishing one layer at a time.",
    rules: [
      "Add slices only after the reviewer approved the plan and chose to slice it; a plan approved to build now takes no slices. Do not edit the approved plan while slicing - that re-opens its review.",
      "Each slice has a goal (what someone can do afterwards), a demo (how a reviewer sees it working), acceptance criteria, and 1-8 tasks.",
      "The first slice is the thinnest path through the whole system, even if it is ugly. Later slices widen it: validation, edge cases, permissions, polish.",
      "A slice that touches one layer is horizontal. Coplan warns on it; either merge it into the slice that needs it or justify it (a migration that must ship first, say).",
      "Map the plan onto the slices: every flow, edge case and security mitigation you intend to build should land in some slice's acceptance or tasks. Edge cases, risks and gaps the reviewer skipped (the poll's `skipped` list) need no work at all. What does not land is out of scope or a gap - say which.",
      "depends_on between slices defines waves; slices in one wave can be built in parallel. Keep the graph shallow.",
      "Tasks name the files they touch when you know them, a layer, and a relative size S/M/L. A task is something one engineer finishes in a sitting or two.",
    ],
    shape: {
      slices:
        "[{ id: 'S1', title, goal, demo, layers?: ['db','api','ui'], depends_on?: [slice ids], acceptance: [Markdown], tasks: [{ id: 'S1.T1', title, detail?, layer?, size?: S|M|L, files?: [path], depends_on?: [task ids] }], notes? }]",
    },
  }),
};

export function guideTopics() {
  return {
    topics: {
      workflow: "The review loop, command by command, and the rules that keep approvals honest",
      decisions: "The first step: 8-12 key decisions the reviewer answers before the plan is written",
      plan: "What goes in the plan phase: reading budget, which tabs to use, how to write items and questions",
      tabs: "The plan.json reference: every field of every tab kind, with a worked flow",
      slices: "Vertical slicing after plan approval: rules and the slices/tasks shape",
    },
    help: [
      "Run `coplan guide <topic>`. Read workflow and decisions first; plan and tabs once the decisions are answered; slices after the plan is approved.",
    ],
  };
}

export function guideTopic(topic: string): Record<string, unknown> | null {
  return TOPICS[topic]?.() ?? null;
}
