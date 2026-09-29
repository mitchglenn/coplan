// The tabs an agent writes: one renderer per tab kind.

import { html, raw, type Html, type Interpolation } from "./html.ts";
import { md, mdInline } from "./markdown.ts";
import { eyebrow, idChip, plainText, refs, target } from "./parts.ts";
import { renderSequence } from "./sequence.ts";
import { skippableRecords, tabCount } from "../plan/metrics.ts";
import type { Block, Priority, Tab, TabOf } from "../plan/schema.ts";
import type { ReviewRecord } from "../protocol.ts";

type Skips = ReviewRecord["skips"];

const PRIORITY_LABELS: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
const TONE_LABELS = { note: "Note", decision: "Decision", warning: "Warning", risk: "Risk" } as const;
const STATE_COLUMNS = [
  ["creates", "Creates"],
  ["updates", "Updates"],
  ["reads", "Reads / derives"],
] as const;

/** A tab's body. `path` is the tab's JSON path, such as `tabs[2]`. */
export function renderTab(tab: Tab, path: string, skips: Skips): Interpolation {
  switch (tab.kind) {
    case "overview":
      return renderOverview(tab, path);
    case "flows":
      return renderFlows(tab, path);
    case "concepts":
      return renderConcepts(tab, path);
    case "edge_cases":
      return groupedByPriority(
        tab.cases,
        (c) => c.priority,
        skips,
        (c, i) =>
          skippableItem({
            path: `${path}.cases[${i}]`,
            kind: "edge_case",
            record: c,
            skips,
            body: html`<div class="sp-md">${md(c.detail)}</div>`,
          }),
      );
    case "security":
      return groupedByPriority(
        tab.risks,
        (r) => r.level,
        skips,
        (r, i) =>
          skippableItem({
            path: `${path}.risks[${i}]`,
            kind: "risk",
            record: r,
            skips,
            body: html`<div class="sp-md">${md(r.exposure)}</div><div class="sp-mitigations">${eyebrow("Mitigation paths")}<ul>${r.mitigations.map((m) => html`<li>${mdInline(m)}</li>`)}</ul></div>`,
          }),
      );
    case "gaps":
      return html`<div class="sp-gaps">${tab.gaps.map((g, i) =>
        skippableItem({
          path: `${path}.gaps[${i}]`,
          kind: "gap",
          record: g,
          skips,
          body: html`<div class="sp-md">${md(g.detail)}</div>`,
        }),
      )}</div>`;
    case "custom":
      return tab.blocks.map((block, i) => renderBlock(block, `${path}.blocks[${i}]`));
  }
}

/** A tab's badge count, leaving out anything the reviewer skipped. */
export function activeCount(tab: Tab, skips: Skips): number | null {
  const count = tabCount(tab);
  if (count === null) return null;
  return count - skippableRecords(tab).filter((record) => skips[record.id]).length;
}

function renderOverview(tab: TabOf<"overview">, path: string): Html {
  const prose = (
    [
      ["problem", "Today", tab.problem],
      ["change", "The change", tab.change],
    ] as const
  ).map(
    ([key, title, body]) =>
      html`<div class="sp-prose-block"${target(`${path}.${key}`, key, title)}><h2 class="sp-section-title">${title}</h2><div class="sp-md">${md(body)}</div></div>`,
  );
  const goals = tab.goals.map(
    (goal, i) =>
      html`<li class="sp-goal"${target(`${path}.goals[${i}]`, "goal", `Goal: ${goal.title}`)}><span class="sp-goal-title">${mdInline(goal.title)}</span>${goal.detail ? html`<div class="sp-md sp-muted">${md(goal.detail)}</div>` : null}</li>`,
  );
  const outOfScope = tab.out_of_scope.map(
    (item, i) =>
      html`<li${target(`${path}.out_of_scope[${i}]`, "out_of_scope", `Out of scope: ${plainText(item)}`)}>${mdInline(item)}</li>`,
  );
  const findings = tab.findings.length
    ? html`<section class="sp-section"><h2 class="sp-section-title">What the codebase says</h2><ul class="sp-findings">${tab.findings.map(
        (finding, i) =>
          html`<li${target(`${path}.findings[${i}]`, "finding", `Finding: ${plainText(finding.note)}`)}><div class="sp-md">${md(finding.note)}</div>${refs(finding.refs)}</li>`,
      )}</ul></section>`
    : null;

  return html`${prose}<div class="sp-split"><section class="sp-section"><h2 class="sp-section-title">Goals</h2><ol class="sp-goals">${goals}</ol></section><section class="sp-section"><h2 class="sp-section-title">Out of scope</h2><ul class="sp-oos">${outOfScope}</ul></section></div>${findings}`;
}

