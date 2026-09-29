// Markdown fields are prose. Raw HTML in them is shown as text rather than rendered, so the only
// way markup enters a plan is an explicit `html` block.

import { Marked } from "marked";
import { escapeHtml, raw, type Html } from "./html.ts";

/** Relative links, anchors, http(s) and mailto. Anything else with a scheme is dropped. */
const SAFE_HREF = /^(https?:|mailto:|#|\.{0,2}\/|[^:]+$)/i;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href)) return inner;
      const external = /^https?:/i.test(href);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      const target = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${escapeHtml(href)}"${titleAttr}${target}>${inner}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Block Markdown: paragraphs, lists, code, tables. */
export function md(value: string | undefined): Html {
  if (!value) return raw("");
  return raw(marked.parse(value, { async: false }).trim());
}

/** Inline Markdown for labels and list items: emphasis, code and links, no block wrappers. */
export function mdInline(value: string | undefined): Html {
  if (!value) return raw("");
  return raw(marked.parseInline(value, { async: false }).trim());
}
