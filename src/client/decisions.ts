// The key-decisions questionnaire, answered before the plan exists. Every decision is optional
// and offers a free-text answer next to its options; the reviewer submits them all at once.

import type { DecisionAnswer } from "../protocol.ts";
import { required } from "./dom.ts";
import { changed, onChange, review, save, state, type DecisionDraft } from "./store.ts";

export const inDecisions = review.stage?.stage === "decisions";

export function decisionAnswered(answer: DecisionAnswer | undefined): boolean {
  return Boolean(answer && (answer.choices.length || answer.other?.trim()));
}

export function wireDecisions(): void {
  for (const article of document.querySelectorAll<HTMLElement>(".sp-decision[data-sp-decision]")) {
    const id = article.dataset.spDecision ?? "";
    const single = article.dataset.spSelect === "single";
    const inputs = article.querySelectorAll<HTMLInputElement>("input");
    const otherInput = required<HTMLInputElement>("input[data-sp-other]", article);
    const otherBox = required(".sp-decision-other", article);
    const otherText = required<HTMLTextAreaElement>("textarea", otherBox);
    const answerActions = required(".sp-answer-actions", article);
    const statusLine = required(".sp-answer-status", article);
    const current = (): DecisionDraft => state.decisionAnswers[id] ?? { choices: [] };

    onChange(() => {
      const editable = inDecisions && !state.ended;
      const answer = current();
      const otherOn = Boolean(answer.otherOn || answer.other);
      for (const input of inputs) {
        input.disabled = !editable;
        input.checked = input === otherInput ? otherOn : answer.choices.includes(input.value);
      }
      otherBox.hidden = !otherOn;
      otherText.disabled = !editable;
      if (document.activeElement !== otherText) otherText.value = answer.other ?? "";
      const answered = decisionAnswered(answer);
      answerActions.hidden = !(answered || otherOn) || !editable;
      statusLine.textContent = answered ? "Answered" : "Write your answer to include it";
      statusLine.classList.toggle("spr-incomplete", !answered);
      article.classList.toggle("spr-answered", answered);
    });

    const store = (next: DecisionDraft | null) => {
      if (!next || (!next.choices.length && !next.otherOn && !next.other?.trim())) delete state.decisionAnswers[id];
      else state.decisionAnswers[id] = next;
      save("decisions", state.decisionAnswers);
      changed();
    };
    for (const input of inputs) {
      input.addEventListener("change", () => {
        const choices = Array.from(
          article.querySelectorAll<HTMLInputElement>("input:checked:not([data-sp-other])"),
          (checked) => checked.value,
        );
        // Choosing an option in a single-select decision closes the free-text answer.
        const otherOn = otherInput.checked && !(single && input !== otherInput && input.checked);
        store({ choices, otherOn, other: otherOn ? (current().other ?? "") : "" });
        if (input === otherInput && otherOn) otherText.focus();
      });
    }
    otherText.addEventListener("input", () =>
      store({ choices: current().choices, otherOn: true, other: otherText.value }),
    );
    required(".sp-decision-clear", article).addEventListener("click", () => store(null));
  }
}

/** The answers to submit: only decisions with a choice or free text. */
export function decisionPayload(): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, answer] of Object.entries(state.decisionAnswers)) {
    const other = answer.other?.trim();
    if (decisionAnswered(answer)) out[id] = { choices: answer.choices, ...(other ? { other } : {}) };
  }
  return out;
}

export function decisionCounts(): { answered: number; total: number } {
  const ids = review.decisions ?? [];
  return { answered: ids.filter((id) => decisionAnswered(state.decisionAnswers[id])).length, total: ids.length };
}
