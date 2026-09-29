// Commenting on the plan. Every element the server marked with `data-sp-target` can take a comment:
// hover it (or tap it) for a Comment button, or select text inside it to quote the selection. A
// comment becomes a draft in the panel until the reviewer sends it.

import type { CommentTarget } from "../protocol.ts";
import { reloadPreservingView } from "./connection.ts";
import { el, ICONS, required } from "./dom.ts";
import { changed, save, state, type Draft } from "./store.ts";

/** The plan's content area; set when the page is wired, since modules do no DOM work on import. */
let main: HTMLElement;

const commentButton = (label: string, extraClass = "") =>
  el("button", { class: `spr-comment-button ${extraClass}`.trim(), type: "button", hidden: true }, [
    el("span", { html: ICONS.comment }),
    el("span", { text: label }),
  ]);
const hoverButton = commentButton("Comment");
const selectionButton = commentButton("Comment on selection", "spr-selection-button");

let hovered: Element | null = null;
let card: HTMLElement | null = null;
let pendingSelection: { node: Element; quote: string; rect: DOMRect } | null = null;

export function targetInfo(node: Element): CommentTarget {
  const id = node.getAttribute("data-sp-id");
  return {
    path: node.getAttribute("data-sp-target") ?? "",
    kind: node.getAttribute("data-sp-kind") ?? "",
    label: node.getAttribute("data-sp-label") ?? "",
    ...(id ? { id } : {}),
  };
}

/** The element a comment points at, if it is still on the page. */
export function targetNode(path: string | undefined): Element | null {
  return path ? document.querySelector(`[data-sp-target="${CSS.escape(path)}"]`) : null;
}

/** The review target under `node`, unless `node` is itself a control or part of the review UI. */
function reviewableTarget(node: EventTarget | Node | null): Element | null {
  if (!(node instanceof Element)) return null;
  if (node.closest("input, textarea, select, button, label, a, .spr-card, .spr-panel")) return null;
  const found = node.closest("[data-sp-target]");
  return found && (main.contains(found) || found.classList.contains("sp-summary")) ? found : null;
}

export function setHovered(node: Element | null): void {
  if (hovered === node) return;
  hovered?.classList.remove("spr-hover");
  hovered = node;
  if (!node || state.ended || card) {
    hoverButton.hidden = true;
    return;
  }
  node.classList.add("spr-hover");
  const rect = node.getBoundingClientRect();
  hoverButton.hidden = false;
  const inset = rect.height < 44 ? 2 : 8;
  hoverButton.style.left = `${Math.max(8, rect.right - hoverButton.offsetWidth - 8) + window.scrollX}px`;
  hoverButton.style.top = `${rect.top + inset + window.scrollY}px`;
}

function updateSelectionButton(): void {
  const selection = window.getSelection();
  const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
  const container = range?.commonAncestorContainer;
  const node = container ? reviewableTarget(container instanceof Element ? container : container.parentElement) : null;
  const quote = selection ? selection.toString().replace(/\s+/g, " ").trim() : "";
  if (state.ended || card || !range || !node || !quote) {
    selectionButton.hidden = true;
    pendingSelection = null;
    return;
  }
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  pendingSelection = { node, quote: quote.slice(0, 2000), rect: range.getBoundingClientRect() };
  selectionButton.hidden = false;
  const left = Math.min(last.right + 6, window.innerWidth - selectionButton.offsetWidth - 12);
  selectionButton.style.left = `${Math.max(8, left) + window.scrollX}px`;
  selectionButton.style.top = `${last.bottom + 6 + window.scrollY}px`;
}

// --- the comment card ---

interface CardOptions {
  target: CommentTarget;
  anchor?: Element;
  anchorRect?: DOMRect;
  quote?: string;
  /** Edit this draft instead of adding a new one. */
  draft?: Draft;
}

