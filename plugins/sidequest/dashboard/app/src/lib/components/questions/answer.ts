import { ApiError } from '../../api';
import type { QuestionDetail } from '../../types';

// US-8 Q9b: the detail page's answer form. The server runs the `answer` board tool with
// via:"dashboard"; these helpers only shape what the form sends and how a refusal reads.

export type AnswerRequest = { text: string } | { decline: true };

/** Only an open question takes an answer; the first answer stands once recorded. */
export function canAnswer(question: Pick<QuestionDetail, 'state' | 'answer'> | null | undefined) {
  return !!question && question.state === 'open' && !question.answer;
}

/** Picked option labels, then any note on its own line. */
export function composeAnswer(picked: string[], note: string) {
  const choice = picked.map((label) => label.trim()).filter(Boolean).join(', ');
  const extra = note.trim();
  if (choice && extra) return `${choice}\n${extra}`;
  return choice || extra;
}

/** Toggle one option: a multi-select keeps the others, a single select replaces them. */
export function togglePick(picked: string[], label: string, multiSelect: boolean) {
  if (picked.includes(label)) return picked.filter((value) => value !== label);
  return multiSelect ? [...picked, label] : [label];
}

export function answerRequest(picked: string[], note: string): AnswerRequest | null {
  const text = composeAnswer(picked, note);
  return text ? { text } : null;
}

/** A 409 means someone answered first: the form closes and the page reloads the question. */
export function answerRefusal(caught: unknown) {
  if (caught instanceof ApiError) return { message: caught.message, answeredElsewhere: caught.status === 409 };
  return { message: caught instanceof Error ? caught.message : 'Could not record the answer.', answeredElsewhere: false };
}
