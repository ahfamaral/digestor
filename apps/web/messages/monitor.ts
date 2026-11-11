/**
 * Copy of the Câmara monitor (its own catalogue: Digestor's `t()` and `messages/en.ts` stay English-only). Official
 * data (speech text, summaries, ementas, vote labels) is never translated: it is shown as published.
 */
type Messages<T> = { [K in keyof T]: T[K] extends string ? string : Messages<T[K]> };

export const monitorEn = {
  title: "Câmara monitor",
  dataNote: "Official records of the Câmara dos Deputados since 1 February 2026, updated nightly.",
  search: {
    label: "Search the monitor",
    placeholder: "Search a deputy or a topic",
    button: "Search",
    deputyLabel: "Search this deputy's speeches",
    deputyPlaceholder: "Search this deputy's speeches",
    clear: "Clear search",
    searchedFor: "Searched for: {terms}",
    fromQuery: "(from “{q}”)",
    translationFailed: "Couldn't translate the search; searched for your words as typed.",
    searching: "Searching…",
  },
  sections: {
    deputies: "Deputies",
    speeches: "Speeches",
    rollCalls: "Roll calls",
    votes: "Votes",
  },
  empty: {
    deputies: "No deputies match.",
    speeches: "No speeches match.",
    rollCalls: "No roll calls match.",
    memberSpeeches: "No speeches in 2026.",
    memberVotes: "No recorded votes in 2026.",
  },
  member: {
    notInOffice: "Not in office now",
    officialRecord: "Official record",
    back: "Câmara monitor",
  },
  speech: {
    showFullText: "Show full text",
    noText: "Full text not published yet",
  },
  rollCall: {
    totals: "Yes {yes} · No {no} · Other {other}",
    noBill: "No bill named",
  },
  votes: {
    note: "Roll calls without a recorded vote are not listed.",
  },
  paging: {
    range: "{from}–{to} of {total}",
    newer: "Newer",
    older: "Older",
    label: "More results",
  },
  lang: {
    label: "Language",
    en: "English",
    pt: "Português",
  },
};

export type MonitorMessages = Messages<typeof monitorEn>;

/** Portuguese (Brazil). Strings marked in the plan are fixed; the owner reviews the rest. */
export const monitorPtBR: MonitorMessages = {
  title: "Monitor da Câmara",
  dataNote: "Registros oficiais da Câmara dos Deputados desde 1º de fevereiro de 2026, atualizados diariamente.",
  search: {
    label: "Buscar no monitor",
    placeholder: "Busque um deputado ou um tema",
    button: "Buscar",
    deputyLabel: "Buscar nos discursos deste deputado",
    deputyPlaceholder: "Buscar nos discursos deste deputado",
    clear: "Limpar busca",
    searchedFor: "Buscado: {terms}",
    fromQuery: "(de “{q}”)",
    translationFailed: "Não foi possível traduzir a busca; buscamos as palavras como foram digitadas.",
    searching: "Buscando…",
  },
  sections: {
    deputies: "Deputados",
    speeches: "Discursos",
    rollCalls: "Votações nominais",
    votes: "Votos",
  },
  empty: {
    deputies: "Nenhum deputado encontrado.",
    speeches: "Nenhum discurso encontrado.",
    rollCalls: "Nenhuma votação nominal encontrada.",
    memberSpeeches: "Nenhum discurso em 2026.",
    memberVotes: "Nenhum voto registrado em 2026.",
  },
  member: {
    notInOffice: "Fora do exercício",
    officialRecord: "Registro oficial",
    back: "Monitor da Câmara",
  },
  speech: {
    showFullText: "Ver texto integral",
    noText: "Texto integral ainda não publicado",
  },
  rollCall: {
    totals: "Sim {yes} · Não {no} · Outros {other}",
    noBill: "Sem proposição indicada",
  },
  votes: {
    note: "Votações sem voto registrado não aparecem.",
  },
  paging: {
    range: "{from}–{to} de {total}",
    newer: "Mais recentes",
    older: "Mais antigos",
    label: "Mais resultados",
  },
  lang: {
    label: "Idioma",
    en: "English",
    pt: "Português",
  },
};

type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MonitorKey = Paths<MonitorMessages>;
