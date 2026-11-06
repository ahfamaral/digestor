export type ZipChoice = "burned" | "files" | "plain";
export const ZIP_CHOICES: readonly ZipChoice[] = ["burned", "files", "plain"];
export const isZipChoice = (v: unknown): v is ZipChoice => ZIP_CHOICES.includes(v as ZipChoice);

/** What a clip has stored, as far as the zip is concerned. */
export interface ZipClip {
  id: string;
  /** The moment title, in the spoken language (may be empty or non-Latin). */
  title: string;
  /** The plain MP4 is made (render done). */
  mp4: boolean;
  languages: { language: string; /** SRT/VTT can be rendered (current cues with text). */ text: boolean; /** A subtitle video is made. */ burned: boolean }[];
}

export type ZipEntryKind = "mp4" | "burned" | "srt" | "vtt";
export interface ZipEntry {
  name: string;
  kind: ZipEntryKind;
  clipId: string;
  language?: string;
}

const MAX_BASE = 80;

/** A file-name part that is plain ASCII: accents stripped, ß/æ/ø spelled out, separators and everything else removed. */
export function asciiName(title: string): string {
  const cleaned = title
    .replace(/ß/g, "ss").replace(/ẞ/g, "SS").replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/ø/g, "o").replace(/Ø/g, "O").replace(/ł/g, "l").replace(/Ł/g, "L")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._()-]/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASE)
    .replace(/^[. ]+|[. ]+$/g, "");
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "clip";
}

/** Languages go into names as typed by the app (`pt`, `zh-Hans`); keep only safe characters. */
const lang = (code: string) => code.replace(/[^A-Za-z0-9-]/g, "") || "und";

/**
 * The files each choice puts in the zip, in order, and (for `burned`) the clips that have no subtitle video yet.
 * Names are `01 <title>.mp4`, `01 <title>.pt.srt`, `01 <title>.pt.mp4` (a subtitle video), numbered by the clip's
 * position among all clips so they match "Clip n" on the page; unique case-insensitively.
 */
export function zipEntries(clips: ZipClip[], choice: ZipChoice): { entries: ZipEntry[]; skipped: { n: number; title: string }[] } {
  const entries: ZipEntry[] = [];
  const skipped: { n: number; title: string }[] = [];
  const used = new Set<string>();
  const add = (e: Omit<ZipEntry, "name">, base: string, ext: string) => {
    let name = `${base}.${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).${ext}`;
    used.add(name.toLowerCase());
    entries.push({ ...e, name });
  };
  clips.forEach((c, i) => {
    const n = i + 1;
    const base = `${String(n).padStart(2, "0")} ${asciiName(c.title)}`;
    if (choice === "burned") {
      const burned = c.languages.filter((l) => l.burned);
      if (burned.length === 0) skipped.push({ n, title: c.title });
      for (const l of burned) add({ kind: "burned", clipId: c.id, language: l.language }, `${base}.${lang(l.language)}`, "mp4");
      return;
    }
    if (c.mp4) add({ kind: "mp4", clipId: c.id }, base, "mp4");
    if (choice === "files")
      for (const l of c.languages.filter((x) => x.text))
        for (const kind of ["srt", "vtt"] as const) add({ kind, clipId: c.id, language: l.language }, `${base}.${lang(l.language)}`, kind);
  });
  return { entries, skipped };
}

/** The zip input of an Export row (the same shape the route builds from the database). */
export function zipClipOf(c: { id: string; title: string; row: { mp4: string | null; languages: { language: string; srt: string | null; burn: { url: string | null } }[] } }): ZipClip {
  return {
    id: c.id,
    title: c.title,
    mp4: c.row.mp4 !== null,
    languages: c.row.languages.map((l) => ({ language: l.language, text: l.srt !== null, burned: l.burn.url !== null })),
  };
}
