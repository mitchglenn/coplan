// Where Coplan keeps things, and how it names them.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4455;
export const APP = "coplan";
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** `src/` when running from a checkout, `dist/` when running a published package. */
const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

export function stateDir(env = process.env): string {
  return env.COPLAN_STATE_DIR ? resolve(env.COPLAN_STATE_DIR) : join(homedir(), ".coplan");
}

export function serverPort(env = process.env): number {
  const value = Number(env.COPLAN_PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

/** The plan's real path is its identity, so the agent never handles a session id. */
export async function canonicalPlanPath(file: string): Promise<string> {
  return realpath(resolve(file));
}

export function sessionKey(canonicalFile: string): string {
  return createHash("sha256").update(canonicalFile).digest("hex").slice(0, 16);
}

/**
 * A fingerprint of the code that is running. The CLI replaces a running server whose build
 * differs, so a local edit to Coplan takes effect on the next command without anyone
 * remembering to restart.
 */
export function buildId(): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const stats = statSync(path);
        hash.update(`${relative(PACKAGE_ROOT, path)}:${stats.size}:${stats.mtimeMs}\n`);
      }
    }
  };
  walk(join(PACKAGE_ROOT, "bin"));
  walk(CODE_ROOT);
  // The location counts too: a server started from a checkout that has since moved serves files
  // from a path that no longer exists, so it must be replaced like any other stale build.
  hash.update(PACKAGE_ROOT);
  hash.update(VERSION);
  return hash.digest("hex").slice(0, 12);
}