function renderFlows(tab: TabOf<"flows">, path: string): Html[] {
  return tab.flows.map((flow, i) => {
    const flowPath = `${path}.flows[${i}]`;
    const changes = flow.state;
    const state = changes
      ? html`<div class="sp-state">${STATE_COLUMNS.map(
          ([key, title]) =>
            html`<div class="sp-state-col"${target(`${flowPath}.state.${key}`, "state", `${flow.id} ${title}`)}>${eyebrow(title)}${
              changes[key].length
                ? html`<ul>${changes[key].map((entry) => html`<li>${mdInline(entry)}</li>`)}</ul>`
                : html`<p class="sp-none">Nothing</p>`
            }</div>`,
        )}</div>`
      : null;
    return html`<article class="sp-card sp-flow"${target(flowPath, "flow", `Flow ${flow.id}: ${flow.title}`, flow.id)}>
<header class="sp-card-head">${idChip(flow.id)}<h2 class="sp-card-title">${mdInline(flow.title)}</h2></header>
<div class="sp-trigger"${target(`${flowPath}.trigger`, "trigger", `${flow.id} trigger`)}>${eyebrow("Trigger")}<div class="sp-md">${md(flow.trigger)}</div></div>
<figure class="sp-figure"><div class="sp-figure-scroll">${renderSequence(flow, flowPath)}</div></figure>
${state}${flow.notes ? html`<div class="sp-md sp-notes">${md(flow.notes)}</div>` : null}
</article>`;
  });
}

function renderConcepts(tab: TabOf<"concepts">, path: string): Html[] {
  return tab.entities.map((entity, i) => {
    const entityPath = `${path}.entities[${i}]`;
    const column = (key: "rules" | "constraints", title: string) => {
      const kind = key === "rules" ? "rule" : "constraint";
      return entity[key].length
        ? html`<div class="sp-rule-col">${eyebrow(title)}<ul>${entity[key].map(
            (entry, j) =>
              html`<li${target(`${entityPath}.${key}[${j}]`, kind, `${entity.name} ${kind}: ${plainText(entry)}`)}>${mdInline(entry)}</li>`,
          )}</ul></div>`
        : null;
    };
    const columns = [column("rules", "Rules"), column("constraints", "Constraints")].filter((c) => c !== null);
    return html`<article class="sp-card sp-entity"${target(entityPath, "entity", `${entity.id}: ${entity.name}`, entity.id)}>
<header class="sp-card-head">${idChip(entity.id)}<h2 class="sp-card-title">${mdInline(entity.name)}</h2></header>
<div class="sp-md sp-definition">${md(entity.definition)}</div>
${columns.length ? html`<div class="sp-rules">${columns}</div>` : null}
</article>`;
  });
}

