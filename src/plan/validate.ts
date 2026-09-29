// Turns plan.json into a validated `Plan` or a list of diagnostics. Every diagnostic names the
// exact JSON path it is about, so an agent can fix a plan without re-reading the whole file.
//
// Validation runs in two passes. The Zod schema checks shape and fills in defaults; once the shape
// is valid, the cross-reference pass checks what a schema cannot: ids unique across the whole
// plan, flow steps naming declared participants, slice dependencies that exist and do not cycle.

import { z } from "zod";
import {
  DECISIONS_MAX,
  DECISIONS_MIN,
  planSchema,
  RESERVED_TAB_IDS,
  type Flow,
  type Plan,
  type Slice,
  type Tab,
} from "./schema.ts";

export interface Diagnostic {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; plan: Plan; errors: []; warnings: Diagnostic[] }
  | { ok: false; plan: null; errors: Diagnostic[]; warnings: Diagnostic[] };

/** `coplan new` fills a scaffold with values starting with this; any left over is an error. */
export const PLACEHOLDER = "TODO:";

const SUMMARY_MAX_WORDS = 90;

/** Parse and validate plan.json source text. */
export function parsePlan(source: string): ValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return failure([{ path: "(file)", message: `not valid JSON: ${(error as Error).message}` }]);
  }
  return validatePlan(value);
}

/** Validate a parsed plan.json value. */
export function validatePlan(input: unknown): ValidationResult {
  const report = new Report();
  findPlaceholders(input, [], (path) =>
    report.error(path, "still holds a TODO placeholder from `coplan new`; replace it or remove the field"),
  );
  const parsed = planSchema.safeParse(input, { error: messageFor });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) report.issue(issue, []);
    return failure(report.errors, report.warnings);
  }
  const plan = parsed.data;
  checkReferences(report, plan);
  const words = countWords(plan.summary);
  if (words > SUMMARY_MAX_WORDS) {
    report.warn("summary", `is ${words} words; keep the summary to a short paragraph a reviewer reads in 20 seconds`);
  }
  if (report.errors.length) return failure(report.errors, report.warnings);
  return { ok: true, plan, errors: [], warnings: report.warnings };
}

function failure(errors: Diagnostic[], warnings: Diagnostic[] = []): ValidationResult {
  return { ok: false, plan: null, errors, warnings };
}

export function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

// --- diagnostics ---

type PathSegment = PropertyKey;

/** `["tabs", 1, "flows", 0]` → `tabs[1].flows[0]` */
export function formatPath(path: readonly PathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(root)";
}

class Report {
  readonly errors: Diagnostic[] = [];
  readonly warnings: Diagnostic[] = [];

  error(path: string, message: string) {
    this.errors.push({ path, message });
  }

  warn(path: string, message: string) {
    this.warnings.push({ path, message });
  }

  /** Record a Zod issue, splitting and unwrapping the kinds whose raw form reads poorly. */
  issue(issue: z.core.$ZodIssue, prefix: PathSegment[]) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) this.error(formatPath([...path, key]), issue.message);
      return;
    }
    // A union that no branch matched reports every branch's issues. Show the branch that came
    // closest, which is the one the author most likely meant (a note step versus a message step).
    if (issue.code === "invalid_union" && issue.errors.length) {
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best));
      for (const inner of closest) this.issue(inner, path);
      return;
    }
    this.error(formatPath(path), issue.message);
  }
}

