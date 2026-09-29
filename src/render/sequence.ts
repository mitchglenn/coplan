// Deterministic sequence diagrams drawn from a flow's structured steps. Rendering them here instead
// of shipping Mermaid keeps plans offline, themeable through CSS custom properties, and lets every
// step carry its own review target.

import { html, type Html } from "./html.ts";
import type { Flow, Participant } from "../plan/schema.ts";

const FONT_SIZE = 13;
const CHAR_WIDTH = 6.4; // measured ~5.6px average advance for system-ui at 13px, plus margin
const HEAD_CHAR_WIDTH = 7.6; // semibold participant labels
const LINE_HEIGHT = 17;
const WRAP_AT = 44;
const SELF_WRAP_AT = 28;
const BOX_HEIGHT = 38;
const TOP = 10;
const SIDE = 16;
const ROW_GAP = 22;
const SELF_LOOP_WIDTH = 30;

/** A laid-out row of the diagram: a message between two lifelines, a self-call, or a note. */
type Row =
  | { kind: "note"; lines: string[]; over: string[]; label: string }
  | { kind: "message"; lines: string[]; from: number; to: number; reply: boolean; label: string }
  | { kind: "self"; lines: string[]; from: number; to: number; reply: boolean; label: string };

/** Greedy word wrap to lines of at most `width` characters. */
function wrapLabel(value: string, width = WRAP_AT): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if ((line + " " + word).length <= width) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

const textWidth = (lines: string[], charWidth = CHAR_WIDTH) => Math.max(...lines.map((l) => l.length)) * charWidth;

/** An SVG sequence diagram for a flow. `flowPath` is the flow's JSON path, for step review targets. */
export function renderSequence(flow: Pick<Flow, "title" | "participants" | "steps">, flowPath: string): Html {
  const participants = flow.participants;
  const index = new Map(participants.map((p, i) => [p.id, i]));
  // Validation guarantees every step names a declared participant.
  const column = (id: string) => index.get(id) ?? 0;
  const boxWidths = participants.map((p) => Math.max(96, Math.ceil(p.label.length * HEAD_CHAR_WIDTH) + 30));

  // gaps[i] is the distance between the centres of participant i and i + 1.
  const gaps = participants.slice(1).map((_, i) => Math.max(130, boxWidths[i] / 2 + boxWidths[i + 1] / 2 + 36));
  let rightExtra = 0;

  // Notes annotate the steps around them, so only messages take a number.
  let messageCount = 0;
  const steps = flow.steps.map((step): Row => {
    if ("note" in step) {
      return { kind: "note", lines: wrapLabel(step.note, 40), over: step.over, label: `Note: ${step.note}` };
    }
    messageCount += 1;
    const from = column(step.from);
    const to = column(step.to);
    const self = from === to;
    return {
      kind: self ? "self" : "message",
      lines: wrapLabel(`${messageCount}. ${step.label}`, self ? SELF_WRAP_AT : WRAP_AT),
      from,
      to,
      reply: step.reply,
      label: `Step ${messageCount}: ${step.label}`,
    };
  });

  // Widen gaps until every label fits between the lifelines it spans. Short spans first, so a long
  // message across several participants only takes the width the short ones did not already add.
  const spans = steps
    .filter((s) => s.kind === "message")
    .map((s) => ({ lo: Math.min(s.from, s.to), hi: Math.max(s.from, s.to), need: textWidth(s.lines) + 28 }))
    .toSorted((a, b) => a.hi - a.lo - (b.hi - b.lo));
  for (const span of spans) {
    const have = gaps.slice(span.lo, span.hi).reduce((sum, g) => sum + g, 0);
    if (have < span.need) {
      const extra = (span.need - have) / (span.hi - span.lo);
      for (let g = span.lo; g < span.hi; g += 1) gaps[g] += extra;
    }
  }
  for (const s of steps) {
    if (s.kind !== "self") continue;
    const need = SELF_LOOP_WIDTH + 12 + textWidth(s.lines);
    if (s.from < gaps.length) gaps[s.from] = Math.max(gaps[s.from], need + boxWidths[s.from + 1] / 2 - 10);
    else rightExtra = Math.max(rightExtra, need - boxWidths[s.from] / 2 + 8);
  }

  const centers = [SIDE + boxWidths[0] / 2];
  gaps.forEach((g, i) => centers.push(centers[i] + g));
  const noteWidths = steps.filter((s) => s.kind === "note").map((s) => textWidth(s.lines) + 24);
  const last = participants.length - 1;
  let width = centers[last] + boxWidths[last] / 2 + SIDE + rightExtra;
  width = Math.max(width, ...noteWidths.map((w) => w + SIDE * 2));

  const parts: Html[] = [];
  let y = TOP + BOX_HEIGHT + ROW_GAP;

  steps.forEach((s, i) => {
    const target = `${flowPath}.steps[${i}]`;
    const textBlock = s.lines.length * LINE_HEIGHT;
    const body: Html[] = [];
    let rowHeight: number;

    if (s.kind === "note") {
      const over = s.over.map(column);
      const lo = Math.min(...over);
      const hi = Math.max(...over);
      const w = Math.max(textWidth(s.lines) + 24, centers[hi] - centers[lo] + 60);
      const cx = (centers[lo] + centers[hi]) / 2;
      const x = Math.max(4, Math.min(cx - w / 2, width - w - 4));
      const h = textBlock + 14;
      body.push(
        html`<rect class="sp-seq-note" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="6"/>`,
        textLines(s.lines, x + w / 2, y + 7 + FONT_SIZE, "middle", "sp-seq-note-text"),
      );
      rowHeight = h;
    } else if (s.kind === "self") {
      const x = centers[s.from];
      const loopTop = y + textBlock - 4;
      const loopBottom = loopTop + 18;
      body.push(
        textLines(s.lines, x + SELF_LOOP_WIDTH + 8, y + FONT_SIZE - 2, "start", "sp-seq-label"),
        html`<path class="sp-seq-line${s.reply ? " sp-seq-reply" : null}" d="M${fmt(x)} ${fmt(loopTop)} H${fmt(x + SELF_LOOP_WIDTH)} V${fmt(loopBottom)} H${fmt(x + 6)}" fill="none"/>`,
        arrowHead(x, loopBottom, -1, s.reply),
      );
      rowHeight = loopBottom - y + 4;
    } else {
      const x1 = centers[s.from];
      const x2 = centers[s.to];
      const direction = x2 > x1 ? 1 : -1;
      const lineY = y + textBlock + 4;
      body.push(
        textLines(s.lines, (x1 + x2) / 2, y + FONT_SIZE - 2, "middle", "sp-seq-label"),
        html`<line class="sp-seq-line${s.reply ? " sp-seq-reply" : null}" x1="${fmt(x1)}" y1="${fmt(lineY)}" x2="${fmt(x2 - direction * 2)}" y2="${fmt(lineY)}"/>`,
        arrowHead(x2, lineY, direction, s.reply),
      );
      rowHeight = lineY - y + 4;
    }

    const hitTop = y - ROW_GAP / 2;
    const hit = html`<rect class="sp-seq-hit" x="0" y="${fmt(hitTop)}" width="${fmt(width)}" height="${fmt(rowHeight + ROW_GAP)}"/>`;
    parts.push(
      html`<g class="sp-seq-step" data-sp-target="${target}" data-sp-kind="step" data-sp-label="${s.label}"><title>${s.label}</title>${hit}${body}</g>`,
    );
    y += rowHeight + ROW_GAP;
  });

  const height = y + 4;
  const lifelines = centers.map(
    (cx) =>
      html`<line class="sp-seq-lifeline" x1="${fmt(cx)}" y1="${TOP + BOX_HEIGHT}" x2="${fmt(cx)}" y2="${fmt(height - 6)}"/>`,
  );
  const heads = participants.map((p, i) => participantBox(p, centers[i], boxWidths[i]));

  return html`<svg class="sp-seq" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}" style="width:100%;height:auto;max-width:${fmt(width)}px;min-width:${fmt(Math.round(width * 0.85))}px" role="img" aria-label="Sequence diagram: ${flow.title}">${lifelines}${heads}${parts}</svg>`;
}