export function openCard(options: CardOptions): void {
  closeCard();
  setHovered(null);
  const existing = options.draft;
  const textarea = el("textarea", {
    class: "spr-card-input",
    name: "comment",
    rows: "3",
    placeholder: "What should change?",
  });
  textarea.value = existing?.text ?? "";
  const addButton = el("button", {
    class: "spr-button spr-button-primary",
    type: "button",
    text: existing ? "Update comment" : "Add comment",
  });
  const cancelButton = el("button", { class: "spr-button", type: "button", text: "Cancel" });
  const quote = existing ? existing.quote : options.quote;
  card = el("div", { class: "spr-card", role: "dialog", "aria-label": "Comment" }, [
    el("div", { class: "spr-card-head" }, [
      el("span", { class: "spr-card-kicker", text: "Comment on" }),
      el("span", { class: "spr-card-target", text: options.target.label || options.target.path }),
    ]),
    quote ? el("blockquote", { class: "spr-quote", text: quote }) : null,
    textarea,
    el("div", { class: "spr-card-actions" }, [
      el("span", { class: "spr-card-hint", text: "Enter to add" }),
      cancelButton,
      addButton,
    ]),
  ]);
  document.body.append(card);
  positionCard(options.anchor, options.anchorRect);
  textarea.focus();

  const commit = () => {
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    if (existing) existing.text = text;
    else
      state.drafts.push({
        id: Math.random().toString(36).slice(2, 10),
        kind: "comment",
        target: options.target,
        ...(quote ? { quote } : {}),
        text,
      });
    save("drafts", state.drafts);
    closeCard();
    changed();
  };
  addButton.addEventListener("click", commit);
  cancelButton.addEventListener("click", closeCard);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape" && !textarea.value.trim()) {
      closeCard();
    }
  });
}

function positionCard(anchor: Element | undefined, anchorRect: DOMRect | undefined): void {
  if (!card) return;
  const rect = anchorRect ?? anchor?.getBoundingClientRect() ?? { left: 24, bottom: 120, top: 100 };
  const mainRect = main.getBoundingClientRect();
  const left = Math.min(Math.max(mainRect.left, rect.left), Math.max(mainRect.left, mainRect.right - card.offsetWidth));
  let top = rect.bottom + 8;
  if (top + card.offsetHeight > window.innerHeight - 12 && rect.top - card.offsetHeight - 8 > 12) {
    top = rect.top - card.offsetHeight - 8;
  }
  card.style.left = `${Math.max(8, left) + window.scrollX}px`;
  card.style.top = `${top + window.scrollY}px`;
}

/** Whether a comment is half-written, so nothing should close or reload the page under it. */
export const cardHasText = (): boolean => Boolean(card?.querySelector("textarea")?.value.trim());

export function closeCard(): void {
  if (!card) return;
  card.remove();
  card = null;
  if (state.pendingReload) reloadPreservingView();
}

// --- wiring ---

export function wireComments(): void {
  main = required(".sp-main");
  document.body.append(hoverButton, selectionButton);

  document.addEventListener("mouseover", (event) => {
    if (event.target instanceof Node && hoverButton.contains(event.target)) return;
    setHovered(reviewableTarget(event.target));
  });
  document.addEventListener("scroll", () => setHovered(null), { passive: true });
  hoverButton.addEventListener("click", () => {
    if (hovered) openCard({ target: targetInfo(hovered), anchor: hovered });
  });

  // Touch and keyboard users: a plain click on a target (without a text selection) arms it.
  main.addEventListener("click", (event) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const node = reviewableTarget(event.target);
    if (node && !card) setHovered(node);
  });

  document.addEventListener("mouseup", () => setTimeout(updateSelectionButton, 0));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey) updateSelectionButton();
  });
  // Keep the selection alive through the click.
  selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionButton.addEventListener("click", () => {
    if (!pendingSelection) return;
    const { node, rect, quote } = pendingSelection;
    selectionButton.hidden = true;
    openCard({ target: targetInfo(node), anchor: node, anchorRect: rect, quote });
    window.getSelection()?.removeAllRanges();
  });

  // A click outside an empty card closes it; a card with text stays until added or cancelled.
  document.addEventListener("mousedown", (event) => {
    if (card && event.target instanceof Node && !card.contains(event.target) && !cardHasText()) closeCard();
  });
  document.addEventListener("sp:tab", () => {
    closeCard();
    setHovered(null);
  });
  window.addEventListener("resize", () => {
    setHovered(null);
    selectionButton.hidden = true;
  });
}
