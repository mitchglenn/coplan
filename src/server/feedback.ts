// Checks what the review page sends before it reaches the agent. The page is ours, but its input
// crosses a trust boundary all the same: every string is trimmed and capped, and every answer is
// checked against the plan's real questions and options and enriched with their text.

import type { Decision, Plan } from "../plan/schema.ts";
import type {
  AnsweredDecision,
  ConversationItem,
  DecisionAnswer,
  DecisionsItem,
  UnansweredDecision,
} from "../protocol.ts";

const MAX_ITEMS = 100;
const MAX_TEXT = 8000;

/** A trimmed string cut to `max` characters; anything that is not a string becomes "". */
function cleanText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Validates a batch of comments, question answers and messages. Returns null when the batch is
 * empty or any item is malformed; the page then keeps the reviewer's notes and shows the error.
 */
export function normalizeItems(items: unknown, plan: Plan | null): ConversationItem[] | null {
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) return null;
  const questions = new Map((plan?.questions ?? []).map((q) => [q.id, q]));
  const out: ConversationItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) return null;
    const normalized = normalizeItem(item, questions);
    if (!normalized) return null;
    out.push(normalized);
  }
  return out;
}

function normalizeItem(
  item: Record<string, unknown>,
  questions: Map<string, Plan["questions"][number]>,
): ConversationItem | null {
  switch (item.kind) {
    case "comment": {
      const text = cleanText(item.text);
      if (!text) return null;
      const t = isRecord(item.target) ? item.target : null;
      const id = t ? cleanText(t.id, 40) : "";
      const quote = cleanText(item.quote, 2000);
      return {
        kind: "comment",
        target: t
          ? {
              path: cleanText(t.path, 200),
              kind: cleanText(t.kind, 40),
              label: cleanText(t.label, 300),
              ...(id ? { id } : {}),
            }
          : null,
        ...(quote ? { quote } : {}),
        text,
      };
    }
    case "answer": {
      const question = questions.get(String(item.question));
      if (!question) return null;
      const option = question.options.find((o) => o.id === item.choice);
      const other = cleanText(item.other);
      if (!option && !other) return null;
      const note = cleanText(item.note);
      return {
        kind: "answer",
        question: question.id,
        question_text: question.question,
        ...(option ? { choice: option.id, choice_label: option.label } : { other }),
        ...(note ? { note } : {}),
      };
    }
    case "message": {
      const text = cleanText(item.text);
      return text ? { kind: "message", text } : null;
    }
    default:
      return null;
  }
}

/**
 * Validates the reviewer's key-decision answers against the decisions they were shown. Skipped
 * decisions are simply absent. Returns the answers to record and the item that tells the agent
 * which decisions were answered, or null when the payload is malformed.
 */
export function normalizeDecisionAnswers(
  raw: unknown,
  decisions: Decision[],
): { answers: Record<string, DecisionAnswer>; item: DecisionsItem } | null {
  const given = raw ?? {};
  if (!isRecord(given)) return null;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  if (Object.keys(given).some((id) => !byId.has(id))) return null;

  const answers: Record<string, DecisionAnswer> = {};
  const answered: AnsweredDecision[] = [];
  const unanswered: UnansweredDecision[] = [];
  for (const decision of decisions) {
    const answer = given[decision.id];
    const choices = isRecord(answer) && Array.isArray(answer.choices) ? [...new Set(answer.choices.map(String))] : [];
    if (choices.some((id) => !decision.options.some((o) => o.id === id))) return null;
    const other = isRecord(answer) ? cleanText(answer.other, 2000) : "";
    if (decision.select === "single" && choices.length + (other ? 1 : 0) > 1) return null;

    const base = {
      decision: decision.id,
      question: decision.question,
      aspect: decision.aspect,
      select: decision.select,
    };
    if (!choices.length && !other) {
      const recommended = decision.options.filter((o) => o.recommended).map((o) => o.label);
      unanswered.push({ ...base, ...(recommended.length ? { recommended } : {}) });
      continue;
    }
    answers[decision.id] = { choices, ...(other ? { other } : {}) };
    answered.push({
      ...base,
      choices: choices.map((id) => ({ id, label: decision.options.find((o) => o.id === id)?.label ?? id })),
      ...(other ? { other } : {}),
    });
  }
  return { answers, item: { kind: "decisions", answered, unanswered } };
}
