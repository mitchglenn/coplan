// `coplan setup`: installs the Coplan skill for the agents on this machine, so they know to
// reach for the CLI. The skill is a short pointer and the guidance itself lives in the CLI, so an
// installed skill does not go stale; re-running setup after an upgrade refreshes it anyway.

import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../paths.ts";
import { parseArgs } from "./args.ts";
import type { Output } from "./commands.ts";

const SKILL = join(PACKAGE_ROOT, "skills", "coplan", "SKILL.md");

interface Target {
  /** The agents that read personal skills from this directory. */
  agents: string;
  /** The skills directory, relative to the home directory. */
  dir: string;
  /** A directory that shows the agent is installed; without it, the target is skipped. */
  requires?: string;
}

/** Claude Code reads its own directory; the other agents share the Agent Skills one. */
const TARGETS: Target[] = [
  { agents: "Claude Code", dir: ".claude/skills", requires: ".claude" },
  { agents: "Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Amp", dir: ".agents/skills" },
];

export async function setup(args: string[]): Promise<Output> {
  const { flags } = parseArgs(args);
  const remove = Boolean(flags.remove);
  const home = homedir();
  const skill = await readFile(SKILL, "utf8");
  const results = [];
  for (const target of TARGETS) {
    const dir = join(home, target.dir, "coplan");
    const file = join(dir, "SKILL.md");
    const report = (status: string) => ({ for: target.agents, path: `~/${target.dir}/coplan/SKILL.md`, status });
    if (isLink(dir) || isLink(file)) {
      results.push(report("left as is: a link you manage"));
    } else if (remove) {
      if (!existsSync(file)) {
        results.push(report("not installed"));
        continue;
      }
      await rm(file);
      await rmdir(dir).catch(() => {}); // only if nothing else is in it
      results.push(report("removed"));
    } else if (target.requires && !existsSync(join(home, target.requires))) {
      results.push(report(`skipped: no ~/${target.requires}`));
    } else {
      const current = await readFile(file, "utf8").catch(() => null);
      if (current === skill) {
        results.push(report("up to date"));
        continue;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, skill);
      results.push(report(current === null ? "installed" : "updated"));
    }
  }
  return {
    skill: results,
    next_step: remove
      ? "The Coplan skill is removed from your agents."
      : "Start a new agent session and ask it to plan a feature: it picks Coplan up from the skill. You can also name it, as `/coplan <feature>` in Claude Code or `$coplan <feature>` in Codex.",
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
