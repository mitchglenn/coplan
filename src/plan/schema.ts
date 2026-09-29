// The plan.json contract. One Zod schema gives Coplan runtime validation, the TypeScript types
// every other module uses, and the JSON Schema that editors read through a plan's `$schema`.
//
// The schema is strict on purpose: an unknown key is almost always a typo the agent would otherwise
// never notice. Defaults matter too. Approvals hash the validated plan, defaults included, so
// changing one changes every plan's hash and invalidates existing approvals.

import { z } from "zod";

export const PLAN_VERSION = 1;
export const BUDGET_MINUTES = { small: 5, standard: 10, large: 15 } as const;
export const DECISIONS_MIN = 8;
export const DECISIONS_MAX = 12;
/** Tabs the engine adds itself, so a plan may not claim their ids. */
export const RESERVED_TAB_IDS = ["questions", "slices"] as const;

const PRIORITIES = ["high", "medium", "low"] as const;

// --- primitives ---

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { error: "must not be empty" });

/** Short single-line text: titles, labels, table cells in headers. */
const label = text(160);
/** Prose that renders as Markdown. */
const markdown = text(6000);

const idPattern = (pattern: RegExp, hint: string) =>
  z.string().regex(pattern, { error: (issue) => `expected an id (${hint}), got ${JSON.stringify(issue.input)}` });

/** Record ids share one namespace across the plan: D1, F2, E3, S1.T2. */
const id = idPattern(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/,
  "letters, digits, '.', '_' or '-', starting with a letter or digit",
);
const tabId = idPattern(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase kebab-case");

const list = <T extends z.ZodType>(item: T, { min = 0, max }: { min?: number; max: number }) =>
  z.array(item).min(min).max(max);

/** An optional list that validates to `[]` when absent. */
const optionalList = <T extends z.ZodType>(item: T, max: number) => list(item, { max }).default(() => []);

// --- overview ---

const goal = z.strictObject({ title: label, detail: markdown.optional() });
const finding = z.strictObject({ note: markdown, refs: list(label, { max: 12 }).optional() });

// --- flows ---

const participant = z.strictObject({
  id,
  label,
  kind: z.enum(["actor", "system", "external", "store"]).default("system"),
});

const messageStep = z.strictObject({ from: id, to: id, label, reply: z.boolean().default(false) });
const noteStep = z.strictObject({ note: label, over: list(id, { min: 1, max: 2 }) });

const flow = z.strictObject({
  id,
  title: label,
  trigger: markdown,
  participants: list(participant, { min: 1, max: 8 }),
  steps: list(z.union([noteStep, messageStep]), { min: 1, max: 30 }),
  state: z
    .strictObject({
      creates: optionalList(label, 20),
      updates: optionalList(label, 20),
      reads: optionalList(label, 20),
    })
    .optional(),
  notes: markdown.optional(),
});

// --- concepts, edge cases, security, gaps ---

const entity = z.strictObject({
  id,
  name: label,
  definition: markdown,
  rules: optionalList(markdown, 20),
  constraints: optionalList(markdown, 20),
});

const edgeCase = z.strictObject({ id, title: label, priority: z.enum(PRIORITIES), detail: markdown });

const risk = z.strictObject({
  id,
  title: label,
  level: z.enum(PRIORITIES),
  exposure: markdown,
  mitigations: list(markdown, { min: 1, max: 10 }),
});

const gap = z.strictObject({ id, title: label, detail: markdown });

// --- custom tab blocks ---

const table = z
  .strictObject({
    type: z.literal("table"),
    id: id.optional(),
    caption: label.optional(),
    columns: list(label, { min: 1, max: 8 }),
    rows: list(list(markdown, { min: 1, max: 8 }), { min: 1, max: 60 }),
  })
  .superRefine((value, ctx) => {
    value.rows.forEach((row, index) => {
      if (row.length !== value.columns.length) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index],
          message: `has ${row.length} cells; the table has ${value.columns.length} columns`,
        });
      }
    });
  });

const BLOCK_TYPES = ["markdown", "callout", "table", "code", "html"] as const;

const block = z.discriminatedUnion(
  "type",
  [
    z.strictObject({ type: z.literal("markdown"), id: id.optional(), body: markdown }),
    z.strictObject({
      type: z.literal("callout"),
      id: id.optional(),
      tone: z.enum(["note", "decision", "warning", "risk"]).default("note"),
      title: label.optional(),
      body: markdown,
    }),
    table,
    z.strictObject({
      type: z.literal("code"),
      id: id.optional(),
      caption: label.optional(),
      path: label.optional(),
      language: label.optional(),
      code: text(20000),
    }),
    // Markup, styles and scripts, rendered in the page as written.
    z.strictObject({ type: z.literal("html"), id: id.optional(), caption: label.optional(), html: text(60000) }),
  ],
  { error: expectedOneOf(BLOCK_TYPES) },
);

