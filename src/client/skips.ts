// Skipping edge cases, security risks and gaps. A skip is saved the moment it is pressed. It marks
// the plan rather than joining the feedback, so it never blocks approval and is still there when
// the reviewer comes back.

import { el, ICONS, post, required } from "./dom.ts";
import { setStatus } from "./panel.ts";
import { changed, onChange, review, state } from "./store.ts";

function setSkipped(article: HTMLElement, skipped: boolean): void {
  article.toggleAttribute("data-sp-skipped", skipped);
  article.classList.toggle("sp-skipped", skipped);
}

/** Applies the server's list of skipped ids to every skippable item. */
export function applySkips(ids: string[]): void {
  for (const article of document.querySelectorAll<HTMLElement>("[data-sp-skippable]")) {
    setSkipped(article, ids.includes(article.dataset.spSkippable ?? ""));
  }
  changed();
}

export function wireSkips(): void {
  for (const article of document.querySelectorAll<HTMLElement>("[data-sp-skippable]")) {
    const id = article.dataset.spSkippable ?? "";
    const head = required(".sp-item-head", article);
    // The server renders a static pill for saved skips; the live one below replaces it.
    head.querySelector(".sp-skip-pill")?.remove();
    const pill = el("span", { class: "sp-skip-pill", text: "Skipped", hidden: true });
    const label = el("span");
    const icon = el("span", { class: "spr-skip-icon" });
    const button = el("button", { class: "spr-skip-button", type: "button" }, [icon, label]);
    // Beside the title, never at the far right: the top-right corner of the card belongs to the
    // Comment button.
    required(".sp-item-title", head).after(pill, button);

    onChange(() => {
      const skipped = article.hasAttribute("data-sp-skipped");
      button.hidden = state.ended;
      label.textContent = skipped ? "Restore" : "Skip";
      icon.innerHTML = skipped ? ICONS.undo : ICONS.skip;
      button.title = skipped ? "Bring this back into the plan" : "The plan does not need to address this";
      pill.hidden = !skipped;
    });

    let busy = false;
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      const skip = !article.hasAttribute("data-sp-skipped");
      setSkipped(article, skip);
      changed();
      try {
        const result = await post(`/api/${review.key}/skip`, { id, skip });
        if (result.ok) return applySkips(result.data.skips as string[]);
        setSkipped(article, !skip);
        setStatus(result.data.error ?? "Could not save that skip.", "error");
      } catch {
        setSkipped(article, !skip);
        setStatus("Could not reach Coplan; the skip was not saved.", "error");
      } finally {
        busy = false;
      }
      changed();
    });
  }
  onChange(syncSkipCounts);
}

/** Keeps each priority group's "n skipped" note and each tab's badge in step without a reload. */
function syncSkipCounts(): void {
  const counts = (scope: ParentNode) => ({
    items: scope.querySelectorAll("[data-sp-skippable]").length,
    skipped: scope.querySelectorAll("[data-sp-skippable][data-sp-skipped]").length,
  });
  for (const group of document.querySelectorAll(".sp-priority-group")) {
    const { items, skipped } = counts(group);
    if (!items) continue;
    const head = required(".sp-priority-head", group);
    required(".sp-count", head).textContent = String(items - skipped);
    let note = head.querySelector<HTMLElement>(".sp-count-skipped");
    if (!note && skipped) {
      note = el("span", { class: "sp-count-skipped" });
      head.append(note);
    }
    if (note) {
      note.textContent = skipped ? `${skipped} skipped` : "";
      note.hidden = !skipped;
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".sp-panel")) {
    const { items, skipped } = counts(panel);
    if (!items) continue;
    const badge = document.querySelector(`.sp-tab[data-tab="${CSS.escape(panel.dataset.panel ?? "")}"] .sp-tab-count`);
    if (badge) badge.textContent = String(items - skipped);
  }
}
