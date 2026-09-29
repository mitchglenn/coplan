import assert from "node:assert/strict";
import { test } from "node:test";
import { html, raw } from "../src/render/html.ts";
import { md } from "../src/render/markdown.ts";

test("interpolated values are escaped unless they are already markup", () => {
  const hostile = `<img src=x onerror="alert('x')">&`;
  assert.equal(
    html`<p title="${hostile}">${hostile}</p>`.toString(),
    `<p title="&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;</p>`,
  );
  assert.equal(html`<div>${html`<b>${"<i>"}</b>`}</div>`.toString(), "<div><b>&lt;i&gt;</b></div>");
  assert.equal(html`${raw("<hr>")}`.toString(), "<hr>");
});

test("null and undefined render nothing; booleans, numbers and arrays render", () => {
  assert.equal(html`[${null}${undefined}]`.toString(), "[]");
  assert.equal(html`<b aria-selected="${false}" tabindex="${0}">`.toString(), '<b aria-selected="false" tabindex="0">');
  assert.equal(
    html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`.toString(),
    "<ul><li>a</li><li>&lt;b&gt;</li></ul>",
  );
});

test("markdown output is trusted markup, with raw HTML in the source shown as text", () => {
  assert.equal(
    html`${md("**hi** <script>x</script>")}`.toString(),
    "<p><strong>hi</strong> &lt;script&gt;x&lt;/script&gt;</p>",
  );
});
