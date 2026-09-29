// Small DOM and network helpers the review client is built from.

type Attributes = Record<string, string | boolean | null | undefined | ((event: Event) => void)>;
type Child = Node | string | null | undefined | false;

/**
 * Creates an element. `text` sets its text, `html` its markup (for our own icons only), `on<event>`
 * adds a listener; anything else is an attribute, with `true` meaning present and falsy absent.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attributes = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") node.addEventListener(name.slice(2), value);
    else if (name === "text") node.textContent = String(value);
    else if (name === "html") node.innerHTML = String(value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export const ICONS = {
  comment:
    '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  skip: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 12L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  undo: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 6.5h6.25a3 3 0 0 1 0 6H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 4L3.5 6.5 6 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg viewBox="0 0 10 10" width="12" height="12" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/** The element for a selector the server-rendered page always contains. */
export function required<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Coplan: the page has no ${selector}`);
  return found;
}

export interface PostResult {
  ok: boolean;
  status: number;
  // The server's JSON reply; routes answer with `error`, `reload` and route-specific fields.
  data: { error?: string; reload?: boolean; [field: string]: unknown };
}

export async function post(path: string, body: unknown = {}): Promise<PostResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}
