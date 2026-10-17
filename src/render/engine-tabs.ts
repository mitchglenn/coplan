// The tabs Coplan adds to every plan: the key decisions and open questions (slices have their own
// module). Their inputs start disabled; the review client enables them when the page is served for
// review.

import { html, type Html } from "./html.ts";
import { md, mdInline } from "./markdown.ts";
import { idChip, target } from "./parts.ts";
import type { Decision, Option, Question } from "../plan/schema.ts";
import type { DecisionAnswer } from "../protocol.ts";

const ASPECT_LABELS: Record<Decision["aspect"], string> = {
  scope: "Scope",
  requirements: "Requirements",
  constraints: "Constraints",
  technical: "Technical",
};

export function isAnswered(answer: DecisionAnswer | undefined): boolean {
  return Boolean(answer && (answer.choices.length || answer.other?.trim()));
}

// --- key decisions ---

/** The questionnaire the reviewer fills in before the plan exists. */
export function renderDecisionForm(decisions: Decision[]): Html {
  const intro = html`<div class="sp-decisions-intro"><p>These decisions shape the plan. Answer the ones you have an opinion on; every one is optional. The agent makes the call on anything you skip and says what it assumed in the plan.</p><p class="sp-muted">Ordered by impact, so the first few matter most.</p></div>`;
  const cards = decisions.map(
    (
      d,
      i,
    ) => html`<article class="sp-card sp-decision"${target(`decisions[${i}]`, "decision", `${d.id}: ${d.question}`, d.id)} data-sp-decision="${d.id}" data-sp-select="${d.select}">
<header class="sp-card-head">${idChip(d.id)}<h2 class="sp-card-title">${mdInline(d.question)}</h2><span class="sp-aspect sp-aspect-${d.aspect}">${ASPECT_LABELS[d.aspect]}</span></header>
${d.context ? html`<div class="sp-md sp-muted">${md(d.context)}</div>` : null}
<p class="sp-decision-hint">${d.select === "multiple" ? "Choose any that apply" : "Choose one"}</p>
${optionList({ type: d.select === "multiple" ? "checkbox" : "radio", name: `sp-d-${d.id}`, question: d.question, options: d.options, other: "Something else" })}
<div class="sp-decision-other" hidden><textarea class="sp-answer-note" name="other-${d.id}" rows="2" placeholder="Describe your answer"></textarea></div>
<div class="sp-answer-actions" hidden><span class="sp-answer-status" role="status"></span><button type="button" class="sp-button-quiet sp-decision-clear">Clear</button></div>
</article>`,
  );
  return html`${intro}${cards}`;
}

/** What the reviewer decided, shown once the decisions are submitted. */
export function renderDecisionSummary(decisions: Decision[], answers: Record<string, DecisionAnswer>): Html {
  const answered = decisions.filter((d) => isAnswered(answers[d.id])).length;
  const rows = decisions.map((d, i) => {
    const answer = answers[d.id];
    const labels =
      answer && isAnswered(answer)
        ? [
            ...answer.choices
              .map((id) => d.options.find((o) => o.id === id))
              .filter((o) => o !== undefined)
              .map((o) => html`<span class="sp-choice">${mdInline(o.label)}</span>`),
            answer.other ? html`<span class="sp-choice sp-choice-other">${answer.other}</span>` : null,
          ]
        : html`<span class="sp-choice-none">Left to the agent</span>`;
    return html`<li class="sp-decision-row"${target(`decisions[${i}]`, "decision", `${d.id}: ${d.question}`, d.id)}><div class="sp-decision-q">${idChip(d.id)}<span>${mdInline(d.question)}</span></div><div class="sp-decision-a">${labels}</div></li>`;
  });
  return html`<p class="sp-muted sp-decisions-count">${answered} of ${decisions.length} answered by the reviewer. The plan states what the agent assumed for the rest.</p><ol class="sp-decision-list">${rows}</ol>`;
}

// --- open questions ---

export function renderQuestions(questions: Question[]): Html[] {
  return questions.map(
    (
      q,
      i,
    ) => html`<article class="sp-card sp-question"${target(`questions[${i}]`, "question", `${q.id}: ${q.question}`, q.id)} data-sp-question="${q.id}">
<header class="sp-card-head">${idChip(q.id)}<h2 class="sp-card-title">${mdInline(q.question)}</h2></header>
${q.context ? html`<div class="sp-md sp-muted">${md(q.context)}</div>` : null}
${optionList({ type: "radio", name: `sp-q-${q.id}`, question: q.question, options: q.options, other: q.allow_other ? (q.options.length ? "Something else" : "Your answer") : null })}
<div class="sp-answer" hidden><textarea class="sp-answer-note" name="answer-${q.id}" rows="2" placeholder="Add a note for the agent (optional)"></textarea><div class="sp-answer-actions"><span class="sp-answer-status" role="status"></span><button type="button" class="sp-button sp-button-quiet sp-answer-clear">Clear answer</button></div></div>
</article>`,
  );
}

/** A single- or multiple-choice option list, with an optional free-text choice labelled `other`. */
function optionList({
  type,
  name,
  question,
  options,
  other,
}: {
  type: "radio" | "checkbox";
  name: string;
  question: string;
  options: Option[];
  other: string | null;
}): Html {
  return html`<fieldset class="sp-options"><legend class="sp-visually-hidden">${question}</legend>${options.map(
    (o) =>
      html`<label class="sp-option"><input type="${type}" name="${name}" value="${o.id}" disabled>${optionBody(o)}</label>`,
  )}${
    other
      ? html`<label class="sp-option sp-option-other"><input type="${type}" name="${name}" value="" data-sp-other disabled><span class="sp-option-body"><span class="sp-option-label">${other}</span></span></label>`
      : null
  }</fieldset>`;
}

function optionBody(o: Option): Html {
  return html`<span class="sp-option-body"><span class="sp-option-label">${mdInline(o.label)}${o.recommended ? html`<span class="sp-rec">Recommended</span>` : null}</span>${o.detail ? html`<span class="sp-md sp-option-detail">${md(o.detail)}</span>` : null}</span>`;
}
