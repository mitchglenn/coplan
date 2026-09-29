// Notices when the agent saves a plan, so open review pages update by themselves.
//
// It watches the plan's directory rather than the file: editors and atomic writes replace the file,
// which ends a watch on the file itself. Saves arrive as bursts of events, so they are debounced.

import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

const DEBOUNCE_MS = 120;

interface Watch {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
}

export class PlanWatcher {
  readonly #watches = new Map<string, Watch>();
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  /** Calls `onChange` after `file` changes. Watching a file twice is a no-op. */
  watch(file: string, onChange: () => Promise<void>): void {
    if (this.#watches.has(file)) return;
    const name = basename(file);
    try {
      const entry: Watch = {
        timer: null,
        watcher: watch(dirname(file), (_event, changed) => {
          if (changed && changed !== name) return;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = null;
            onChange().catch((error: Error) => this.#log(`watch ${file}: ${error.message}`));
          }, DEBOUNCE_MS);
        }),
      };
      entry.watcher.on("error", (error) => this.#log(`watcher ${file}: ${error.message}`));
      this.#watches.set(file, entry);
    } catch (error) {
      this.#log(`cannot watch ${file}: ${(error as Error).message}`);
    }
  }

  closeAll(): void {
    for (const entry of this.#watches.values()) {
      entry.watcher.close();
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.#watches.clear();
  }
}