function participantBox(p: Participant, cx: number, w: number): Html {
  const x = cx - w / 2;
  const kind = p.kind || "system";
  const rx = kind === "actor" ? BOX_HEIGHT / 2 : 7;
  const box = html`<rect class="sp-seq-box sp-seq-${kind}" x="${fmt(x)}" y="${TOP}" width="${fmt(w)}" height="${BOX_HEIGHT}" rx="${rx}"/>`;
  const rule =
    kind === "store"
      ? html`<line class="sp-seq-store-rule" x1="${fmt(x + 1)}" y1="${TOP + 7}" x2="${fmt(x + w - 1)}" y2="${TOP + 7}"/>`
      : null;
  const label = html`<text class="sp-seq-head" x="${fmt(cx)}" y="${TOP + BOX_HEIGHT / 2 + 4.5}" text-anchor="middle">${p.label}</text>`;
  return html`<g><title>${p.label} (${kind})</title>${box}${rule}${label}</g>`;
}

/** A filled arrowhead for a call, an open one for a reply. */
function arrowHead(x: number, y: number, direction: 1 | -1, open: boolean): Html {
  const back = x - direction * 9;
  const points = `${fmt(back)},${fmt(y - 4.5)} ${fmt(x)},${fmt(y)} ${fmt(back)},${fmt(y + 4.5)}`;
  return open
    ? html`<polyline class="sp-seq-arrow-open" points="${points}" fill="none"/>`
    : html`<polygon class="sp-seq-arrow" points="${points}"/>`;
}

function textLines(lines: string[], x: number, y: number, anchor: "start" | "middle", className: string): Html {
  const spans = lines.map((line, i) => html`<tspan x="${fmt(x)}" dy="${i === 0 ? 0 : LINE_HEIGHT}">${line}</tspan>`);
  return html`<text class="${className}" x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}">${spans}</text>`;
}

/** Coordinates to at most one decimal, so the SVG stays short. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
