// Cuts a release: `npm run release -- <patch|minor|major|X.Y.Z> --notes <file>`.
// Bumps the version in package.json, package-lock.json and the plugin manifest, runs the checks,
// commits, and pushes main with an annotated tag vX.Y.Z whose message is the release notes. The
// release workflow turns that tag into the GitHub Release.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { BUMPS, compareVersions, nextVersion } from "./semver.ts";

const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

function fail(message: string): never {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit" });

const [target, flag, notesFile, ...extra] = process.argv.slice(2);
if (!target || flag !== "--notes" || !notesFile || extra.length > 0) {
  fail(`usage: npm run release -- <${BUMPS.join("|")}|X.Y.Z> --notes <file>
Draft the notes from what changed since the last release:
  git log --reverse --format='%s%n%n%b' $(git describe --tags --abbrev=0)..HEAD`);
}

const notes = readFileSync(notesFile, "utf8").trim();
if (!notes) fail(`${notesFile} is empty; the notes become the GitHub Release`);

if (git("branch", "--show-current") !== "main") fail("releases are cut from main");
if (git("status", "--porcelain")) fail("the working tree has uncommitted changes");
git("fetch", "--quiet", "--tags", "origin", "main");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main is not the same as origin/main");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current: string = pkg.version;
const version = (() => {
  try {
    return nextVersion(current, target);
  } catch (error) {
    return fail((error as Error).message);
  }
})();
const tag = `v${version}`;
const released = git("tag", "--list", "v*").split("\n").filter(Boolean);
if (released.includes(tag)) fail(`${tag} is already released`);
const latest = released
  .map((t) => t.slice(1))
  .toSorted(compareVersions)
  .at(-1);
if (latest && compareVersions(version, latest) <= 0) fail(`${version} is not newer than the latest release, ${latest}`);

if (version !== current) {
  run("npm", ["version", version, "--no-git-tag-version"]);
  // Replaced in place, so the manifest keeps the formatting the format check expects.
  const manifest = readFileSync(PLUGIN_MANIFEST, "utf8");
  const versionField = /"version": "[^"]*"/;
  if (!versionField.test(manifest)) fail(`${PLUGIN_MANIFEST} has no version field`);
  writeFileSync(PLUGIN_MANIFEST, manifest.replace(versionField, `"version": "${version}"`));
}
run("npm", ["run", "check"]);
if (version !== current) {
  run("git", ["commit", "--quiet", "-m", `Release ${tag}`, "--", "package.json", "package-lock.json", PLUGIN_MANIFEST]);
}
// Verbatim keeps Markdown headings, which the default cleanup would strip as comments.
run("git", ["tag", "--annotate", "--cleanup=verbatim", "--file", notesFile, tag]);
run("git", ["push", "--atomic", "origin", "main", tag]);
process.stdout.write(`Released ${tag}. The release workflow publishes the GitHub Release from the tag.\n`);
