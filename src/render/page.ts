// A validated plan becomes one self-contained HTML page: styles and the tab script are inlined,
// so a saved plan.html works offline. The review client is added only when the server serves the
// page for review; the file on disk never carries it.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { browserCode } from "./browser-code.ts";
import { renderDecisionForm, renderDecisionSummary, renderQuestions, renderSlices, isAnswered } from "./engine-tabs.ts";
import { html, raw, type Html, type Interpolation } from "./html.ts";
import { md } from "./markdown.ts";
import { FAVICON, target } from "./parts.ts";
import { activeCount, renderTab } from "./plan-tabs.ts";
import type { ReadingTime } from "../plan/metrics.ts";
import type { Plan } from "../plan/schema.ts";
import { hasSlices, type Stage } from "../plan/stage.ts";
import type { DecisionAnswer, ReviewBootstrap, ReviewRecord } from "../protocol.ts";

const STYLES = raw(await readFile(new URL("./styles.css", import.meta.url), "utf8"));
const TABS_SCRIPT = raw(await browserCode("render/tabs"));

export interface PageInput {
  plan: Plan;
  stage: Stage;
  reading: ReadingTime;
  /** Absolute path of plan.json; the page shows only its name. */
  file: string;
  /** The reviewer's submitted decision answers. */
  answers?: Record<string, DecisionAnswer>;
  /** Edge cases, risks and gaps the reviewer skipped, by id. */
  skips?: ReviewRecord["skips"];
  /** Set when the server serves the page for review. */
  review?: { bootstrap: ReviewBootstrap } | null;
}

interface PageTab {
  id: string;
  title: string;
  count: number | null;
  body: Interpolation;
  /** Plan tabs come first, then the engine's; slices sit after a divider. */
  group: "plan" | "decisions" | "questions" | "build";
}

export function renderPlanHtml({
  plan,
  stage,
  reading,
  file,
  answers = {},
  skips = {},
  review = null,
}: PageInput): string {
  const tabs = pageTabs(plan, stage, answers, skips);
  const defaultTab = defaultTabFor(plan, stage) ?? tabs[0]?.id ?? "decisions";
  const inDecisions = stage.stage === "decisions";

  const tabButtons = tabs.map((tab) => {
    const selected = tab.id === defaultTab;
    return html`${tab.group === "build" ? html`<span class="sp-tab-rule" aria-hidden="true"></span>` : null}<button class="sp-tab${tab.group === "questions" ? " sp-tab-questions" : null}" type="button" role="tab" id="tab-${tab.id}" data-tab="${tab.id}" aria-controls="panel-${tab.id}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}"><span>${tab.title}</span>${tab.count ? html`<span class="sp-tab-count">${tab.count}</span>` : null}</button>`;
  });
  const panels = tabs.map(
    (tab, i) =>
      html`${i ? "\n" : null}<section class="sp-panel sp-panel-${tab.id}" role="tabpanel" id="panel-${tab.id}" aria-labelledby="tab-${tab.id}" data-panel="${tab.id}"${tab.id === defaultTab ? null : html` hidden`}>${tab.body}</section>`,
  );
  const stampList = stamps(stage);
  const hashes = [
    `decisions ${stage.decisionsHash}`,
    plan.tabs?.length && !inDecisions ? ` · plan ${stage.planHash}` : null,
    stage.slicesHash ? ` · slices ${stage.slicesHash}` : null,
  ];

  return html`<!doctype html>
<html lang="en" data-stage="${stage.stage}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="generator" content="coplan">
<title>${plan.title} · Coplan</title>
<link rel="icon" href="${raw(FAVICON)}">
<script>document.documentElement.classList.add("sp-js")</script>
<style>${STYLES}</style>
${review ? reviewHead(review.bootstrap) : null}
</head>
<body>
<div class="sp-page">
<header class="sp-head">
<div class="sp-kicker"><span class="sp-brand">Coplan</span><span class="sp-stage sp-stage-${stage.stage}">${stage.label}</span><span class="sp-reading">${readingLabel(plan, stage, reading, answers)}</span></div>
<h1 class="sp-title">${plan.title}</h1>
<div class="sp-summary sp-md"${target("summary", "summary", "Summary")}>${md(plan.summary)}</div>
${stampList.length ? html`<div class="sp-stamps">${stampList}</div>` : null}
</header>
<nav class="sp-tabs" role="tablist" aria-label="Plan sections"><div class="sp-tabs-inner">${tabButtons}</div></nav>
<main class="sp-main" data-default-tab="${defaultTab}">
${panels}
</main>
<footer class="sp-foot"><span><code>${basename(file)}</code></span><span>${hashes}</span></footer>
</div>
<script>${TABS_SCRIPT}</script>
</body>
</html>
`.toString();
}

