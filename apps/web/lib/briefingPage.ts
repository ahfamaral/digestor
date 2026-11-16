import {
  HIGHLIGHT_TYPES, OWNER_ID, PROFILES, personAt, sessionSpending, speakersIn, type BriefingContent, type Spending, type ContextCard, type HighlightTypeId,
  type MomentWithHighlights, type ProfileId, type SelectionStatus, type Topic,
} from "@digestor/core";
import {
  countSelectionsByAnalysis, getContextCard, getCurrentAnalysis, getRunningAnalysis, getTranscript, listAnalysisVersions,
  listPersonalMoments, listSelections, type Db, type Session,
} from "@digestor/core/server";
import type { FocusChoice } from "@/components/Briefing/Controls";
import { earlierSelections, focusOptions, momentExcerpt, peopleByMoment } from "./briefingData";
import { loadNames, namesChangedSince } from "./namesServer";
import { labelText, namedCount, rangeVoices, voiceLabel, whosWhoRows, type NamesData, type Voice, type WhosWhoRow } from "./names";
import { asProfile, latestFailedAfter, versionNote } from "./preview";
import { displayTitle } from "./sessionTitle";

/** What the Briefing page (`components/Briefing/Briefing.tsx`) is rendered with; the client imports it as a type only. */
export interface BriefingProps {
  session: { id: string; title: string; durationMs: number; language: string | null; hasVideo: boolean; videoRemoved: boolean };
  analysis: {
    id: string;
    version: number;
    profile: ProfileId;
    /** Why this version is a re-run (the "Analysis v<n>" tooltip), or null. */
    note: string | null;
    running: boolean;
    /** Number of a newer version that failed (its results never replaced these), or null. */
    failedVersion: number | null;
  };
  speakers: number;
  /** How many of the speakers have a name to show. */
  named: number;
  names: NamesData;
  /** A name changed after this analysis was written. */
  namesChanged: boolean;
  /** Who's who rows (voice and name, longest first). */
  whoRows: WhosWhoRow[];
  /** Who to show per moment id (longest speaking first). */
  voices: Record<string, Voice[]>;
  topics: Topic[];
  /** Official moments of the current analysis plus the owner's personal ones. */
  moments: MomentWithHighlights[];
  briefing: BriefingContent | null;
  card: ContextCard | null;
  /** Transcript text per moment id. */
  excerpts: Record<string, string>;
  /** The owner's selections on these moments (no entry = undecided). */
  selections: Record<string, SelectionStatus>;
  choices: FocusChoice[];
  /** Person ids speaking at least 3 s in each moment (Focus by person). */
  people: Record<string, string[]>;
  types: HighlightTypeId[];
  /** Selections left on an earlier analysis version, or null. */
  earlier: { count: number; version: number } | null;
  /** What this session has cost: estimates, and the LLM dollars its analysis versions recorded (the "Spending" line). */
  spending: Spending;
}

/**
 * Everything the Briefing page shows for a `ready` session: the current analysis (topics, official and personal moments,
 * briefing), its version history and any running re-analysis, the owner's selections on it, names, transcript
 * excerpts and the Focus choices. Null when the session has no complete analysis.
 */