// --- tabs ---

const tabBase = { id: tabId, title: label, intro: markdown.optional() };

const TAB_KINDS = ["overview", "flows", "concepts", "edge_cases", "security", "gaps", "custom"] as const;

const tab = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      ...tabBase,
      kind: z.literal("overview"),
      problem: markdown,
      change: markdown,
      goals: list(goal, { min: 1, max: 10 }),
      out_of_scope: list(markdown, { min: 1, max: 20 }),
      findings: optionalList(finding, 12),
    }),
    z.strictObject({ ...tabBase, kind: z.literal("flows"), flows: list(flow, { min: 1, max: 8 }) }),
    z.strictObject({ ...tabBase, kind: z.literal("concepts"), entities: list(entity, { min: 1, max: 20 }) }),
    z.strictObject({ ...tabBase, kind: z.literal("edge_cases"), cases: list(edgeCase, { min: 1, max: 40 }) }),
    z.strictObject({ ...tabBase, kind: z.literal("security"), risks: list(risk, { min: 1, max: 30 }) }),
    z.strictObject({ ...tabBase, kind: z.literal("gaps"), gaps: list(gap, { min: 1, max: 20 }) }),
    z.strictObject({ ...tabBase, kind: z.literal("custom"), blocks: list(block, { min: 1, max: 30 }) }),
  ],
  { error: expectedOneOf(TAB_KINDS) },
);

// --- decisions and questions ---

const option = z.strictObject({ id, label, detail: markdown.optional(), recommended: z.boolean().default(false) });

/**
 * Key decisions come before the plan. The engine always offers a free-text answer, so a decision
 * has no allow_other switch: the reviewer can always say something the options did not foresee.
 */
const decision = z.strictObject({
  id,
  question: label,
  aspect: z.enum(["scope", "requirements", "constraints", "technical"]),
  select: z.enum(["single", "multiple"]),
  context: markdown.optional(),
  options: list(option, { min: 2, max: 5 }),
});

const question = z.strictObject({
  id,
  question: label,
  context: markdown.optional(),
  options: list(option, { min: 2, max: 6 }).default(() => []),
  allow_other: z.boolean().default(true),
});

// --- slices ---

const task = z.strictObject({
  id,
  title: label,
  detail: markdown.optional(),
  layer: label.optional(),
  size: z.enum(["S", "M", "L"]).optional(),
  files: optionalList(label, 20),
  depends_on: optionalList(id, 20),
});

const slice = z.strictObject({
  id,
  title: label,
  goal: markdown,
  demo: markdown,
  layers: optionalList(label, 8),
  depends_on: optionalList(id, 20),
  acceptance: list(markdown, { min: 1, max: 12 }),
  tasks: list(task, { min: 1, max: 20 }),
  notes: markdown.optional(),
});

// --- the plan ---

export const planSchema = z.strictObject({
  $schema: label.optional(),
  version: z.literal(PLAN_VERSION),
  title: label,
  summary: markdown,
  budget: z.enum(["small", "standard", "large"]).default("standard"),
  decisions: list(decision, { min: 1, max: DECISIONS_MAX }),
  tabs: list(tab, { min: 1, max: 10 }).optional(),
  questions: optionalList(question, 20),
  slices: list(slice, { max: 20 }).optional(),
});

function expectedOneOf(values: readonly string[]) {
  return () => `expected one of ${values.map((value) => JSON.stringify(value)).join(", ")}`;
}

// --- types ---

export type Plan = z.output<typeof planSchema>;
export type Budget = Plan["budget"];
export type Decision = Plan["decisions"][number];
export type Option = Decision["options"][number];
export type Question = Plan["questions"][number];
export type Tab = NonNullable<Plan["tabs"]>[number];
export type TabKind = Tab["kind"];
export type TabOf<K extends TabKind> = Extract<Tab, { kind: K }>;
export type Flow = TabOf<"flows">["flows"][number];
export type Participant = Flow["participants"][number];
export type Step = Flow["steps"][number];
export type Entity = TabOf<"concepts">["entities"][number];
export type EdgeCase = TabOf<"edge_cases">["cases"][number];
export type Risk = TabOf<"security">["risks"][number];
export type Gap = TabOf<"gaps">["gaps"][number];
export type Block = TabOf<"custom">["blocks"][number];
export type Slice = NonNullable<Plan["slices"]>[number];
export type Task = Slice["tasks"][number];
export type Priority = (typeof PRIORITIES)[number];
