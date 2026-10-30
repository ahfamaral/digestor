import { z } from "zod";

/** Single owner until accounts exist; every personal row carries owner_id. */
export const OWNER_ID = "owner";

export const ProfileIdSchema = z.enum(["parliament", "supreme_court", "electoral_debate", "trial", "interview", "un", "other"]);
export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const HighlightTypeIdSchema = z.enum([
  "heated",
  "key_point",
  "light",
  "strong_argument",
  "laughter",
  "longest_speech",
  "vote",
  "divergence",
  "review_request",
  "clash",
  "result",
  "attack_rebuttal",
  "promise",
  "dodge",
  "zinger",
  "claim_to_check",
  "key_testimony",
  "objection_ruling",
  "contradiction",
  "emotional",
  "news_line",
  "quotable",
  "strong_statement",
  "explanation_of_vote",
  "right_of_reply",
  "walkout",
]);
export type HighlightTypeId = z.infer<typeof HighlightTypeIdSchema>;

export type Tone = "red" | "blue" | "amber" | "violet" | "green" | "teal" | "slate" | "pink";

export interface HighlightTypeConfig {
  label: string;
  /** Heading of the Preview card for this type. */
  cardLabel: string;
  method: "ai" | "counted";
  definition: string;
  tone: Tone;
}

export const HIGHLIGHT_TYPES: Record<HighlightTypeId, HighlightTypeConfig> = {
  heated: {
    label: "Heated",
    cardLabel: "Most heated",
    method: "ai",
    definition: "Speakers clash openly: raised voices, interruptions, direct accusations or sharp rebuttals.",
    tone: "red",
  },
  key_point: {
    label: "Key point",
    cardLabel: "Key point",
    method: "ai",
    definition: "A concrete claim, figure, announcement or revealing answer.",
    tone: "blue",
  },
  light: {
    label: "Light moment",
    cardLabel: "Light moment",
    method: "ai",
    definition: "Humour, laughter, a warm or surprising human moment.",
    tone: "amber",
  },
  strong_argument: {
    label: "Strong argument",
    cardLabel: "Strong argument",
    method: "ai",
    definition: "A speaker makes a clear, well-supported case for or against an agenda item.",
    tone: "violet",
  },
  laughter: {
    label: "Laughter",
    cardLabel: "Laughter",
    method: "ai",
    definition: "The chamber reacts with laughter to something said.",
    tone: "amber",
  },
  longest_speech: {
    label: "Longest speech",
    cardLabel: "Longest speech",
    method: "counted",
    definition: "The longest uninterrupted speech by a single speaker, counted from the transcript.",
    tone: "slate",
  },
  vote: {
    label: "Vote",
    cardLabel: "Vote",
    method: "ai",
    definition: "A justice states how they vote on the case.",
    tone: "blue",
  },
  divergence: {
    label: "Divergence",
    cardLabel: "Divergence",
    method: "ai",
    definition: "A justice departs from the rapporteur or the majority and explains why.",
    tone: "violet",
  },
  review_request: {
    label: "Request for review",
    cardLabel: "Request for review",
    method: "ai",
    definition: "A justice asks for time to study the case (\"pedido de vista\") and the judgment is suspended.",
    tone: "amber",
  },
  clash: {
    label: "Clash between justices",
    cardLabel: "Clash between justices",
    method: "ai",
    definition: "Two justices argue directly with each other, beyond a difference of vote.",
    tone: "red",
  },
  result: {
    label: "Result",
    cardLabel: "Result",
    method: "ai",
    definition: "The outcome of the judgment is announced.",
    tone: "green",
  },
  attack_rebuttal: {
    label: "Attack & rebuttal",
    cardLabel: "Attack & rebuttal",
    method: "ai",
    definition: "One candidate attacks another and the other answers, in a single exchange.",
    tone: "red",
  },
  promise: {
    label: "Promise",
    cardLabel: "Promise",
    method: "ai",
    definition: "A candidate commits to a concrete action or policy.",
    tone: "green",
  },
  dodge: {
    label: "Dodged the question",
    cardLabel: "Dodged the question",
    method: "ai",
    definition: "The speaker is asked something direct and answers a different question or avoids it.",
    tone: "slate",
  },
  zinger: {
    label: "Punchline",
    cardLabel: "Punchline",
    method: "ai",
    definition: "A short, quotable line that lands with the audience.",
    tone: "amber",
  },
  claim_to_check: {
    label: "Claim to check",
    cardLabel: "Claim to check",
    method: "ai",
    definition: "A checkable factual claim (figure, date, record) that a reader may want to verify.",
    tone: "teal",
  },
  key_testimony: {
    label: "Key testimony",
    cardLabel: "Key testimony",
    method: "ai",
    definition: "A witness or party says something that matters to the case.",
    tone: "blue",
  },
  objection_ruling: {
    label: "Objection + ruling",
    cardLabel: "Objection + ruling",
    method: "ai",
    definition: "A lawyer objects and the judge rules on it.",
    tone: "violet",
  },
  contradiction: {
    label: "Contradiction",
    cardLabel: "Contradiction",
    method: "ai",
    definition: "A statement conflicts with an earlier statement or with the evidence put to the witness.",
    tone: "red",
  },
  emotional: {
    label: "Emotional moment",
    cardLabel: "Emotional moment",
    method: "ai",
    definition: "Visible or audible emotion: a break in the voice, anger, grief.",
    tone: "pink",
  },
  news_line: {
    label: "News line",
    cardLabel: "News line",
    method: "ai",
    definition: "A statement a newsroom would use as a headline.",
    tone: "teal",
  },
  quotable: {
    label: "Quotable",
    cardLabel: "Quotable",
    method: "ai",
    definition: "A self-contained sentence that works as a quote on its own.",
    tone: "violet",
  },
  strong_statement: {
    label: "Strong statement",
    cardLabel: "Strong statement",
    method: "ai",
    definition: "A delegation takes a firm, forceful position or accuses another delegation.",
    tone: "blue",
  },
  explanation_of_vote: {
    label: "Explanation of vote",
    cardLabel: "Explanation of vote",
    method: "ai",
    definition: "A delegation explains why it voted the way it did.",
    tone: "violet",
  },
  right_of_reply: {
    label: "Right of reply",
    cardLabel: "Right of reply",
    method: "ai",
    definition: "A delegation uses its right of reply to answer something said about it.",
    tone: "red",
  },
  walkout: {
    label: "Walkout or protest",
    cardLabel: "Walkout or protest",
    method: "ai",
    definition: "Delegates leave the room or protest during a statement.",
    tone: "amber",
  },
};