/** Items grouped under High, Medium and Low headings, each heading counting what is not skipped. */
function groupedByPriority<T extends { id: string }>(
  items: T[],
  priorityOf: (item: T) => Priority,
  skips: Skips,
  renderItem: (item: T, index: number) => Html,
): Html[] {
  return (["high", "medium", "low"] as const).flatMap((level) => {
    const group = items.map((item, index) => ({ item, index })).filter(({ item }) => priorityOf(item) === level);
    if (!group.length) return [];
    const skipped = group.filter(({ item }) => skips[item.id]).length;
    return [
      html`<section class="sp-priority-group sp-level-${level}"><h2 class="sp-priority-head"><span class="sp-level-dot" aria-hidden="true"></span>${PRIORITY_LABELS[level]}<span class="sp-count">${group.length - skipped}</span>${skipped ? html`<span class="sp-count-skipped">${skipped} skipped</span>` : null}</h2><div class="sp-priority-items">${group.map(
        ({ item, index }) => renderItem(item, index),
      )}</div></section>`,
    ];
  });
}

function renderBlock(block: Block, path: string): Html {
  const attrs = target(path, "block", `${block.id ? `${block.id}: ` : ""}${blockLabel(block)}`, block.id);
  switch (block.type) {
    case "markdown":
      return html`<div class="sp-block sp-md"${attrs}>${md(block.body)}</div>`;
    case "callout":
      return html`<aside class="sp-block sp-callout sp-tone-${block.tone}"${attrs}>${eyebrow(TONE_LABELS[block.tone])}${block.title ? html`<h3 class="sp-item-title">${mdInline(block.title)}</h3>` : null}<div class="sp-md">${md(block.body)}</div></aside>`;
    case "table":
      return html`<figure class="sp-block sp-table-wrap"${attrs}>${caption(block.caption)}<div class="sp-table-scroll"><table class="sp-table"><thead><tr>${block.columns.map(
        (column) => html`<th scope="col">${mdInline(column)}</th>`,
      )}</tr></thead><tbody>${block.rows.map(
        (row) => html`<tr>${row.map((cell) => html`<td>${mdInline(cell)}</td>`)}</tr>`,
      )}</tbody></table></div></figure>`;
    case "code": {
      const head =
        block.path || block.caption || block.language
          ? html`<figcaption>${block.path ? html`<code>${block.path}</code>` : null}${block.caption ? html`<span>${mdInline(block.caption)}</span>` : null}${!block.path && !block.caption ? block.language : null}</figcaption>`
          : null;
      return html`<figure class="sp-block sp-code"${attrs}>${head}<pre><code>${block.code}</code></pre></figure>`;
    }
    case "html":
      // Rendered as written, scripts included; the guide asks agents to scope them to the block.
      return html`<figure class="sp-block sp-html"${attrs}><div class="sp-html-body">${raw(block.html)}</div>${caption(block.caption)}</figure>`;
  }
}

/** How a block is named in the review panel: its caption, a callout's title or tone, or its type. */
function blockLabel(block: Block): string {
  if ("caption" in block && block.caption) return block.caption;
  if (block.type === "callout") return block.title || TONE_LABELS[block.tone];
  return block.type;
}

const caption = (text: string | undefined) => (text ? html`<figcaption>${mdInline(text)}</figcaption>` : null);

// --- skippable items ---

/**
 * An edge case, security risk or gap the reviewer can skip. Skips are the reviewer's call and live
 * in the review record; a skipped item stays in the plan, dimmed and marked, so it reads as a decision.
 */
function skippableItem({
  path,
  kind,
  record,
  skips,
  body,
}: {
  path: string;
  kind: string;
  record: { id: string; title: string };
  skips: Skips;
  body: Html;
}): Html {
  const skipped = Boolean(skips[record.id]);
  return html`<article class="sp-item sp-skippable${skipped ? " sp-skipped" : null}"${target(path, kind, `${record.id}: ${record.title}`, record.id)} data-sp-skippable="${record.id}"${skipped ? html` data-sp-skipped` : null}><header class="sp-item-head">${idChip(record.id)}<h3 class="sp-item-title">${mdInline(record.title)}</h3>${skipped ? html`<span class="sp-skip-pill">Skipped</span>` : null}</header><div class="sp-item-body">${body}</div></article>`;
}
