// Parsing the command line, and the error type every command throws for the agent to read.

import { relative } from "node:path";
import { canonicalPlanPath } from "../paths.ts";

/** An expected failure, printed as `{ error, help }` for the agent instead of a stack trace. */
export class CliError extends Error {
  readonly help: string[];

  constructor(message: string, help: string[] = []) {
    super(message);
    this.help = help;
  }
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** `--name value` for flags listed in `valueFlags`, `--name` alone for the rest. */
export function parseArgs(argv: string[], valueFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (valueFlags.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new CliError(`--${name} needs a value`);
      flags[name] = value;
    } else flags[name] = true;
  }
  return { positional, flags };
}

/** The plan file a command names, as its canonical path. */
export async function planArg(positional: string[], command: string): Promise<string> {
  const file = positional[0];
  if (!file) throw new CliError(`${command} needs a plan file`, [`Run \`coplan ${command} <plan.json>\``]);
  try {
    return await canonicalPlanPath(file);
  } catch {
    throw new CliError(`${file} does not exist`, ["Run `coplan new <slug>` to scaffold a plan"]);
  }
}

/** A path as the agent should write it: relative to the working directory when it is inside it. */
export function display(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}
