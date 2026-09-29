// Browser code is written in TypeScript, which a browser cannot run. A checkout runs Coplan from
// source, so the types are stripped on the way to the page; a published package ships the
// JavaScript that `npm run build` compiled, and serves it as it is.

import { readFile } from "node:fs/promises";

const FROM_SOURCE = import.meta.url.endsWith(".ts");
/** `src/` in a checkout, `dist/` in a package. */
const CODE_ROOT = new URL("../", import.meta.url);

type Strip = (code: string) => string;
let strip: Promise<Strip> | null = null;

/**
 * The JavaScript for a browser script, by its path under `src/` without an extension, such as
 * `render/tabs` or `client/review`.
 */
export async function browserCode(path: string): Promise<string> {
  const code = await readFile(new URL(`${path}.${FROM_SOURCE ? "ts" : "js"}`, CODE_ROOT), "utf8");
  if (!FROM_SOURCE) return code;
  // amaro is the type stripper Node itself uses; it is a dev dependency, loaded only from source.
  strip ??= import("amaro").then(
    ({ transformSync }) =>
      (source: string) =>
        transformSync(source, { mode: "strip-only" }).code,
  );
  return (await strip)(code);
}
