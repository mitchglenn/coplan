// The pages served instead of a plan: an unknown session, or a plan that does not validate yet.

import { html, raw, type Html } from "../render/html.ts";
import { FAVICON } from "../render/parts.ts";
import type { InvalidBootstrap } from "../protocol.ts";
import type { Diagnostic } from "../plan/validate.ts";

export function notFoundPage(): string {
  return simplePage(
    "No such plan",
    html`<p>This review session does not exist. Run <code>coplan open &lt;plan.json&gt;</code> again.</p>`,
  );
}

/** Lists the errors, and loads the review client so the page reloads once the agent fixes them. */
export function invalidPlanPage(file: string, errors: Diagnostic[], bootstrap: InvalidBootstrap): string {
  const list = errors.slice(0, 30).map((e) => html`<li><span class="path">${e.path}</span> ${e.message}</li>`);
  const head = html`<script id="sp-bootstrap" type="application/json">${raw(JSON.stringify(bootstrap).replaceAll("<", "\\u003c"))}</script><script type="module" src="/client/review.js"></script>`;
  return simplePage(
    "Plan has errors",
    html`<h1>The plan on disk does not validate yet</h1><p><code>${file}</code></p><ul>${list}</ul><p>This page reloads by itself once the agent fixes the file.</p>`,
    head,
  );
}

function simplePage(title: string, body: Html, head?: Html): string {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} · Coplan</title><link rel="icon" href="${raw(FAVICON)}">${head}<style>body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#030705;color:#e2e5e8}main{max-width:720px;margin:0 auto;padding:48px 24px}h1{font-size:22px;margin:0 0 12px}code{font:13px ui-monospace,monospace}li{margin:6px 0}.path{color:#f9868f;font-family:ui-monospace,monospace;font-size:13px}</style></head><body><main>${body}</main></body></html>`.toString();
}
