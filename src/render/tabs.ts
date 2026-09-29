/* Tab switching for a rendered plan. Inlined into every page, so it runs without the review server
 * and a saved plan.html keeps working tabs. It is a classic script, not a module: it has no imports
 * and shares only `window.coplan.selectTab` with the review client. */
(() => {
  document.documentElement.classList.add("sp-js");
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".sp-tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".sp-panel"));
  const main = document.querySelector<HTMLElement>(".sp-main");
  const strip = document.querySelector<HTMLElement>(".sp-tabs-inner");
  if (!tabs.length || !main || !strip) return;
  const defaultTab = main.dataset.defaultTab ?? "";

  // The strip scrolls sideways when the tabs do not fit; fade whichever edge hides more of them.
  const syncOverflow = () => {
    const hidden = strip.scrollWidth - strip.clientWidth;
    strip.classList.toggle("sp-fade-start", strip.scrollLeft > 1);
    strip.classList.toggle("sp-fade-end", strip.scrollLeft < hidden - 1);
  };

  const keepInView = (tab: HTMLElement) => {
    const bounds = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const margin = 40; // clear of the edge fade
    if (rect.left < bounds.left + margin) strip.scrollLeft -= bounds.left + margin - rect.left;
    else if (rect.right > bounds.right - margin) strip.scrollLeft += rect.right - (bounds.right - margin);
  };

  const has = (id: string) => tabs.some((tab) => tab.dataset.tab === id);

  const select = (id: string, options?: { updateHash?: boolean }): string => {
    const chosen = has(id) ? id : defaultTab;
    for (const tab of tabs) {
      const on = tab.dataset.tab === chosen;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on) keepInView(tab);
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== chosen;
    if (options?.updateHash && location.hash !== `#${chosen}`) history.replaceState(null, "", `#${chosen}`);
    document.dispatchEvent(new CustomEvent("sp:tab", { detail: { id: chosen } }));
    return chosen;
  };

  /** Shows the tab holding an element and scrolls to it. */
  const reveal = (elementId: string): boolean => {
    const element = document.getElementById(elementId);
    if (!element) return false;
    const panel = element.closest<HTMLElement>(".sp-panel");
    if (panel?.dataset.panel) select(panel.dataset.panel);
    element.scrollIntoView({ block: "start" });
    return true;
  };

  /** A hash names a tab (`#flows`) or an element in one (`#slice-S2`). */
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (has(id)) select(id);
    else if (!id || !reveal(id)) select(defaultTab);
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.tab ?? "", { updateHash: true }));
    tab.addEventListener("keydown", (event) => {
      const byKey: Record<string, HTMLButtonElement | undefined> = {
        ArrowRight: tabs[(index + 1) % tabs.length],
        ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
        Home: tabs[0],
        End: tabs[tabs.length - 1],
      };
      const next = byKey[event.key];
      if (!next) return;
      event.preventDefault();
      select(next.dataset.tab ?? "", { updateHash: true });
      next.focus();
    });
  });

  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sp-jump]") : null;
    const id = link?.dataset.spJump;
    if (!id) return;
    event.preventDefault();
    if (reveal(id)) history.replaceState(null, "", `#${id}`);
  });

  window.addEventListener("hashchange", fromHash);
  strip.addEventListener("scroll", syncOverflow, { passive: true });
  // Width changes (a window resize, the review panel opening) can push the selected tab out of view.
  new ResizeObserver(() => {
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    if (selected) keepInView(selected);
    syncOverflow();
  }).observe(strip);
  window.coplan = { ...window.coplan, selectTab: select };
  fromHash();
})();
