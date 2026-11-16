import { normName } from "@digestor/core";
import type { DirectoryParams } from "./params";

/** A deputy as the directory lists them (the fields of `MemberRow` it shows). */
export type DirectoryMember = {
  externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null; inOffice: boolean;
};

/** The deputies the directory can show: those in office, or everyone with `former`. */
const pool = <M extends DirectoryMember>(members: M[], former: boolean) => (former ? members : members.filter((m) => m.inOffice));

/** The pool narrowed by today's party and state; the input order (alphabetical) is kept. */
export function filterDirectory<M extends DirectoryMember>(members: M[], p: DirectoryParams): M[] {
  return pool(members, p.former).filter((m) => (!p.party || m.party === p.party) && (!p.uf || m.uf === p.uf));
}

/**
 * The party and state options: the values found in the pool, sorted, plus the chosen one when the pool lacks it (a
 * party only former deputies had, then "former" unticked), so the select still shows what the address asks for.
 */
export function directoryOptions(members: DirectoryMember[], p: DirectoryParams): { parties: string[]; ufs: string[] } {
  const shown = pool(members, p.former);
  const values = (pick: (m: DirectoryMember) => string | null, chosen: string | null) => {
    const set = new Set(shown.map(pick).filter((v): v is string => !!v));
    if (chosen) set.add(chosen);
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  };
  return { parties: values((m) => m.party, p.party), ufs: values((m) => m.uf, p.uf) };
}

/** The first letter of a name, accents ignored ("Átila" is under A); anything else under "#". */
export function letterOf(name: string): string {
  const c = normName(name).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : "#";
}

/** Grouped by first letter, in the order the letters first appear (the rows come sorted by name, accents and case ignored). */
export function byLetter<M extends DirectoryMember>(members: M[]): { letter: string; members: M[] }[] {
  const groups = new Map<string, M[]>();
  for (const m of members) {
    const letter = letterOf(m.name);
    groups.set(letter, [...(groups.get(letter) ?? []), m]);
  }
  return [...groups].map(([letter, members]) => ({ letter, members }));
}

/** Name particles that never give an initial ("Adriano do Baldy" is "AB"). */
const PARTICLES = new Set(["da", "das", "de", "do", "dos", "e"]);

/** Up to two initials for an avatar placeholder: the first and last words that aren't particles ("Acácio Favacho" is "AF"). */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /\p{L}/u.test(w) && !PARTICLES.has(w.toLowerCase()));
  if (words.length === 0) return "";
  const letter = (w: string) => (w.match(/\p{L}/u)?.[0] ?? "").toLocaleUpperCase("pt-BR");
  return words.length === 1 ? letter(words[0]!) : `${letter(words[0]!)}${letter(words.at(-1)!)}`;
}
