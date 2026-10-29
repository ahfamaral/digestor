import type { EventType } from "./schemas.js";

export interface EventTypeConfig {
  label: string;
  rubric: string;
  speakerLabel: "name_role" | "name_party" | "name_country" | "role_only" | "name";
  fewShot: string[];
}

export const EVENT_TYPES: Record<EventType, EventTypeConfig> = {
  interview: {
    label: "Interview",
    rubric: "Look for revealing or surprising answers, pushback between interviewer and guest, evasions, strong claims, and humour.",
    speakerLabel: "name_role",
    fewShot: [], // filled after Plan 2 labelling
  },
  panel: {
    label: "Panel / debate",
    rubric: "Look for disagreements between panellists, direct rebuttals, strong claims, and reactions from the crowd.",
    speakerLabel: "name_role",
    fewShot: [],
  },
  parliament: {
    label: "Parliament",
    rubric: "Look for clashes between government and opposition, votes, concrete figures, interruptions, calls to order, and laughter.",
    speakerLabel: "name_party",
    fewShot: [],
  },
  un: {
    label: "UN / diplomatic",
    rubric: "Look for accusations between delegations, rights of reply, votes, and announcements made by delegates.",
    speakerLabel: "name_country",
    fewShot: [],
  },
  court: {
    label: "Court / hearing",
    rubric: "Look for objections, rulings by the judge, key testimony from witnesses, and sharp cross-examination.",
    speakerLabel: "role_only",
    fewShot: [],
  },
  other: {
    label: "Other",
    rubric: "Look for disagreement between speakers, novel claims, emotional peaks, and humour.",
    speakerLabel: "name",
    fewShot: [],
  },
};
