// The `coplan` command. Its output is JSON for the agent to read: every command prints an
// object, and expected failures print `{ error, help }` rather than a stack trace.

import { VERSION } from "../paths.ts";
import { CliError } from "./args.ts";
import * as commands from "./commands.ts";
import { poll } from "./poll.ts";
import { setup } from "./setup.ts";

type Command = (args: string[]) => Promise<unknown> | unknown;

const COMMANDS = new Map<string, Command>([
  ["setup", setup],
  ["guide", commands.guide],
  ["new", commands.newPlan],
  ["render", commands.render],
  ["open", commands.open],
  ["poll", poll],
  ["status", commands.status],
  ["end", commands.end],
  ["stop", commands.stop],
  ["server", commands.server],
]);

/**
 * Compact, because agents read it and indentation costs tokens: about a quarter of a poll response.
 * Not pretty in a terminal either, since some agents (Codex) run commands in one.
 */
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function run(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  try {
    if (!first || first === "--help" || first === "help") return print(await commands.home());
    // `coplan plan.json` is shorthand for `coplan open plan.json`.
    const known = COMMANDS.get(first);
    const command = known ?? (first.endsWith(".json") ? commands.open : null);
    if (!command) throw new CliError(`unknown command "${first}"`, ["Run `coplan` for the command list"]);
    const output = await command(known ? rest : argv);
    if (output !== undefined) print(output);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    print({ error: error.message, ...(error.help.length ? { help: error.help } : {}) });
    process.exitCode = 1;
  }
}