export async function loadBriefingPage(db: Db, session: Session): Promise<BriefingProps | null> {
  const id = session.id;
  const bundle = await getCurrentAnalysis(db, id);
  if (!bundle) return null;
  const analysisId = bundle.version.id;
  const [versions, running, context, names, transcript, personal, selections, byVersion, namesChanged] = await Promise.all([
    listAnalysisVersions(db, id),
    getRunningAnalysis(db, id),
    getContextCard(db, id),
    loadNames(db, id),
    getTranscript(db, id),
    listPersonalMoments(db, OWNER_ID, analysisId),
    listSelections(db, OWNER_ID, id),
    countSelectionsByAnalysis(db, OWNER_ID, id),
    namesChangedSince(db, id, bundle.version.namesAt),
  ]);
  const { topics, briefing } = bundle;
  const words = transcript?.words ?? [];
  const profile = asProfile(bundle.version.profile);
  const sensitive = PROFILES[profile].sensitive;

  // Personal moments are stored without speakers; take them from the transcript so Focus finds them too.
  const moments = [
    ...bundle.moments,
    ...personal.map((m) => (m.speakers.length > 0 ? m : { ...m, speakers: speakersIn(words, m) })),
  ];
  const ids = new Set(moments.map((m) => m.id));
  const current: Record<string, SelectionStatus> = Object.fromEntries(Object.entries(selections).filter(([momentId]) => ids.has(momentId)));

  const durationMs = session.durationMs ?? topics.at(-1)?.endMs ?? 0;
  const speakerIds = [...new Set(words.length > 0 ? words.map((w) => w.speaker) : bundle.moments.flatMap((m) => m.speakers))].sort();
  const voices = Object.fromEntries(moments.map((m) => [m.id, rangeVoices(names, words, m, sensitive, m.speakers)]));

  // Focus: people by share, then the voices with no name to show. A label is resolved where its person (or voice) first
  // speaks as that option (in a sensitive profile, a person only where the name is confirmed), in one pass over the words.
  const firstLabel = new Map<string, ReturnType<typeof voiceLabel>>();
  for (const w of words) {
    const res = personAt(names.attributions, w.speaker, w.startMs);
    const person = res.kind === "named" && (res.confirmed || !sensitive) ? [`p:${res.personId}`] : [];
    for (const key of [`v:${w.speaker}`, ...person]) {
      if (!firstLabel.has(key)) firstLabel.set(key, voiceLabel(names, w.speaker, w.startMs, sensitive));
    }
  }
  const choices = focusOptions(names, words, sensitive).map((o) => {
    const label = firstLabel.get(o.kind === "person" ? `p:${o.personId}` : `v:${o.speakerId}`);
    return o.kind === "person"
      ? { kind: "person" as const, id: o.personId, share: o.share, name: label ? labelText(label) : (names.persons.find((p) => p.id === o.personId)?.displayName ?? "") }
      : { kind: "voice" as const, id: o.speakerId, share: o.share, name: label ? labelText(label) : `Speaker ${o.speakerId}` };
  });
  const present = new Set(moments.flatMap((m) => m.highlights.map((h) => h.type)));
  const types = [...new Set([...PROFILES[profile].highlightTypes, ...present])].filter((x): x is HighlightTypeId => x in HIGHLIGHT_TYPES);

  return {
    session: {
      id,
      // A file name ("globo-debate-lula-flavio") gives way to the context check's title.
      title: displayTitle(session.title, context?.card.title.value),
      durationMs,
      language: session.language,
      hasVideo: session.hasVideo,
      videoRemoved: session.videoDeletedAt !== null,
    },
    analysis: {
      id: analysisId,
      version: bundle.version.version,
      profile,
      note: versionNote(versions, analysisId),
      running: running !== null,
      failedVersion: latestFailedAfter(versions, analysisId),
    },
    speakers: speakerIds.length || context?.card.participants.length || 0,
    named: namedCount(names, speakerIds, sensitive),
    names,
    namesChanged,
    whoRows: whosWhoRows(names, words),
    voices,
    topics,
    moments,
    briefing,
    card: context?.card ?? null,
    excerpts: Object.fromEntries(moments.map((m) => [m.id, momentExcerpt(words, m)])),
    selections: current,
    choices,
    people: Object.fromEntries([...peopleByMoment(moments, names, words, sensitive)].map(([mid, set]) => [mid, [...set]])),
    types,
    earlier: earlierSelections(byVersion, analysisId),
    spending: sessionSpending({ durationMs, hasVideo: session.hasVideo, transcribed: transcript !== null, analyses: versions }),
  };
}