export interface ProfileConfig {
  label: string;
  /** What a "topic" is for this kind of video, e.g. "agenda items". */
  topicDefinition: string;
  rubric: string;
  highlightTypes: HighlightTypeId[];
  sensitive: boolean;
  fewShot: string[];
}

export const PROFILES: Record<ProfileId, ProfileConfig> = {
  parliament: {
    label: "Parliament",
    topicDefinition: "agenda items",
    rubric: "Look for clashes between government and opposition, votes, concrete figures, interruptions, calls to order, and laughter.",
    highlightTypes: ["heated", "strong_argument", "longest_speech", "laughter"],
    sensitive: false,
    fewShot: [],
  },
  supreme_court: {
    label: "Supreme court",
    topicDefinition: "cases on the agenda",
    rubric: "Look for each justice's vote, divergences from the rapporteur or majority, requests for review (\"pedido de vista\"), direct clashes between justices, and the announced result.",
    highlightTypes: ["vote", "divergence", "review_request", "clash", "result"],
    sensitive: false,
    fewShot: [],
  },
  electoral_debate: {
    label: "Electoral debate",
    topicDefinition: "the moderator's questions or themes",
    rubric: "Look for attacks and rebuttals between candidates, concrete promises, questions that were dodged, quotable punchlines, and factual claims worth checking.",
    highlightTypes: ["attack_rebuttal", "promise", "dodge", "zinger", "claim_to_check"],
    sensitive: false,
    fewShot: [],
  },
  trial: {
    label: "Trial / hearing",
    topicDefinition: "phases: opening, testimony, cross-examination, objections, ruling",
    rubric: "Look for objections, rulings by the judge, key testimony from witnesses, contradictions, sharp cross-examination, and emotional moments.",
    highlightTypes: ["key_testimony", "objection_ruling", "contradiction", "emotional"],
    sensitive: true,
    fewShot: [],
  },
  interview: {
    label: "Interview",
    topicDefinition: "the questions asked",
    rubric: "Look for revealing or surprising answers, pushback between interviewer and guest, evasions, strong claims, news lines, quotable sentences, and humour.",
    highlightTypes: ["news_line", "quotable", "dodge", "emotional", "heated", "key_point", "light"],
    sensitive: false,
    fewShot: [],
  },
  un: {
    label: "UN session",
    topicDefinition: "agenda items or country statements",
    rubric: "Look for accusations between delegations, rights of reply, explanations of vote, announcements made by delegates, and walkouts or protests.",
    highlightTypes: ["strong_statement", "explanation_of_vote", "right_of_reply", "walkout"],
    sensitive: false,
    fewShot: [],
  },
  other: {
    label: "Other",
    topicDefinition: "detected sections",
    rubric: "Look for disagreement between speakers, novel claims, emotional peaks, and humour.",
    highlightTypes: ["heated", "key_point", "light"],
    sensitive: false,
    fewShot: [],
  },
};

export const GranularitySchema = z.enum(["exchange", "passage", "punchline"]);
export type Granularity = z.infer<typeof GranularitySchema>;

export const GRANULARITY: Record<Granularity, { label: string; targetMs: [number, number]; acceptMs: [number, number] }> = {
  exchange: { label: "Exchange", targetMs: [120_000, 720_000], acceptMs: [60_000, 1_200_000] },
  passage: { label: "Passage", targetMs: [30_000, 120_000], acceptMs: [20_000, 150_000] },
  punchline: { label: "Punchline", targetMs: [8_000, 30_000], acceptMs: [6_000, 45_000] },
};

/** Languages offered for subtitles and briefing translation (BCP-47). The original language is always available. */
export const LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "pt", label: "Portuguese" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "ar", label: "Arabic" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
];
