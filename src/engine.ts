// The one path from plan.json on disk to a validated, staged, renderable plan. The CLI and the
// server both go through here, so they never disagree about whether a plan is valid or what stage
// it is in.

import { readFile } from "node:fs/promises";
import { budgetWarnings, readingTime, type ReadingTime } from "./plan/metrics.ts";
import type { Plan } from "./plan/schema.ts";
import { checkPhaseRules, deriveStage, type Stage } from "./plan/stage.ts";
import { parsePlan, type Diagnostic } from "./plan/validate.ts";
import type { ReviewBootstrap, ReviewRecord } from "./protocol.ts";
import { renderPlanHtml } from "./render/page.ts";
import { htmlPathFor, readReview, writeFileAtomic } from "./review-store.ts";

export interface LoadedPlan {
  ok: true;
  plan: Plan;
  stage: Stage;
  reading: ReadingTime;
  review: ReviewRecord;
  warnings: Diagnostic[];
}

export interface InvalidPlan {
  ok: false;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Absent when the plan file itself could not be read. */
  review?: ReviewRecord;
}

export type LoadResult = LoadedPlan | InvalidPlan;

/**
 * Everything the CLI and the server need to know about a plan on disk.
 * @param file absolute path to plan.json
 * @param options.review a review record already in hand, to skip reading it again
 */
export async function loadPlan(file: string, { review }: { review?: ReviewRecord } = {}): Promise<LoadResult> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, errors: [{ path: "(file)", message: `${file} does not exist` }], warnings: [] };
    }
    throw error;
  }
  const result = parsePlan(source);
  const record = review ?? (await readReview(file));
  if (!result.ok) return { ok: false, errors: result.errors, warnings: result.warnings, review: record };
  const phaseErrors = checkPhaseRules(result.plan, record);
  if (phaseErrors.length) return { ok: false, errors: phaseErrors, warnings: result.warnings, review: record };
  return {
    ok: true,
    plan: result.plan,
    stage: deriveStage(result.plan, record),
    reading: readingTime(result.plan),
    review: record,
    warnings: [...result.warnings, ...budgetWarnings(result.plan)],
  };
}

/** Render a loaded plan. `bootstrap` is set when the server serves the page for review. */
export function renderLoaded(loaded: LoadedPlan, file: string, bootstrap?: ReviewBootstrap): string {
  return renderPlanHtml({
    plan: loaded.plan,
    stage: loaded.stage,
    reading: loaded.reading,
    answers: loaded.review.decisions?.answers ?? {},
    skips: loaded.review.skips,
    file,
    review: bootstrap ? { bootstrap } : null,
  });
}

/** Validate, then write the portable `<name>.html` next to the plan. */
export async function renderToDisk(file: string): Promise<(LoadedPlan & { htmlFile: string }) | InvalidPlan> {
  const loaded = await loadPlan(file);
  if (!loaded.ok) return loaded;
  const htmlFile = htmlPathFor(file);
  await writeFileAtomic(htmlFile, renderLoaded(loaded, file));
  return { ...loaded, htmlFile };
}
