// Open questions the agent asked during plan review. Answers are drafts, sent with the next
// feedback batch; the reviewer cannot approve until the agent has folded them into the plan.

import type { DraftItem } from "../protocol.ts";
import { required } from "./dom.ts";
import { changed, onChange, save, state, type QuestionAnswer } from "./store.ts";

/** A free-text answer counts once it has text; a chosen option counts at once. */
const incomplete = (answer: QuestionAnswer) => answer.choice === null && !answer.other.trim();

export function wireQuestions(): void {
  for (const article of document.querySelectorAll<HTMLElement>(".sp-question[data-sp-question]")) {
    const id = article.dataset.spQuestion ?? "";
    const radios = article.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const answerBox = required(".sp-answer", article);
    const note = required<HTMLTextAreaElement>(".sp-answer-note", article);
    const answerStatus = required(".sp-answer-status", article);

    onChange(() => {
      const answer = state.answers[id];
      for (const radio of radios) {
        radio.disabled = state.ended;
        const isOther = radio.hasAttribute("data-sp-other");
        radio.checked = Boolean(answer) && (isOther ? answer?.choice === null : answer?.choice === radio.value);
      }
      answerBox.hidden = !answer;
      note.disabled = state.ended;
      article.classList.toggle("spr-answered", Boolean(answer));
      if (!answer) return;
      note.placeholder = answer.choice === null ? "Your answer" : "Add a note for the agent (optional)";
      if (document.activeElement !== note) note.value = answer.choice === null ? answer.other : answer.note;
      answerStatus.textContent = incomplete(answer) ? "Write your answer to include it" : "Included in your next send";
      answerStatus.classList.toggle("spr-incomplete", incomplete(answer));
    });

    const store = (answer: QuestionAnswer | null) => {
      if (answer) state.answers[id] = answer;
      else delete state.answers[id];
      save("answers", state.answers);
      changed();
    };
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        const previous = state.answers[id];
        if (radio.hasAttribute("data-sp-other")) {
          store({ choice: null, other: previous?.choice === null ? previous.other : "" });
          note.focus();
        } else {
          store({ choice: radio.value, note: previous && previous.choice !== null ? previous.note : "" });
        }
      });
    }
    note.addEventListener("input", () => {
      const answer = state.answers[id];
      if (!answer) return;
      store(answer.choice === null ? { choice: null, other: note.value } : { choice: answer.choice, note: note.value });
    });
    required(".sp-answer-clear", article).addEventListener("click", () => store(null));
  }
}

/** Answers ready to send, as feedback items. */
export function completeAnswers(): Extract<DraftItem, { kind: "answer" }>[] {
  return Object.entries(state.answers)
    .filter(([, answer]) => !incomplete(answer))
    .map(([question, answer]) =>
      answer.choice !== null
        ? {
            kind: "answer",
            question,
            choice: answer.choice,
            ...(answer.note.trim() ? { note: answer.note.trim() } : {}),
          }
        : { kind: "answer", question, choice: null, other: answer.other.trim() },
    );
}

/** The question ids the reviewer answered in an earlier send, which the agent has yet to fold in. */
export function answeredEarlier(id: string): boolean {
  return state.history.some(
    (entry) => "items" in entry && entry.items.some((item) => item.kind === "answer" && item.question === id),
  );
}
