// Markup is built with the `html` tag, which escapes every interpolated value unless it is already
// an `Html` fragment. Escaping is the default, so forgetting it cannot inject markup; trusting a
// string takes an explicit `raw()`, which is reserved for our own assets and html blocks.

export class Html {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  toString(): string {
    return this.#value;
  }
}

/**
 * What a template accepts. `null` and `undefined` render nothing; booleans and numbers render as
 * text, so a condition takes a ternary (`${cond ? html`...` : null}`) and an attribute can hold
 * `"${selected}"`. Arrays render each item, so a mapped list needs no `.join("")`.
 */
export type Interpolation = Html | string | number | boolean | null | undefined | readonly Interpolation[];

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Trusts `value` as markup. Only for content we produced, or an html block the plan's author wrote. */
export function raw(value: string): Html {
  return new Html(value);
}

function interpolate(value: Interpolation): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Html) return value.toString();
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += interpolate(value) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}