/** Plain, path-free messages for each kind of issue; the path is reported separately. */
function messageFor(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? "is required"
        : `expected ${article(issue.expected)}, got ${describe(issue.input)}`;
    case "too_small":
      return issue.origin === "array"
        ? `needs at least ${issue.minimum} item${Number(issue.minimum) === 1 ? "" : "s"}`
        : undefined;
    case "too_big":
      if (issue.origin === "array")
        return `has ${(issue.input as unknown[]).length} items; the limit is ${issue.maximum}`;
      if (issue.origin === "string")
        return `is ${(issue.input as string).length} characters; the limit is ${issue.maximum}`;
      return undefined;
    case "invalid_value":
      return `expected one of ${issue.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "unrecognized_keys": {
      const shape = (issue.inst as z.ZodObject | undefined)?.shape;
      return shape ? `unknown field; allowed: ${Object.keys(shape).join(", ")}` : "unknown field";
    }
    default:
      return undefined;
  }
}

function article(expected: string): string {
  if (expected === "boolean") return "true or false";
  return /^[aeiou]/.test(expected) ? `an ${expected}` : `a ${expected}`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return article(typeof value);
}

function findPlaceholders(value: unknown, path: PathSegment[], report: (path: string) => void) {
  if (typeof value === "string") {
    if (value.trimStart().startsWith(PLACEHOLDER)) report(formatPath(path));
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => findPlaceholders(entry, [...path, index], report));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) findPlaceholders(entry, [...path, key], report);
  }
}

// --- cross-references ---

function checkReferences(report: Report, plan: Plan) {
  const ids = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const previous = ids.get(id);
    if (previous) report.error(path, `duplicate id ${JSON.stringify(id)}; also used at ${previous}`);
    else ids.set(id, path);
  };

  checkTabs(report, plan, claim);
  checkDecisions(report, plan, claim);

  plan.questions.forEach((question, i) => {
    claim(question.id, `questions[${i}].id`);
    checkOptions(report, question.options, `questions[${i}].options`, { maxRecommended: 1 });
    if (!question.options.length && !question.allow_other) {
      report.error(`questions[${i}]`, "a question with no options must allow a free-form answer (allow_other)");
    }
  });

  if (plan.slices) checkSlices(report, plan.slices, claim);
}

function checkTabs(report: Report, plan: Plan, claim: (id: string, path: string) => void) {
  if (!plan.tabs) return;
  const tabIds = new Map<string, string>();
  const kinds = new Map<string, string>();
  plan.tabs.forEach((tab, t) => {
    const path = `tabs[${t}]`;
    if ((RESERVED_TAB_IDS as readonly string[]).includes(tab.id)) {
      report.error(`${path}.id`, `${JSON.stringify(tab.id)} is reserved for the tab Coplan adds itself`);
    }
    const sameId = tabIds.get(tab.id);
    if (sameId) report.error(`${path}.id`, `duplicate tab id; also used at ${sameId}`);
    tabIds.set(tab.id, `${path}.id`);

    if (tab.kind !== "custom") {
      const sameKind = kinds.get(tab.kind);
      if (sameKind) report.error(`${path}.kind`, `only one ${tab.kind} tab is allowed; the first is ${sameKind}`);
      else kinds.set(tab.kind, path);
    }

    const records = recordsOf(tab);
    records?.list.forEach((record, i) => record.id && claim(record.id, `${path}.${records.field}[${i}].id`));
    if (tab.kind === "flows") tab.flows.forEach((flow, i) => checkFlow(report, flow, `${path}.flows[${i}]`));
  });

  const overview = kinds.get("overview");
  if (!overview) {
    report.error("tabs", 'a plan needs exactly one overview tab (kind "overview") with its goals and out_of_scope');
  } else if (overview !== "tabs[0]") {
    report.warn(overview, "put the overview tab first; the reviewer reads it before anything else");
  }
  if (!kinds.has("gaps")) {
    report.warn(
      "tabs",
      "no gaps tab: list what the plan does not cover yet. A plan with no gaps is one nobody believes",
    );
  }
}

/** The records a tab holds whose ids join the plan-wide namespace. */
function recordsOf(tab: Tab): { field: string; list: { id?: string }[] } | null {
  switch (tab.kind) {
    case "flows":
      return { field: "flows", list: tab.flows };
    case "concepts":
      return { field: "entities", list: tab.entities };
    case "edge_cases":
      return { field: "cases", list: tab.cases };
    case "security":
      return { field: "risks", list: tab.risks };
    case "gaps":
      return { field: "gaps", list: tab.gaps };
    case "custom":
      return { field: "blocks", list: tab.blocks };
    case "overview":
      return null;
  }
}

function checkDecisions(report: Report, plan: Plan, claim: (id: string, path: string) => void) {
  if (plan.decisions.length < DECISIONS_MIN) {
    report.warn(
      "decisions",
      `has ${plan.decisions.length}; aim for ${DECISIONS_MIN}-${DECISIONS_MAX} so the plan starts from real requirements rather than guesses`,
    );
  }
  plan.decisions.forEach((decision, i) => {
    claim(decision.id, `decisions[${i}].id`);
    checkOptions(report, decision.options, `decisions[${i}].options`, {
      maxRecommended: decision.select === "single" ? 1 : Infinity,
      recommendedMessage: "a single-select decision can recommend at most one option",
    });
  });
}

function checkOptions(
  report: Report,
  options: { id: string; recommended: boolean }[],
  path: string,
  {
    maxRecommended,
    recommendedMessage = "at most one option can be recommended",
  }: { maxRecommended: number; recommendedMessage?: string },
) {
  const seen = new Set<string>();
  options.forEach((option, j) => {
    if (seen.has(option.id)) report.error(`${path}[${j}].id`, `duplicate option id ${JSON.stringify(option.id)}`);
    seen.add(option.id);
  });
  if (options.filter((option) => option.recommended).length > maxRecommended) report.error(path, recommendedMessage);
}

function checkFlow(report: Report, flow: Flow, path: string) {
  const declared = flow.participants.map((participant) => participant.id);
  const known = new Set(declared);
  if (known.size !== declared.length) report.error(`${path}.participants`, "participant ids must be unique");
  const unknown = (value: string, at: string) => {
    if (!known.has(value)) {
      report.error(at, `unknown participant ${JSON.stringify(value)}; declared: ${declared.join(", ")}`);
    }
  };
  flow.steps.forEach((step, i) => {
    if ("note" in step) step.over.forEach((participant, j) => unknown(participant, `${path}.steps[${i}].over[${j}]`));
    else {
      unknown(step.from, `${path}.steps[${i}].from`);
      unknown(step.to, `${path}.steps[${i}].to`);
    }
  });
}

function checkSlices(report: Report, slices: Slice[], claim: (id: string, path: string) => void) {
  const sliceIds = new Set<string>();
  const taskIds = new Set<string>();
  slices.forEach((slice, i) => {
    claim(slice.id, `slices[${i}].id`);
    sliceIds.add(slice.id);
    slice.tasks.forEach((task, j) => {
      claim(task.id, `slices[${i}].tasks[${j}].id`);
      taskIds.add(task.id);
    });
  });

  slices.forEach((slice, i) => {
    slice.depends_on.forEach((dependency, j) => {
      const path = `slices[${i}].depends_on[${j}]`;
      if (dependency === slice.id) report.error(path, "a slice cannot depend on itself");
      else if (!sliceIds.has(dependency)) report.error(path, `unknown slice ${JSON.stringify(dependency)}`);
    });
    slice.tasks.forEach((task, j) => {
      task.depends_on.forEach((dependency, k) => {
        const path = `slices[${i}].tasks[${j}].depends_on[${k}]`;
        if (dependency === task.id) report.error(path, "a task cannot depend on itself");
        else if (!taskIds.has(dependency)) report.error(path, `unknown task ${JSON.stringify(dependency)}`);
      });
    });
    if (slice.layers.length === 1) {
      report.warn(
        `slices[${i}].layers`,
        "touches a single layer, so it is a horizontal slice. A vertical slice cuts through every layer a user-visible behaviour needs",
      );
    }
    if (slice.tasks.length > 8) {
      report.warn(`slices[${i}].tasks`, `has ${slice.tasks.length} tasks; a slice this large usually hides two slices`);
    }
  });

  const sliceCycle = findCycle(slices.map((slice) => [slice.id, slice.depends_on.filter((d) => sliceIds.has(d))]));
  if (sliceCycle) report.error("slices", `dependency cycle: ${sliceCycle.join(" -> ")}`);
  const tasks = slices.flatMap((slice) => slice.tasks);
  const taskCycle = findCycle(tasks.map((task) => [task.id, task.depends_on.filter((d) => taskIds.has(d))]));
  if (taskCycle) report.error("slices", `task dependency cycle: ${taskCycle.join(" -> ")}`);
}

/** The first cycle in a dependency graph, as the path that closes it (`a -> b -> a`), or null. */
function findCycle(edges: [string, string[]][]): string[] | null {
  const graph = new Map(edges);
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "visiting") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}
