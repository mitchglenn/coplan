// Builds the published package: compiles src/ to dist/ (or the directory given), then copies what
// tsc does not. A checkout never needs this; it runs the TypeScript source directly.

import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const out = process.argv[2] ?? "dist";
// The project's own compiler, run directly: `npx tsc` without it installs an unrelated package.
const TSC = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const tsc = (...args: string[]) => execFileSync(process.execPath, [TSC, ...args], { stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
tsc("-p", "tsconfig.build.json", "--outDir", out);
// The browser code has its own program, typed against the DOM.
tsc("-p", "tsconfig.client.json", "--noEmit", "false", "--rootDir", "src", "--outDir", out);
for (const stylesheet of ["render/styles.css", "client/review.css"])
  cpSync(`src/${stylesheet}`, `${out}/${stylesheet}`);
