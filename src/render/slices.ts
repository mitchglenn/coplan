// The Execution tab: the plan broken into vertical slices, grouped into phases. Once the slices are
// approved the same tab tracks the build from what the agent reports: a progress overview, each
// task's status with its commits and links, and finished slices folded to one line.

import { html, raw, type Html } from "./html.ts";
import { md, mdInline } from "./markdown.ts";
import { eyebrow, formatTime, idChip, plainText, plural, target } from "./parts.ts";
import type { BuildProgress, SliceStatus, TaskProgress } from "../plan/build.ts";
import { slicePhases } from "../plan/metrics.ts";
import type { Slice, Task } from "../plan/schema.ts";
import type { Link, TaskStatus } from "../protocol.ts";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  committed: "Committed",
  built: "Built, waiting for your review",
  in_progress: "Agent is building",
  ready: "Ready",
  waiting: "Waiting",
};

const SLICE_LABELS: Record<SliceStatus, string> = {
  done: "Done",
  building: "Building",
  ready: "Ready",
  waiting: "Waiting",
};

const ICONS = {
  check: raw(
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3 5 8.6l4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  eye: raw(
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6s1.8-3.3 5-3.3S11 6 11 6 9.2 9.3 6 9.3 1 6 1 6Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6" r="1.4" fill="currentColor"/></svg>',
  ),
  pr: raw(
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 5.3v5.4M12 10.7V6.5c0-1.4-1-2.4-2.4-2.4H7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 2.4 7.3 4.1 9 5.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
  commit: raw(
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1 8h4.4M10.6 8H15" stroke="currentColor" stroke-width="1.5"/></svg>',
  ),
};

/** `progress` is set once the slices are approved; until then the tab is the slices under review. */
export function renderSlices(slices: Slice[], progress: BuildProgress | null): Html {
  const top = progress ? buildOverview(slices, progress) : phaseStrip(slices);
  return html`${top}${slices.map((slice, i) => renderSlice(slice, i, progress))}`;
}

// --- above the slices ---

function phaseStrip(slices: Slice[]): Html {
  const phases = slicePhases(slices);
  const taskCount = slices.reduce((sum, s) => sum + s.tasks.length, 0);
  const titles = new Map(slices.map((s) => [s.id, s.title]));
  const rows = phases.map(
    (phase, i) =>
      html`<li class="sp-phase"><span class="sp-phase-label">Phase ${i + 1}</span><span class="sp-phase-items">${phase.map(
        (id) =>
          html`<a class="sp-phase-chip" href="#slice-${id}" data-sp-jump="slice-${id}">${idChip(id)}<span class="sp-phase-title">${mdInline(titles.get(id))}</span></a>`,
      )}</span></li>`,
  );
  return html`<div class="sp-slices-summary"><p class="sp-muted">${plural(slices.length, "vertical slice")} · ${plural(taskCount, "task")} · ${plural(phases.length, "phase")}. Slices in the same phase do not depend on each other and can be built in parallel.</p><ol class="sp-phases">${rows}</ol></div>`;
}

function buildOverview(slices: Slice[], progress: BuildProgress): Html {
  const { summary } = progress;
  const statusOf = (task: Task): TaskStatus => progress.tasks.get(task.id)?.status ?? "waiting";
  const meta = [
    summary.awaiting_review.length
      ? html`<b class="sp-build-review">${summary.awaiting_review.length} waiting for your review</b>`
      : null,
    summary.in_progress.length ? html`<span>${summary.in_progress.length} in progress</span>` : null,
    !summary.in_progress.length && !summary.awaiting_review.length && summary.next.length
      ? html`<span>Next up: ${summary.next.slice(0, 3).join(", ")}</span>`
      : null,
  ].filter((part) => part !== null);
  const bar = slices.map(
    (slice) =>
      html`<span class="sp-build-bar-slice" style="flex:${slice.tasks.length}">${slice.tasks.map(
        (task) =>
          html`<span class="sp-build-seg sp-st-${statusOf(task)}" title="${task.id} · ${STATUS_LABELS[statusOf(task)]}"></span>`,
      )}</span>`,
  );
  const bySlice = new Map(slices.map((s) => [s.id, s]));
  const rows = slicePhases(slices).map((phase, i) => {
    const cards = phase.map((id) => {
      const slice = bySlice.get(id);
      if (!slice) return null;
      const done = slice.tasks.filter((t) => statusOf(t) === "committed").length;
      return html`<a class="sp-phase-card" href="#slice-${id}" data-sp-jump="slice-${id}">${idChip(id)}<span class="sp-phase-title">${mdInline(slice.title)}</span><span class="sp-phase-card-foot"><span class="sp-dots">${slice.tasks.map((t) => html`<span class="sp-dot sp-st-${statusOf(t)}"></span>`)}</span>${done} of ${slice.tasks.length} committed</span></a>`;
    });
    return html`<li class="sp-phase"><span class="sp-phase-label">Phase ${i + 1}</span><span class="sp-phase-cards">${cards}</span></li>`;
  });
  const legend = (["committed", "built", "in_progress", "ready", "waiting"] as const).map(
    (status) => html`<span>${statusNode(status, false)}${STATUS_LABELS[status]}</span>`,
  );
  return html`<section class="sp-build" aria-label="Build progress">
<div class="sp-build-head"><p class="sp-build-count"><strong>${summary.committed}</strong> of ${plural(summary.total, "task")} committed</p>${meta.length ? html`<p class="sp-build-meta">${meta.map((part, i) => html`${i ? " · " : null}${part}`)}</p>` : null}</div>
<div class="sp-build-bar" role="img" aria-label="${summary.committed} of ${summary.total} tasks committed">${bar}</div>
<ol class="sp-phases sp-phases-build">${rows}</ol>
<div class="sp-legend">${legend}</div>
</section>`;
}

// --- one slice ---

function renderSlice(s: Slice, i: number, progress: BuildProgress | null): Html {
  const slicePath = `slices[${i}]`;
  const status = progress?.slices.get(s.id) ?? null;
  const committed = progress ? s.tasks.filter((t) => progress.tasks.get(t.id)?.status === "committed").length : 0;
  const depLinks = s.depends_on.map((d) => {
    const done = progress?.slices.get(d) === "done";
    return html`<a class="sp-dep${done ? " sp-dep-done" : null}" href="#slice-${d}" data-sp-jump="slice-${d}">${d}${done ? html`<span class="sp-visually-hidden"> (done)</span>` : null}</a>`;
  });

  const acceptance = s.acceptance.map(
    (criterion, j) =>
      html`<li${target(`${slicePath}.acceptance[${j}]`, "criterion", `${s.id} acceptance: ${plainText(criterion)}`)}>${mdInline(criterion)}</li>`,
  );
  const tasksHead = eyebrow(
    progress ? `Tasks · ${committed} of ${s.tasks.length} committed` : `Tasks · ${s.tasks.length}`,
  );
  const list = html`<ol class="sp-tasks${progress ? " sp-tasks-build" : null}">${s.tasks.map((t, j) => renderTask(t, `${slicePath}.tasks[${j}]`, progress?.tasks.get(t.id) ?? null))}</ol>`;
  const body = html`<div class="sp-md sp-slice-goal">${md(s.goal)}</div>
${s.demo ? html`<div class="sp-demo"${target(`${slicePath}.demo`, "demo", `${s.id} demo`)}>${eyebrow("Demo")}<div class="sp-md">${md(s.demo)}</div></div>` : null}
<section class="sp-slice-tasks">${tasksHead}${list}</section>
<section class="sp-slice-acceptance">${eyebrow("Acceptance")}<ul class="sp-criteria">${acceptance}</ul></section>
${s.notes ? html`<div class="sp-md sp-notes">${md(s.notes)}</div>` : null}`;

  const head = html`<header class="sp-card-head">${idChip(s.id)}<h2 class="sp-card-title">${mdInline(s.title)}</h2></header>`;
  const article = (inner: Html) =>
    html`<article class="sp-card sp-slice${status ? html` sp-slice-${status}` : null}" id="slice-${s.id}"${target(slicePath, "slice", `${s.id}: ${s.title}`, s.id)}>
${head}
${inner}
</article>`;

  if (!status) {
    const deps = depLinks.length ? html`<p class="sp-deps">${eyebrow("Depends on")}${depLinks}</p>` : null;
    return article(html`${deps}${body}`);
  }
  const state = html`<span class="sp-slice-pill sp-slice-pill-${status}">${SLICE_LABELS[status]}</span><span class="sp-slice-count"><b>${committed} of ${s.tasks.length}</b> committed</span>${depLinks.length ? html`<span class="sp-slice-deps">Depends on ${depLinks}</span>` : null}`;
  if (status === "done") {
    return article(
      html`<details class="sp-slice-fold"><summary class="sp-slice-state">${state}<span class="sp-fold-toggle"><span class="sp-fold-show">Show ${plural(s.tasks.length, "task")}</span><span class="sp-fold-hide">Hide tasks</span></span></summary>
${body}
</details>`,
    );
  }
  return article(html`<div class="sp-slice-state">${state}</div>
${body}`);
}

// --- one task ---

function renderTask(t: Task, path: string, progress: TaskProgress | null): Html {
  const meta = [
    t.layer ? html`<span class="sp-layer">${t.layer}</span>` : null,
    t.size ? html`<span class="sp-size" title="Relative size">${t.size}</span>` : null,
  ];
  const head = html`<div class="sp-task-head">${idChip(t.id)}<span class="sp-task-title">${mdInline(t.title)}</span><span class="sp-task-meta">${meta}</span></div>`;
  const detail = t.detail ? html`<div class="sp-md sp-muted">${md(t.detail)}</div>` : null;
  const reviewTarget = target(path, "task", `${t.id}: ${t.title}`, t.id);

  if (!progress) {
    const deps = t.depends_on.length
      ? html`<span class="sp-task-deps">after ${t.depends_on.map((d, k) => html`${k ? ", " : null}<code>${d}</code>`)}</span>`
      : null;
    return html`<li class="sp-task"${reviewTarget}>${head}${detail}${deps ? html`<div class="sp-task-foot">${deps}</div>` : null}</li>`;
  }

  const line = statusLine(progress);
  return html`<li class="sp-task sp-task-${progress.status}"${reviewTarget}>${statusNode(progress.status, true)}<div class="sp-task-body">${head}${line ? html`<div class="sp-task-status">${line}</div>` : null}${detail}</div></li>`;
}

export function statusNode(status: TaskStatus, labelled: boolean): Html {
  const icon = status === "committed" ? ICONS.check : status === "built" ? ICONS.eye : null;
  return html`<span class="sp-node sp-st-${status}" aria-hidden="true">${icon}</span>${labelled ? html`<span class="sp-visually-hidden">${STATUS_LABELS[status]}: </span>` : null}`;
}

/** What the task's status line says; a ready task with nothing linked has none, its node says it. */
function statusLine({ status, record, blockedBy }: TaskProgress): Html | null {
  const links = record ? [record.pr ? prLink(record.pr) : null, record.jira ? jiraLink(record.jira) : null] : [];
  switch (status) {
    case "committed": {
      const commits = record?.commits ?? [];
      return html`${commits.map((c) => html`<code class="sp-commit" title="${c.sha}">${ICONS.commit}${c.sha.slice(0, 7)}</code>`)}${links}<span>Committed ${formatTime(commits.at(-1)?.at ?? null, { year: false })}</span>`;
    }
    case "built":
      return html`<span class="sp-status-built">Built ${formatTime(record?.built_at ?? null, { year: false })} · waiting for your review</span>${links}`;
    case "in_progress":
      return html`<span class="sp-status-working">Agent is building this · started ${formatTime(record?.started_at ?? null, { year: false })}</span>${links}`;
    case "ready":
      return links.some((link) => link !== null) ? html`${links}` : null;
    case "waiting":
      return html`<span class="sp-task-waiting">Waiting on ${blockedBy.map((id, k) => html`${k ? ", " : null}<code>${id}</code>`)}</span>${links}`;
  }
}

function prLink(link: Link): Html {
  const number = /\/pull\/(\d+)/.exec(link.url)?.[1];
  return html`<a class="sp-link" href="${link.url}" target="_blank" rel="noopener noreferrer" title="Pull request">${ICONS.pr}${number ? `#${number}` : "Pull request"}</a>`;
}

function jiraLink(link: Link): Html {
  const key = /\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(link.url)?.[1];
  return html`<a class="sp-link" href="${link.url}" target="_blank" rel="noopener noreferrer" title="Jira issue"><span class="sp-link-kind">Jira</span>${key ?? "Issue"}</a>`;
}