/** The plan's own tabs (once the decisions are in), then the tabs the engine adds. */
function pageTabs(
  plan: Plan,
  stage: Stage,
  answers: Record<string, DecisionAnswer>,
  skips: ReviewRecord["skips"],
): PageTab[] {
  if (stage.stage === "decisions") {
    return [
      {
        id: "decisions",
        title: "Key decisions",
        count: plan.decisions.length,
        body: renderDecisionForm(plan.decisions),
        group: "decisions",
      },
    ];
  }
  const tabs: PageTab[] = (plan.tabs ?? []).map((tab, t) => ({
    id: tab.id,
    title: tab.title,
    count: activeCount(tab, skips),
    body: html`${tab.intro ? html`<div class="sp-md sp-intro">${md(tab.intro)}</div>` : null}${renderTab(tab, `tabs[${t}]`, skips)}`,
    group: "plan",
  }));
  tabs.push({
    id: "decisions",
    title: "Decisions",
    count: null,
    body: renderDecisionSummary(plan.decisions, answers),
    group: "decisions",
  });
  if (plan.questions.length) {
    tabs.push({
      id: "questions",
      title: "Questions",
      count: plan.questions.length,
      body: renderQuestions(plan.questions),
      group: "questions",
    });
  }
  if (hasSlices(plan)) {
    tabs.push({
      id: "slices",
      title: "Slices",
      count: plan.slices.length,
      body: renderSlices(plan.slices),
      group: "build",
    });
  }
  return tabs;
}

/** The tab a page opens on: whatever the reviewer has to act on now, else the first tab. */
function defaultTabFor(plan: Plan, stage: Stage): string | null {
  if (hasSlices(plan) && (stage.stage === "slices_review" || stage.stage === "approved")) return "slices";
  if (stage.stage === "decisions" || stage.stage === "drafting") return "decisions";
  return null;
}

/**
 * The review client's entry points. The bootstrap is JSON inside a script element; escaping `<`
 * keeps a `</script>` in plan content from closing it.
 */
function reviewHead(bootstrap: ReviewBootstrap): Html {
  return html`<link rel="stylesheet" href="/client/review.css">
<script id="sp-bootstrap" type="application/json">${raw(JSON.stringify(bootstrap).replaceAll("<", "\\u003c"))}</script>
<script type="module" src="/client/review.js"></script>`;
}

function stamps(stage: Stage): Html[] {
  const ok = (text: string) => html`<span class="sp-stamp sp-stamp-ok">${text}</span>`;
  const stale = (text: string) => html`<span class="sp-stamp sp-stamp-stale">${text}</span>`;
  const list: Html[] = [];
  if (stage.decisionsStale) list.push(stale("Decisions changed since you answered · please review"));
  if (stage.planApproved) {
    list.push(
      ok(
        `Plan approved ${formatStamp(stage.planApprovedAt)}${stage.slicesSkipped ? " · building without slices" : ""}`,
      ),
    );
  }
  if (stage.planApprovalStale) list.push(stale("Plan changed after approval · needs re-approval"));
  if (stage.slicesApproved) list.push(ok(`Slices approved ${formatStamp(stage.slicesApprovedAt)}`));
  if (stage.slicesApprovalStale) list.push(stale("Slices changed after approval · needs re-approval"));
  return list;
}

function formatStamp(iso: string | null): string {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return iso ?? "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function readingLabel(plan: Plan, stage: Stage, reading: ReadingTime, answers: Record<string, DecisionAnswer>): string {
  if (stage.stage === "decisions") return `${plan.decisions.length} decisions · all optional`;
  if (stage.stage === "drafting") {
    const answered = plan.decisions.filter((d) => isAnswered(answers[d.id])).length;
    return `${answered} of ${plan.decisions.length} decisions answered`;
  }
  if (stage.phase === "slices" || stage.stage === "slicing" || stage.stage === "approved") {
    return `${reading.plan_minutes} min plan${reading.slices_minutes ? ` · ${reading.slices_minutes} min slices` : ""}`;
  }
  return `${reading.plan_minutes} min read`;
}
