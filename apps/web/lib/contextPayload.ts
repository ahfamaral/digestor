import type { ProfileId, ResumePayload } from "@digestor/core";

export interface ParticipantFields {
  speakerId: string;
  name: string;
  role: string;
  affiliation: string;
}

/** Editable card fields as plain strings (null facts become ""). */
export interface ContextFields {
  profile: ProfileId;
  /** BCP-47 code of the spoken language. */
  language: string;
  title: string;
  setting: string;
  dateOrYear: string;
  participants: ParticipantFields[];
}

type ContinuePayload = Extract<ResumePayload, { action: "continue" }>;
type SkipPayload = Extract<ResumePayload, { action: "skip" }>;

/** Build the "continue" resume payload: only changed, non-blank (trimmed) fields (blanking is ignored), and only non-empty answers. */
export function buildContextPayload(
  original: ContextFields,
  edited: ContextFields,
  answers: { questionId: string; answer: string }[],
): ContinuePayload {
  const cardEdits: ContinuePayload["cardEdits"] = {};
  if (edited.profile !== original.profile) cardEdits.profile = edited.profile;
  if (edited.language !== original.language) cardEdits.language = edited.language;
  for (const key of ["title", "setting", "dateOrYear"] as const) {
    const value = edited[key].trim();
    if (value !== "" && value !== original[key].trim()) cardEdits[key] = value;
  }
  const participants: NonNullable<ContinuePayload["cardEdits"]["participants"]> = [];
  for (const p of edited.participants) {
    const before = original.participants.find((o) => o.speakerId === p.speakerId);
    const diff: { speakerId: string; role?: string; affiliation?: string } = { speakerId: p.speakerId };
    let changed = false;
    // Names are not sent: Who's who writes them directly as attributions.
    for (const key of ["role", "affiliation"] as const) {
      const value = p[key].trim();
      if (value !== "" && value !== (before?.[key] ?? "").trim()) {
        diff[key] = value;
        changed = true;
      }
    }
    if (changed) participants.push(diff);
  }
  if (participants.length) cardEdits.participants = participants;

  return {
    action: "continue",
    answers: answers
      .map((a) => ({ questionId: a.questionId, answer: a.answer.trim() }))
      .filter((a) => a.answer !== ""),
    cardEdits,
  };
}

/** Build the "skip" resume payload: no answers, but the same card edits as Continue, so Skip never drops them. */
export function buildSkipPayload(original: ContextFields, edited: ContextFields): SkipPayload {
  const { cardEdits } = buildContextPayload(original, edited, []);
  return Object.keys(cardEdits).length > 0 ? { action: "skip", cardEdits } : { action: "skip" };
}
