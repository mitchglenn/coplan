#!/usr/bin/env node
// The `coplan` executable. A checkout runs the TypeScript source directly; a published package
// runs the JavaScript compiled into dist/, because Node does not strip types inside node_modules.

import { existsSync } from "node:fs";

const MIN_NODE = 24;
const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  process.stderr.write(`Coplan needs Node.js ${MIN_NODE} or newer; this is ${process.versions.node}.\n`);
  process.exit(1);
}

const source = new URL("../src/cli/index.ts", import.meta.url);
const entry = existsSync(source) ? source : new URL("../dist/cli/index.js", import.meta.url);
const { run } = await import(entry.href);

try {
  await run(process.argv.slice(2));
} catch (error) {
  // Expected failures are printed as JSON by the CLI itself; this is for bugs.
  const debug = process.env.COPLAN_DEBUG === "1";
  process.stderr.write(`coplan: ${debug ? error.stack : error.message}\n`);
  if (!debug) process.stderr.write("Set COPLAN_DEBUG=1 for the full stack trace.\n");
  process.exit(1);
}
