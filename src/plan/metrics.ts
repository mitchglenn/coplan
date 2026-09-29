// Measurements of a plan: how long it takes to read, how its slices group into waves, and how many
// items each tab holds.

import {
  BUDGET_MINUTES,
  type Budget,
  type EdgeCase,
  type Gap,
  type Plan,
  type Risk,
  type Slice,
  type Tab,
} from "./schema.ts";
import { hasSlices, hasTabs } from "./stage.ts";
import { countWords, type Diagnostic } from "./validate.ts";

/** Past this, a plan cannot be reviewed in one sitting, whatever its budget. */
const MAX_READING_MINUTES = 15;

// Reading time is what keeps a plan reviewable in one sitting. Prose is counted at a careful
// technical-reading pace, and each figure or table costs a fixed look-over on top of its words.
const WORDS_PER_MINUTE = 200;
const FIGURE_MINUTES = 0.35;
/** Keys whose values are identifiers or markup, not prose a reviewer reads. */
const UNREAD_KEYS = new Set(["id", "kind", "type", "$schema", "html"]);

export interface ReadingTime {
  plan_minutes: number;
  plan_words: number;
  slices_minutes: number;
  decisions: number;
  budget: Budget;
  budget_minutes: number;
}

/** Reading estimates for the part under review and for the slices. */
export function readingTime(plan: Plan): ReadingTime {
  const { slices, decisions: _decisions, $schema: _schema, ...planPart } = plan;
  const planReading = minutesFor(planPart, figureCount(plan.tabs ?? []));
  const slicesReading = hasSlices(plan) ? minutesFor(slices, 0) : { words: 0, minutes: 0 };
  return {
    plan_minutes: planReading.minutes,
    plan_words: planReading.words,
    slices_minutes: slicesReading.minutes,
    decisions: plan.decisions.length,
    budget: plan.budget,
    budget_minutes: BUDGET_MINUTES[plan.budget],
  };
}

/** Budget warnings, phrased for the agent. */
export function budgetWarnings(plan: Plan): Diagnostic[] {
  if (!hasTabs(plan)) return [];
  const reading = readingTime(plan);
  if (reading.plan_minutes > MAX_READING_MINUTES) {
    return [
      {
        path: "(plan)",
        message: `reads in about ${reading.plan_minutes} min, past the ${MAX_READING_MINUTES} min ceiling. Cut it: merge overlapping edge cases, drop low-priority detail into gaps, and keep one flow per meaningful path`,
      },
    ];
  }
  if (reading.plan_minutes > reading.budget_minutes) {
    return [
      {
        path: "budget",
        message: `reads in about ${reading.plan_minutes} min, over the ${reading.budget} budget of ${reading.budget_minutes} min. Trim it, or raise budget only if the feature genuinely needs it`,
      },
    ];
  }
  return [];
}

function minutesFor(value: unknown, figures: number) {
  const count = { words: 0, figures };
  collectText(value, count);
  const minutes = count.words / WORDS_PER_MINUTE + count.figures * FIGURE_MINUTES;
  return { words: count.words, minutes: Math.max(1, Math.round(minutes * 2) / 2) };
}

function collectText(value: unknown, count: { words: number; figures: number }) {
  if (typeof value === "string") count.words += countWords(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectText(entry, count));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (UNREAD_KEYS.has(key)) continue;
      // Code is scanned rather than read: a figure, plus a word and a half per line.
      if (key === "code" && typeof entry === "string") {
        count.figures += 1;
        count.words += Math.ceil(entry.split("\n").length * 1.5);
        continue;
      }
      collectText(entry, count);
    }
  }
}

function figureCount(tabs: Tab[]): number {
  let figures = 0;
  for (const tab of tabs) {
    if (tab.kind === "flows") figures += tab.flows.length;
    if (tab.kind === "custom") figures += tab.blocks.filter((b) => b.type === "table" || b.type === "html").length;
  }
  return figures;
}

/**
 * Group slices into waves: every slice in a wave depends only on slices in earlier waves, so the
 * slices within one wave can be built in parallel.
 */
export function sliceWaves(slices: Slice[]): string[][] {
  const remaining = new Map(slices.map((slice) => [slice.id, new Set(slice.depends_on)]));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining]
      .filter(([, dependencies]) => [...dependencies].every((d) => done.has(d)))
      .map(([id]) => id);
    if (!wave.length) break; // a cycle; validation reports it
    for (const id of wave) {
      remaining.delete(id);
      done.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

/** How many items a tab holds, for its badge; null for tabs that are not lists. */
export function tabCount(tab: Tab): number | null {
  switch (tab.kind) {
    case "flows":
      return tab.flows.length;
    case "concepts":
      return tab.entities.length;
    case "edge_cases":
      return tab.cases.length;
    case "security":
      return tab.risks.length;
    case "gaps":
      return tab.gaps.length;
    default:
      return null;
  }
}

/** The records in a tab the reviewer may skip: edge cases, security risks and gaps. */
export function skippableRecords(tab: Tab): (EdgeCase | Risk | Gap)[] {
  if (tab.kind === "edge_cases") return tab.cases;
  if (tab.kind === "security") return tab.risks;
  if (tab.kind === "gaps") return tab.gaps;
  return [];
}
