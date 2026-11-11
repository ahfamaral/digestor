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
  landing: {
    findDeputy: "Find a deputy",
    findDeputyHint: "Their speeches, votes, bills and record in one place.",
    topic: "Search a topic across the Câmara",
    topicLabel: "Topic",
    topicPlaceholder: "A topic, e.g. feminicídio",
  },
  combobox: {
    label: "Deputy's name",
    placeholder: "Type a deputy's name",
    suggestions: "Suggestions",
    countOne: "1 deputy",
    count: "{n} deputies",
    searching: "Searching…",
    none: "No deputy matches",
    error: "Couldn't load the suggestions.",
    retry: "Try again",
    more: "{n} shown, keep typing",
    partyUf: "{party} · {uf}",
  },
  filters: {
    legend: "Filters",
    show: "Show",
    speeches: "Speeches",
    rollCalls: "Roll calls",
    from: "From",
    to: "To",
    party: "Party (on the day)",
    uf: "State (on the day)",
    phase: "Session phase",
    any: "Any",
    inOffice: "Only deputies in office",
    clear: "Clear filters",
  },
  sort: {
    label: "Sort",
    best: "Best match",
    new: "Newest first",
  },
  year: {
    label: "Year",
    only: "Only 2026 for now",
  },
  timeline: {
    title: "Party and office",
    since: "since {date}",
    range: "{from} – {to}",
    outOfOffice: "Out of office",
  },
  positions: {
    title: "Positions",
    now: "now",
    membersOne: "Member of 1 committee",
    members: "Member of {n} committees",
  },
  deputySearch: {
    by: "Speeches by",
    mentions: "Mentioning",
    rel: "Which speeches",
    placeholder: "A topic (optional when mentioning)",
    mentionsOf: "Speeches by other deputies that mention {name}.",
  },
  bills: {
    title: "Bills and requests",
    all: "All",
    coAuthor: "co-author",
    empty: "No bills or requests filed in {year}.",
    types: "Filter by type",
  },
  presence: {
    title: "Presence",
    sentence: "Present at {present} of {sessions} plenary deliberative sessions while in office ({year})",
    noneRecorded: "No presence recorded ({n})",
    note: "The open data doesn't say why: justified absences, leave and missions look the same.",
    unavailable: "Presence not available for this deputy.",
  },
  fronts: {
    title: "Parliamentary fronts",
    members: "Member of {n} parliamentary fronts",
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
    now: "now {party}",
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
    previous: "Previous",
    next: "Next",
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
  landing: {
    findDeputy: "Encontre um deputado",
    findDeputyHint: "Discursos, votos, proposições e histórico em um só lugar.",
    topic: "Busque um tema em toda a Câmara",
    topicLabel: "Tema",
    topicPlaceholder: "Um tema, por exemplo feminicídio",
  },
  combobox: {
    label: "Nome do deputado",
    placeholder: "Digite o nome de um deputado",
    suggestions: "Sugestões",
    countOne: "1 deputado",
    count: "{n} deputados",
    searching: "Buscando…",
    none: "Nenhum deputado encontrado",
    error: "Não foi possível carregar as sugestões.",
    retry: "Tentar de novo",
    more: "{n} exibidos, continue digitando",
    partyUf: "{party} · {uf}",
  },
  filters: {
    legend: "Filtros",
    show: "Mostrar",
    speeches: "Discursos",
    rollCalls: "Votações nominais",
    from: "De",
    to: "Até",
    party: "Partido (na data)",
    uf: "Estado (na data)",
    phase: "Fase da sessão",
    any: "Qualquer",
    inOffice: "Só deputados em exercício",
    clear: "Limpar filtros",
  },
  sort: {
    label: "Ordenar",
    best: "Mais relevantes",
    new: "Mais recentes primeiro",
  },
  year: {
    label: "Ano",
    only: "Só 2026 por enquanto",
  },
  timeline: {
    title: "Partido e exercício",
    since: "desde {date}",
    range: "{from} – {to}",
    outOfOffice: "Fora do exercício",
  },
  positions: {
    title: "Cargos",
    now: "atual",
    membersOne: "Membro de 1 comissão",
    members: "Membro de {n} comissões",
  },
  deputySearch: {
    by: "Discursos de",
    mentions: "Que mencionam",
    rel: "Quais discursos",
    placeholder: "Um tema (opcional ao buscar menções)",
    mentionsOf: "Discursos de outros deputados que mencionam {name}.",
  },
  bills: {
    title: "Proposições e requerimentos",
    all: "Todos",
    coAuthor: "coautoria",
    empty: "Nenhuma proposição ou requerimento apresentado em {year}.",
    types: "Filtrar por tipo",
  },
  presence: {
    title: "Presença",
    sentence: "Presente em {present} de {sessions} sessões deliberativas do Plenário durante o exercício ({year})",
    noneRecorded: "Sem presença registrada ({n})",
    note: "Os dados abertos não dizem o motivo: faltas justificadas, licenças e missões aparecem da mesma forma.",
    unavailable: "Presença indisponível para este deputado.",
  },
  fronts: {
    title: "Frentes parlamentares",
    members: "Membro de {n} frentes parlamentares",
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
    now: "agora {party}",
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
    previous: "Anterior",
    next: "Próxima",
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
