// Small pieces of markup every part of the page uses.

import { html, type Html } from "./html.ts";

/** The Coplan mark, inline so a saved page needs nothing from the network. */
export const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#68fdba"/><path d="M9 11h14M9 16h10M9 21h6" stroke="#003d29" stroke-width="2.6" stroke-linecap="round"/></svg>',
  );

/**
 * The attributes that make an element a review target: hovering it offers a Comment button, and a
 * comment on it reaches the agent with `path`, the element's JSON path in plan.json.
 */
export function target(path: string, kind: string, label: string, id?: string): Html {
  return html` data-sp-target="${path}" data-sp-kind="${kind}" data-sp-label="${label}"${id ? html` data-sp-id="${id}"` : null}`;
}

export const idChip = (id: string | undefined): Html | null => (id ? html`<span class="sp-id">${id}</span>` : null);

export const eyebrow = (text: string): Html => html`<span class="sp-eyebrow">${text}</span>`;

/** File references, such as a finding's refs or a task's files. */
export function refs(list: string[] | undefined): Html | null {
  if (!list?.length) return null;
  return html`<div class="sp-refs">${list.map((ref) => html`<code class="sp-ref">${ref}</code>`)}</div>`;
}

/** Markdown reduced to plain text for a label or tooltip, cut to a readable length. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
