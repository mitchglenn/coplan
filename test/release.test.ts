import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareVersions, nextVersion } from "../scripts/semver.ts";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("the package, its lockfile and the plugin manifest name one version", async () => {
  const pkg = await json("package.json");
  const lock = await json("package-lock.json");
  const plugin = await json(".claude-plugin/plugin.json");
  // Claude Code offers plugin users an update only when the manifest's version changes.
  assert.deepEqual([lock.version, lock.packages[""].version, plugin.version], [pkg.version, pkg.version, pkg.version]);
});

test("a release bumps one part and resets the ones after it, or names an exact version", () => {
  assert.equal(nextVersion("0.3.4", "patch"), "0.3.5");
  assert.equal(nextVersion("0.3.4", "minor"), "0.4.0");
  assert.equal(nextVersion("0.3.4", "major"), "1.0.0");
  assert.equal(nextVersion("0.3.4", "0.10.0"), "0.10.0");
  assert.throws(() => nextVersion("0.3.4", "0.4"), /not a MAJOR\.MINOR\.PATCH version/);
  assert.throws(() => nextVersion("0.3.4", "1.0.0-beta.1"), /not a MAJOR\.MINOR\.PATCH version/);
});

test("versions compare numerically, part by part", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.2.1", "0.2.1"), 0);
});
