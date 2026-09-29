import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// A published package runs the compiled JavaScript, which the source-mode tests never load.

let out: string;

before(async () => {
  out = join(await mkdtemp(join(tmpdir(), "coplan-build-")), "dist");
  execFileSync(process.execPath, ["scripts/build.ts", out], { stdio: "ignore" });
});

after(async () => {
  await rm(join(out, ".."), { recursive: true, force: true });
});

test("the tab script compiles to a classic script it can be inlined as", async () => {
  const code = await readFile(join(out, "render/tabs.js"), "utf8");
  assert.doesNotThrow(() => new Function(code), "an `export` would break the inline <script>");
});

test("compiled browser modules import each other as .js", async () => {
  const code = await readFile(join(out, "client/review.js"), "utf8");
  assert.match(code, /from "\.\/store\.js"/);
  assert.doesNotMatch(code, /from "\.\/[a-z-]+\.ts"/);
});

test("the build carries the stylesheets", async () => {
  for (const stylesheet of ["render/styles.css", "client/review.css"]) {
    assert.ok((await readFile(join(out, stylesheet), "utf8")).length > 1000, stylesheet);
  }
});
