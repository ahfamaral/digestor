import type { EventType, ResumePayload } from "@digestor/core";

export interface ParticipantFields {
  speakerId: string;
  name: string;
  role: string;
  affiliation: string;
}

/** Editable card fields as plain strings (null facts become ""). */
export interface ContextFields {
  eventType: EventType;
  title: string;
  setting: string;
  dateOrYear: string;
  participants: ParticipantFields[];
}

type ContinuePayload = Extract<ResumePayload, { action: "continue" }>;

/** Build the "continue" resume payload: only changed, non-blank (trimmed) fields (blanking is ignored), and only non-empty answers. */
export function buildContextPayload(
  original: ContextFields,
  edited: ContextFields,
  answers: { questionId: string; answer: string }[],
): ContinuePayload {
  const cardEdits: ContinuePayload["cardEdits"] = {};
  if (edited.eventType !== original.eventType) cardEdits.eventType = edited.eventType;
  for (const key of ["title", "setting", "dateOrYear"] as const) {
    const value = edited[key].trim();
    if (value !== "" && value !== original[key].trim()) cardEdits[key] = value;
  }
  const participants: NonNullable<ContinuePayload["cardEdits"]["participants"]> = [];
  for (const p of edited.participants) {
    const before = original.participants.find((o) => o.speakerId === p.speakerId);
    const diff: { speakerId: string; name?: string; role?: string; affiliation?: string } = { speakerId: p.speakerId };
    let changed = false;
    for (const key of ["name", "role", "affiliation"] as const) {
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
